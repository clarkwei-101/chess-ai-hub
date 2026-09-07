// Go 知识库 API — 检索棋手/战略/定式
import { NextRequest, NextResponse } from 'next/server';
import { searchKnowledge, buildRagContext, getPlayer, getPlayersByCountry, listPlayerIds } from '@/lib/go-knowledge/knowledge-base';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  const action = req.nextUrl.searchParams.get('action');
  const id = req.nextUrl.searchParams.get('id');
  const country = req.nextUrl.searchParams.get('country');
  const query = req.nextUrl.searchParams.get('query');

  try {
    if (action === 'list') {
      const players = listPlayerIds();
      return NextResponse.json({ ok: true, data: { players, total: players.length } });
    }

    if (action === 'player' && id) {
      const player = getPlayer(id);
      if (!player) return NextResponse.json({ ok: false, error: 'Player not found' }, { status: 404 });
      return NextResponse.json({ ok: true, data: player });
    }

    if (action === 'by-country' && country) {
      if (!['chinese', 'korean', 'japanese'].includes(country)) {
        return NextResponse.json({ ok: false, error: 'Invalid country' }, { status: 400 });
      }
      const players = getPlayersByCountry(country as 'chinese' | 'korean' | 'japanese');
      return NextResponse.json({ ok: true, data: { players, total: players.length } });
    }

    if (action === 'search' && query) {
      const topK = parseInt(req.nextUrl.searchParams.get('topK') || '5', 10);
      const results = searchKnowledge(query, topK);
      const context = buildRagContext(query, topK);
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
