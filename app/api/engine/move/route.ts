import { NextRequest, NextResponse } from 'next/server';
import { engineManager } from '@/lib/engine/EngineManager';
import { GameVariant } from '@/lib/types';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const GO_AI_URL = 'http://127.0.0.1:8200';
const GO_AI_TIMEOUT = 90000; // 90s for 8000 visits

async function callGoAIServer(path: string, body?: unknown): Promise<{ ok: boolean; data?: unknown; error?: string; hint?: string }> {
  const url = `${GO_AI_URL}${path}`;
  const opts: RequestInit = {
    method: body ? 'POST' : 'GET',
    headers: { 'Content-Type': 'application/json' },
  };
  if (body) opts.body = JSON.stringify(body);
  const ctrl = new AbortController();
  const to = setTimeout(() => ctrl.abort(), GO_AI_TIMEOUT);
  try {
    const res = await fetch(url, { ...opts, signal: ctrl.signal });
    if (!res.ok) {
      const text = await res.text();
      return { ok: false, error: text };
    }
    const data = await res.json();
    return { ok: true, data };
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes('abort') || msg.includes('ECONNREFUSED') || msg.includes('fetch')) {
      return { ok: false, error: 'Go AI Server not running', hint: 'start_server' };
    }
    return { ok: false, error: msg };
  } finally {
    clearTimeout(to);
  }
}

/**
 * Apply a move or special action.
 *
 * body: { variant, move: string | 'auto', timeMs?, maxVisits?, styleId? }
 *
 * 'auto' / 'ai' / empty → engine generates the move itself
 * 'pass' → Go 虚手 (no stone placed, turn switches)
 * 'resign' → player resigns, game over
 * 'undo' → pop last move from history and replay
 * otherwise → treat as a move string (UCI 'e2e4' for chess/xiangqi, GTP 'Q16' for go)
 */
export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const variant = body.variant as GameVariant;
    const move = body.move as string;
    const timeMs = (body.timeMs as number | undefined) ?? undefined;
    const maxVisits = (body.maxVisits as number | undefined) ?? undefined;
    const styleId = (body.styleId as string | undefined) ?? 'default';
    const goMoves = (body.goMoves as string[] | undefined) ?? [];
    // P2-4 fix: validate goMoves format — only accept valid GTP strings + pass/resign.
    // Reject malformed entries silently so we don't send garbage to the engine and
    // crash the Go AI server.
    const validatedGoMoves = goMoves.filter((m) => {
      if (typeof m !== 'string') return false;
      if (m === 'pass' || m === 'resign') return true;
      // GTP: column letter (A-T except I), row 1-19, optional at sign @ for handicap
      return /^[A-HJ-T](1[0-9]|@[1-9]|[1-9])$/i.test(m);
    });

    if (!['chess', 'xiangqi', 'go'].includes(variant)) {
      return NextResponse.json({ ok: false, error: 'Invalid variant' }, { status: 400 });
    }

    // AI 走子
    if (!move || move === 'auto' || move === 'ai') {
      // 必须先停掉 analyze stream 的 generator (前端关 EventSource 不会停后端循环)
      await engineManager.stopAnalyze(variant).catch(() => {});
      // 等 100ms 让 stdout/stderr 缓冲清干净
      await new Promise((r) => setTimeout(r, 100));

      let result: Awaited<ReturnType<typeof engineManager.aiMove>>;

      if (variant === 'go') {
        // 优先用 Go AI Server (KataGo + style knowledge + opening book)
        const color = body.color as 'B' | 'W' ?? 'B';
        const style = styleId ?? 'default';
        const serverResult = await callGoAIServer('/move', {
          moves: validatedGoMoves,
          style,
          color,
          time_ms: timeMs ?? 60000, // 60s for strong play
        });

        if (serverResult.ok && serverResult.data && typeof (serverResult.data as Record<string, unknown>).move === 'string') {
          const aiMove = (serverResult.data as { move: string; source?: string; confidence?: number }).move;
          // Apply to KataGo GTP to keep engine board in sync
          const applied = await engineManager.applyMove('go', aiMove);
          if (!applied.legal) {
            // Fallback to raw KataGo if Go AI server move was rejected
            result = await engineManager.aiMove('go', { timeMs: timeMs ?? 30000, styleId });
          } else {
            // Get latest analysis from KataGo
            const analysis = engineManager.getState('go').currentAnalysis;
            result = { move: aiMove, analysis, style: undefined };
          }
        } else {
          // Go AI server unavailable — fall back to raw KataGo
          result = await engineManager.aiMove('go', { timeMs: timeMs ?? 30000, styleId });
        }
      } else {
        result = await engineManager.aiMove(variant, { timeMs, maxVisits, styleId });
      }

      return NextResponse.json({
        ok: true,
        data: {
          legal: result.move !== null,
          aiMove: result.move,
          analysis: result.analysis,
          style: result.style ? { id: result.style.id, name: result.style.name, nameCn: result.style.nameCn } : undefined,
        },
      });
    }

    // 悔棋
    if (move === 'undo') {
      await engineManager.stopAnalyze(variant).catch(() => {});
      await new Promise((r) => setTimeout(r, 100));
      const result = await engineManager.undoMove(variant);
      return NextResponse.json({ ok: true, data: { ...result } });
    }

    // 玩家走子 (pass / resign / 普通落子都走 applyMove)
    await engineManager.stopAnalyze(variant).catch(() => {});
    await new Promise((r) => setTimeout(r, 100));
    const result = await engineManager.applyMove(variant, move);
    return NextResponse.json({ ok: true, data: { ...result } });
  } catch (err: any) {
    return NextResponse.json({ ok: false, error: err.message }, { status: 500 });
  }
}