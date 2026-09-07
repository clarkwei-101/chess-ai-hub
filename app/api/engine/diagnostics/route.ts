// Diagnostics API — show why engines may not start. Useful for self-debug after clone.
import { NextResponse } from 'next/server';
import { EngineManager } from '@/lib/engine/EngineManager';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET() {
  const diagnostics = EngineManager.diagnostics();
  return NextResponse.json({ ok: true, data: diagnostics });
}
