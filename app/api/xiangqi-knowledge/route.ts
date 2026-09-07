// 中国象棋知识库 API — 检索棋手/战略/布局
import { NextRequest, NextResponse } from 'next/server';
import { searchXqKnowledge, buildXqRagContext, getXqPlayer, listXqPlayerIds } from '@/lib/xiangqi-knowledge/knowledge-base';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  const action = req.nextUrl.searchParams.get('action');
  const id = req.nextUrl.searchParams.get('id');
  const query = req.nextUrl.searchParams.get('query');

  try {
    if (action === 'list') {
      const players = listXqPlayerIds();
      return NextResponse.json({ ok: true, data: { players, total: players.length } });
    }

    if (action === 'player' && id) {
      const player = getXqPlayer(id);
      if (!player) return NextResponse.json({ ok: false, error: 'Player not found' }, { status: 404 });
      return NextResponse.json({ ok: true, data: player });
    }

    if (action === 'search' && query) {
      const topK = parseInt(req.nextUrl.searchParams.get('topK') || '5', 10);
      const results = searchXqKnowledge(query, topK);
      const context = buildXqRagContext(query, topK);
      return NextResponse.json({
        ok: true,
        data: { results, context, total: results.length },
      });
    }

    return NextResponse.json({ ok: false, error: 'Unknown action' }, { status: 400 });
  } catch (e: unknown) {
    const err = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ ok: false, error: err }, { status: 500 });
  }
}
