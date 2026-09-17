// SSE 流式分析 — 周期性推送 analysis
import { NextRequest } from 'next/server';
import { engineManager } from '@/lib/engine/EngineManager';
import { Analysis, GameVariant } from '@/lib/types';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// SSE stream auto-close timeout (ms). For Go (KataGo), kata-analyze runs until maxVisits=5000
// (~3-30s on M3 Ultra depending on position complexity; mid-game = 60s+ possible).
// For chess/xiangqi (UCI), Stockfish runs "go infinite" until we send "stop".
// We cap at 300s to match the generator's max runtime.
const STREAM_TIMEOUT_MS = 300_000;
const HEARTBEAT_INTERVAL_MS = 20_000;
// P0-9 fix: KataGo emits info lines every ~0.1s during the first 1-2s (cold NN cache), then
// the interval stretches to 1-3s as visits accumulate. After 5000 visits the analysis
// auto-completes. CHUNK_INTERVAL_MS must be ≥ 120s so we don't give up between emits.
// Old value 5_000 caused each SSE connection to drop after the first info line, leaving
// the client permanently out-of-sync with KataGo's deeper snapshots. The route will
// now stay open until KataGo finishes (or streamTimeout fires at 300s).
const CHUNK_INTERVAL_MS = 120_000;

export async function GET(req: NextRequest) {
  const variant = req.nextUrl.searchParams.get('variant') as GameVariant;
  if (!['chess', 'xiangqi', 'go'].includes(variant)) {
    return new Response('Invalid variant', { status: 400 });
  }
  const depth = parseInt(req.nextUrl.searchParams.get('depth') || '18', 10);
  const multipv = parseInt(req.nextUrl.searchParams.get('multipv') || '3', 10);

  const encoder = new TextEncoder();
  let streamClosed = false;

  const stream = new ReadableStream({
    async start(controller) {
      const send = (analysis: Analysis) => {
        if (streamClosed) return;
        try {
          const encoded = encoder.encode(`data: ${JSON.stringify({ ok: true, analysis })}\n\n`);
          controller.enqueue(encoded);
          if (process.env.CHESS_DEBUG) console.log(`[analyze route] SENT analysis chunk (${encoded.byteLength} bytes)`);
        } catch (e: unknown) {
          const msg = e instanceof Error ? e.message : String(e);
          if (process.env.CHESS_DEBUG) console.log(`[analyze route] send FAIL: ${msg}`);
          // controller already closed
        }
      };
      const sendErr = (msg: string) => {
        if (streamClosed) return;
        try {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify({ ok: false, error: msg })}\n\n`));
        } catch {}
      };
      const sendPing = () => {
        if (streamClosed) return;
        try {
          controller.enqueue(encoder.encode(`: ping\n\n`));
        } catch {}
      };

      // Send an initial comment chunk to flush headers immediately so the client
      // gets SSE response headers + first chunk within milliseconds (otherwise
      // Next.js prod buffers until the first non-empty enqueue).
      try {
        controller.enqueue(encoder.encode(`: connected ${variant}\n\n`));
      } catch {}

      // Heartbeat timer to prevent proxy/WebSocket timeouts
      const heartbeatTimer = setInterval(() => {
        if (streamClosed) { clearInterval(heartbeatTimer); return; }
        sendPing();
      }, HEARTBEAT_INTERVAL_MS);

      // Auto-close timer: prevent indefinite streams
      const autoCloseTimer = setTimeout(() => {
        if (process.env.CHESS_DEBUG) console.log(`[analyze] auto-closing stream after ${STREAM_TIMEOUT_MS}ms`);
        streamClosed = true;
        clearInterval(heartbeatTimer);
        try { controller.close(); } catch {}
        engineManager.stopAnalyze(variant).catch(() => {});
      }, STREAM_TIMEOUT_MS);

      // Now run analyze. wrap in try/finally to guarantee release() is called.
      try {
        const it = engineManager.analyze(variant, { depth, multipv });

        // Send analysis chunks as they arrive, with a periodic yield timer.
        // Key fixes vs. prior version:
        // 1. No artificial FIRST_CHUNK_TIMEOUT_MS — the generator yields when KataGo
        //    emits its first info line (typically <5s for 5000 visits on M3 Ultra).
        // 2. Continue streaming for CHUNK_INTERVAL_MS per chunk so the client always
        //    sees the latest KataGo snapshot as it deepens (KataGo runs for ~3-8s total,
        //    emitting at 10ms intervals = 300-800 info lines; we send a snapshot every 5s).
        // 3. The autoCloseTimer (300s) is the hard upper bound — matches generator timeout.
        let lastSendTs = 0;
        while (!streamClosed) {
          // Wait for next chunk from the generator with a 60s timeout per iteration.
          // IfKataGo is still searching, it.next() resolves when onInfo fires.
          // IfKataGo has finished (UCI bestmove), the generator loop exits and it.next()
          // resolves with done=true → we break.
          const deadline = Date.now() + CHUNK_INTERVAL_MS;
          let next: IteratorResult<Analysis, void> | null = null;

          // Use Promise.race to implement per-iteration timeout
          const iterResult = await Promise.race([
            it.next(),
            new Promise<{ done: true; value: undefined }>((r) =>
              setTimeout(() => r({ done: true, value: undefined }), CHUNK_INTERVAL_MS)
            ),
          ]);

          if (streamClosed) break;

          // If the iterator is exhausted (KataGo finished + emitted bestmove), exit cleanly.
          if (iterResult.done || !iterResult.value) {
            if (process.env.CHESS_DEBUG) {
              console.log(`[analyze route] iterator done=${iterResult.done} value=${!!iterResult.value}`);
            }
            break;
          }

          send(iterResult.value);
          lastSendTs = Date.now();
        }
        // P1-7 fix: After Go kata-analyze completes, request ownership separately.
        // kata-analyze does not output ownership via GTP; it requires a dedicated kata-ownership call.
        // Send ownership as a named SSE event so GoBoard can update the heatmap without
        // re-rendering the entire board (avoids flicker and state conflict).
        if (variant === 'go' && !streamClosed) {
          const ownership = await engineManager.requestOwnership(variant).catch(() => null);
          if (ownership && !streamClosed) {
            try {
              controller.enqueue(encoder.encode(
                `event: ownership\ndata: ${JSON.stringify({ ownership })}\n\n`
              ));
            } catch {}
          }
        }
      } catch (err: any) {
        if (!streamClosed) sendErr(err.message);
      } finally {
        clearTimeout(autoCloseTimer);
        clearInterval(heartbeatTimer);
        streamClosed = true;
        try { controller.close(); } catch {}
      }
    },
    async cancel() {
      streamClosed = true;
      try { await engineManager.stopAnalyze(variant); } catch {}
    },
  });

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      // Disable response compression — Next.js prod buffers compressed SSE
      // responses, defeating the whole point of streaming. Identity encoding
      // ensures each enqueue is flushed immediately to the client.
      'Content-Encoding': 'identity',
      // X-Accel-Buffering: no — disables nginx/vercel proxy buffering
      'X-Accel-Buffering': 'no',
    },
  });
}