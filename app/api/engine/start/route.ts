import { NextRequest, NextResponse } from 'next/server';
import { engineManager } from '@/lib/engine/EngineManager';
import { GameVariant } from '@/lib/types';
import * as fs from 'fs';
import * as path from 'path';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

function engineBinaryAvailable(variant: GameVariant): boolean {
  const ENGINE_DIR = path.resolve(process.cwd(), 'engines');
  if (variant === 'chess') return fs.existsSync(path.join(ENGINE_DIR, 'stockfish'));
  if (variant === 'xiangqi') return fs.existsSync(path.join(ENGINE_DIR, 'pikafish'));
  const modelDir = path.join(ENGINE_DIR, 'networks');
  try {
    const files = fs.readdirSync(modelDir);
    return files.some((f) => f.endsWith('.bin.gz') || f.endsWith('.bin'));
  } catch {
    return false;
  }
}

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const variant = body.variant as GameVariant;
    if (!['chess', 'xiangqi', 'go'].includes(variant)) {
      return NextResponse.json({ ok: false, error: 'Invalid variant' }, { status: 400 });
    }
    if (!engineBinaryAvailable(variant)) {
      // Gracefully report engine unavailable so the UI can show a friendly
      // "demo mode only" banner instead of crashing.
      return NextResponse.json({
        ok: true,
        data: {
          variant,
          status: 'unavailable',
          reason: `Engine binaries / models not found in engines/. Run: npm run engines:download. ` +
            `On Vercel serverless, engines can't run — use Demo Mode at /go-demo instead.`,
        },
      });
    }
    await engineManager.start(variant);
    return NextResponse.json({ ok: true, data: { variant, status: 'ready' } });
  } catch (err: any) {
    return NextResponse.json({ ok: false, error: err.message }, { status: 500 });
  }
}