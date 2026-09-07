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
    await engineManager.start(variant);
    return NextResponse.json({ ok: true, data: { variant, status: 'ready' } });
  } catch (err: any) {
    return NextResponse.json({ ok: false, error: err.message }, { status: 500 });
  }
}