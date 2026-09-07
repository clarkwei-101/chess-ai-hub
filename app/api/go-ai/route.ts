/**
 * Go AI Server API route — integrates the Python Go AI server
 * (KataGo + style knowledge + opening book) into the chess-ai-hub pipeline.
 *
 * The Python server (lib/go-ai-server/go-ai-server.py) must be started
 * before this route is called: bash scripts/start-go-ai.sh
 *
 * Endpoints:
 *   GET  /api/go-ai/health     — check if server is running
 *   POST /api/go-ai/move       — get best move from Go AI
 *   POST /api/go-ai/reset     — reset the Go AI board
 */

import { NextRequest, NextResponse } from 'next/server';

const SERVER_URL = 'http://127.0.0.1:8200';
const TIMEOUT_MS = 60000;

async function serverRequest(path: string, body?: unknown): Promise<Response> {
  const url = `${SERVER_URL}${path}`;
  const opts: RequestInit = {
    method: body ? 'POST' : 'GET',
    headers: { 'Content-Type': 'application/json' },
  };
  if (body) opts.body = JSON.stringify(body);
  const ctrl = new AbortController();
  const to = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    return await fetch(url, { ...opts, signal: ctrl.signal });
  } finally {
    clearTimeout(to);
  }
}

export async function GET(req: NextRequest) {
  const url = new URL(req.url);
  const path = url.pathname.replace('/api/go-ai', '') || '/';

  try {
    const res = await serverRequest(path);
    const data = await res.json();
    return NextResponse.json(data, { status: res.status });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    // If connection refused, server is not running — start it
    if (msg.includes('abort') || msg.includes('ECONNREFUSED') || msg.includes('fetch')) {
      return NextResponse.json(
        { ok: false, error: 'Go AI Server not running. Run: bash scripts/start-go-ai.sh', hint: 'start_server' },
        { status: 503 }
      );
    }
    return NextResponse.json({ ok: false, error: msg }, { status: 500 });
  }
}

export async function POST(req: NextRequest) {
  const url = new URL(req.url);
  const path = url.pathname.replace('/api/go-ai', '') || '/';

  try {
    const body = await req.json();
    const res = await serverRequest(path, body);
    const data = await res.json();
    return NextResponse.json(data, { status: res.status });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes('abort') || msg.includes('ECONNREFUSED') || msg.includes('fetch')) {
      return NextResponse.json(
        { ok: false, error: 'Go AI Server not running. Run: bash scripts/start-go-ai.sh', hint: 'start_server' },
        { status: 503 }
      );
    }
    return NextResponse.json({ ok: false, error: msg }, { status: 500 });
  }
}
