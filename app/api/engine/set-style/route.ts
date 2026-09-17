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
    // Look up the style profile from the catalog first — this always succeeds
    // even when the engine is unavailable (e.g. Vercel serverless without
    // KataGo binary), so the UI can still display the hint.
    const profile = listStyles().find((s) => s.id === styleId) ?? listStyles()[listStyles().length - 1];
    let applied: string[] = [];
    try {
      const result = await engineManager.setStyle(variant, styleId);
      applied = result.applied;
    } catch (e) {
      // Engine unavailable (e.g. serverless without binary). Still return the
      // style meta so the UI can show the active profile and hint.
      const msg = e instanceof Error ? e.message : String(e);
      applied = [`engine unavailable: ${msg.split('\n')[0]}`];
    }
    return NextResponse.json({
      ok: true,
      data: {
        styleId: profile.id,
        styleName: profile.name,
        styleNameCn: profile.nameCn,
        description: profile.description,
        engineHints: profile.engineHints[variant],
        applied,
        engineAvailable: applied.every((a) => !a.startsWith('engine unavailable')),
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
