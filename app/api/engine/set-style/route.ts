// POST /api/engine/set-style — 切换引擎风格 (棋手 profile)
// body: { variant, styleId }

import { NextRequest, NextResponse } from 'next/server';
import { engineManager } from '@/lib/engine/EngineManager';
import { listStyles } from '@/lib/styles/style-profiles';
import { GameVariant } from '@/lib/types';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const variant = body.variant as GameVariant;
    const styleId = body.styleId as string;
    if (!['chess', 'xiangqi', 'go'].includes(variant)) {
      return NextResponse.json({ ok: false, error: 'Invalid variant' }, { status: 400 });
    }
    if (!styleId) {
      return NextResponse.json({ ok: false, error: 'Missing styleId' }, { status: 400 });
    }
    const result = await engineManager.setStyle(variant, styleId);
    return NextResponse.json({
      ok: true,
      data: {
        styleId: result.style.id,
        styleName: result.style.name,
        styleNameCn: result.style.nameCn,
        description: result.style.description,
        engineHints: result.style.engineHints[variant],
        applied: result.applied,
      },
    });
  } catch (e: unknown) {
    const err = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ ok: false, error: err }, { status: 500 });
  }
}

export async function GET() {
  return NextResponse.json({
    ok: true,
    data: { styles: listStyles().map((s) => ({ id: s.id, name: s.name, nameCn: s.nameCn, country: s.country, rank: s.rank, primaryVariant: s.primaryVariant, description: s.description })) },
  });
}
