// POST /api/engine/ownership — 请求 KataGo ownership heatmap (围棋)
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
    const ownership = await engineManager.requestOwnership(variant);
    return NextResponse.json({ ok: true, data: { ownership } });
  } catch (err: any) {
    return NextResponse.json({ ok: false, error: err.message }, { status: 500 });
  }
}