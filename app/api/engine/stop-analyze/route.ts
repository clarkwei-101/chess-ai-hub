// 主动停止 SSE 分析流 — 释放引擎资源
import { NextRequest, NextResponse } from 'next/server';
import { engineManager } from '@/lib/engine/EngineManager';
import { GameVariant } from '@/lib/types';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const variant = body.variant as GameVariant;
    if (!['chess', 'xiangqi', 'go'].includes(variant)) {
      return NextResponse.json({ ok: false, error: 'Invalid variant' }, { status: 400 });
    }
    await engineManager.stopAnalyze(variant);
    return NextResponse.json({ ok: true, data: { variant } });
  } catch (err: any) {
    return NextResponse.json({ ok: false, error: err.message }, { status: 500 });
  }
}
