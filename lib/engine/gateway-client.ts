// HTTP client for the remote engine-gateway service.
// Mirrors the surface of EngineSession's command stream (sendLine + emitter
// events) but routes everything through fetch + ReadableStream instead of
// spawn + stdio. Used when ENGINE_GATEWAY_URL env var is set (e.g. on Vercel).

import { EventEmitter } from 'node:events';
import type { GameVariant } from '@/lib/types';

export interface GatewayAnalyzeOpts {
  fen?: string;
  moves?: string[];
  color?: 'B' | 'W';
  boardSize?: number;
  depth?: number;
  multipv?: number;
  /** Hard timeout (ms). Default 30s. */
  timeoutMs?: number;
}

export interface GatewayMoveOpts {
  fen?: string;
  moves?: string[];
  color?: 'B' | 'W';
  boardSize?: number;
  depth?: number;
  /** UCI engine — also include in /chess/move (Stockfish). Default 18. */
  uciDepth?: number;
}

export interface GatewayEvents {
  /** Raw stdout line from the engine (UCI/GTP). */
  line: (line: string) => void;
  /** Engine error / spawn failure. */
  error: (err: Error) => void;
  /** Analyze finished cleanly. */
  end: (reason: string) => void;
}

export declare interface GatewaySession {
  on<U extends keyof GatewayEvents>(event: U, listener: GatewayEvents[U]): this;
  emit<U extends keyof GatewayEvents>(event: U, ...args: Parameters<GatewayEvents[U]>): boolean;
}

/** Thin HTTP client wrapping a single analyze or move call to the gateway. */
export class GatewayClient {
  constructor(public readonly baseUrl: string) {}

  /** Analyze via SSE. Returns an EventEmitter + an `abort()` method. */
  analyzeStream(variant: GameVariant, opts: GatewayAnalyzeOpts): {
    emitter: EventEmitter;
    abort: () => void;
  } {
    const emitter = new EventEmitter();
    const ctrl = new AbortController();
    const path = variantPath(variant);
    const body = buildAnalyzeBody(variant, opts);

    (async () => {
      try {
        const res = await fetch(`${this.baseUrl}${path}/analyze`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
          signal: ctrl.signal,
        });
        if (!res.ok || !res.body) {
          const text = await res.text().catch(() => '');
          throw new Error(`gateway ${res.status}: ${text || res.statusText}`);
        }
        await readSseStream(res.body, emitter);
        emitter.emit('end', 'sse-complete');
      } catch (e: any) {
        if (e.name === 'AbortError') {
          emitter.emit('end', 'aborted');
        } else {
          emitter.emit('error', e);
          emitter.emit('end', `error:${e.message}`);
        }
      }
    })();

    return {
      emitter,
      abort: () => ctrl.abort(),
    };
  }

  /** Single best move via JSON. */
  async bestMove(variant: GameVariant, opts: GatewayMoveOpts): Promise<string | null> {
    const path = variantPath(variant);
    const body = buildMoveBody(variant, opts);
    const res = await fetch(`${this.baseUrl}${path}/move`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(30_000),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`gateway ${res.status}: ${text || res.statusText}`);
    }
    const data = await res.json();
    return data?.bestmove ?? data?.move ?? null;
  }
}

// ── Helpers ────────────────────────────────────────────────────────────

function variantPath(variant: GameVariant): string {
  return variant === 'go' ? '/go' : variant === 'xiangqi' ? '/xiangqi' : '/chess';
}

function buildAnalyzeBody(variant: GameVariant, opts: GatewayAnalyzeOpts): unknown {
  if (variant === 'go') {
    return {
      moves: opts.moves ?? [],
      color: opts.color ?? 'B',
      boardSize: opts.boardSize ?? 19,
      timeoutMs: opts.timeoutMs ?? 30_000,
    };
  }
  return {
    fen: opts.fen,
    moves: opts.moves,
    depth: opts.depth ?? (variant === 'chess' ? 22 : 14),
    multipv: opts.multipv ?? 3,
    timeoutMs: opts.timeoutMs ?? 30_000,
  };
}

function buildMoveBody(variant: GameVariant, opts: GatewayMoveOpts): unknown {
  if (variant === 'go') {
    return {
      moves: opts.moves ?? [],
      color: opts.color ?? 'B',
      boardSize: opts.boardSize ?? 19,
    };
  }
  return {
    fen: opts.fen,
    moves: opts.moves,
    depth: opts.depth ?? opts.uciDepth ?? (variant === 'chess' ? 18 : 12),
  };
}

async function readSseStream(body: ReadableStream<Uint8Array>, emitter: EventEmitter): Promise<void> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    let idx: number;
    while ((idx = buf.indexOf('\n\n')) >= 0) {
      const event = buf.slice(0, idx);
      buf = buf.slice(idx + 2);
      const line = parseSseEvent(event);
      if (line) {
        // Two event shapes: raw line (`data: {"line": "info ..."}`) and
        // structured (`data: {"event": "queued"}`). Emit both as 'line' so
        // handleLine() can route them.
        emitter.emit('line', line);
      }
    }
  }
}

function parseSseEvent(raw: string): string | null {
  // SSE event: optional `event: <name>` line, then `data: <payload>` line.
  // We forward the data payload as a single 'line' string to mimic engine stdout.
  let eventName: string | null = null;
  const dataLines: string[] = [];
  for (const ln of raw.split(/\r?\n/)) {
    if (ln.startsWith(':')) continue; // comment
    if (ln.startsWith('event: ')) eventName = ln.slice(7).trim();
    else if (ln.startsWith('data: ')) dataLines.push(ln.slice(6));
  }
  if (dataLines.length === 0) return null;
  const data = dataLines.join('\n');
  try {
    const obj = JSON.parse(data);
    // Prefer the `line` field if present (UCI/GTP raw line)
    if (typeof obj?.line === 'string') return obj.line;
    // Otherwise, emit a synthetic line that handleLine can recognize.
    // - `{"event":"queued", ...}` → no engine line; skip
    // - `{"event":"done", ...}` → emit `event:done`
    // - `{"event":"error", "detail":...}` → emit `event:error`
    if (obj?.event === 'done') return '__sse_done__';
    if (obj?.event === 'error') return `? error: ${obj.detail ?? 'unknown'}`;
    return null;
  } catch {
    return data;
  }
}
