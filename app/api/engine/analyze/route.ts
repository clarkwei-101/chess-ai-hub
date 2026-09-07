// SSE 流式分析 — 周期性推送 analysis
import { NextRequest } from 'next/server';
import { engineManager } from '@/lib/engine/EngineManager';
import { Analysis, GameVariant } from '@/lib/types';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

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
          controller.enqueue(encoder.encode(`data: ${JSON.stringify({ ok: true, analysis })}\n\n`));
        } catch {
          // controller already closed
        }
      };
      const sendErr = (msg: string) => {
        if (streamClosed) return;
        try {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify({ ok: false, error: msg })}\n\n`));
        } catch {}
      };
      // Send an initial comment chunk to flush headers immediately so the client
      // gets SSE response headers + first chunk within milliseconds (otherwise
      // Next.js prod buffers until the first non-empty enqueue).
      try {
        controller.enqueue(encoder.encode(`: connected ${variant}\n\n`));
      } catch {}

      // No explicit mutex needed — the stale check in analyze() ensures that if a previous
      // search is running (pendingCommand set), we send 'stop' and wait for bestmove before
      // sending our new 'go infinite'. This serializes concurrent SSE requests naturally.

      // Now run analyze. wrap in try/finally to guarantee release() is called.
      try {
        const it = engineManager.analyze(variant, { depth, multipv });
        const firstTs = Date.now();
        let gotFirst = false;
        while (Date.now() - firstTs < 60000 && !gotFirst && !streamClosed) {
          const next = await Promise.race([
            it.next(),
            new Promise<{ value: undefined; done: true }>((r) => setTimeout(() => r({ value: undefined, done: true }), 60000)),
          ]);
          if (next.done || !next.value) break;
          send(next.value);
          gotFirst = true;
        }
        if (gotFirst) {
          const loopTs = Date.now();
          while (Date.now() - loopTs < 600_000 && !streamClosed) {
            const next = await Promise.race([
              it.next(),
              new Promise<{ value: undefined; done: true }>((r) => setTimeout(() => r({ value: undefined, done: true }), 30000)),
            ]);
            if (next.done || !next.value) break;
            send(next.value);
          }
        }
        await engineManager.stopAnalyze(variant);
      } catch (err: any) {
        sendErr(err.message);
      } finally {
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