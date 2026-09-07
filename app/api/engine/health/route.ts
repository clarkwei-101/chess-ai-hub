// 健康检查 API
import { NextResponse } from 'next/server';
import { EngineManager } from '@/lib/engine/EngineManager';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET() {
  const health = EngineManager.health();
  return NextResponse.json({ ok: true, data: health });
}