// POST /api/engine/final-score — KataGo 双 pass 后 territory 计分
// body: { variant: 'go' }

import { NextRequest, NextResponse } from 'next/server';
import { engineManager } from '@/lib/engine/EngineManager';
import { GameVariant } from '@/lib/types';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const variant = body.variant as GameVariant;
    if (variant !== 'go') {
      return NextResponse.json({ ok: false, error: 'Only supported for go' }, { status: 400 });
    }
    const score = await engineManager.requestFinalScore(variant);
    return NextResponse.json({ ok: true, data: { score } });
  } catch (err: any) {
    return NextResponse.json({ ok: false, error: err.message }, { status: 500 });
  }
}