// Demo Mode API — replays a famous game from SGF with synthesized KataGo analysis
//
// This route is the serverless-friendly counterpart to /api/engine/*:
//   GET  /api/demo?action=list                  → list all demo games
//   GET  /api/demo?action=game&id=<gameId>      → fetch one demo game (moves)
//   GET  /api/demo?action=analyze&id=<gameId>&ply=<N>&perspective=B → synthetic analysis

import { NextRequest, NextResponse } from 'next/server';
import { listDemoGames, getDemoGame, synthesizeAnalysis, getNextColorAt, classifyDemoMove } from '@/lib/go-demo/demo-engine';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  const action = req.nextUrl.searchParams.get('action') ?? 'list';
  const id = req.nextUrl.searchParams.get('id');
  const plyParam = req.nextUrl.searchParams.get('ply');
  const perspective = (req.nextUrl.searchParams.get('perspective') ?? 'B').toUpperCase() === 'W' ? 'W' : 'B';

  try {
    if (action === 'list') {
      const games = listDemoGames().map((g) => ({
        id: g.id,
        name: g.name,
        description: g.description,
        blackPlayer: g.blackPlayer,
        whitePlayer: g.whitePlayer,
        totalMoves: g.totalMoves,
      }));
      return NextResponse.json({ ok: true, data: { games } });
    }

    if (action === 'game') {
      if (!id) return NextResponse.json({ ok: false, error: 'Missing id' }, { status: 400 });
      const game = getDemoGame(id);
      if (!game) return NextResponse.json({ ok: false, error: 'Unknown demo game' }, { status: 404 });
      // DEBUG: verify moves are parsed
      if (process.env.CHESS_DEBUG === '1') {
        console.log('[demo game] id=', id, 'moves=', JSON.stringify(game.sgf.moves.slice(0, 3)));
      }
      return NextResponse.json({
        ok: true,
        data: {
          id: game.id,
          name: game.name,
          description: game.description,
          blackPlayer: game.blackPlayer,
          whitePlayer: game.whitePlayer,
          moves: game.sgf.moves,
          totalMoves: game.totalMoves,
        },
      });
    }

    if (action === 'analyze') {
      if (!id) return NextResponse.json({ ok: false, error: 'Missing id' }, { status: 400 });
      const ply = plyParam ? Math.max(0, parseInt(plyParam, 10) || 0) : 0;
      const nextColor = getNextColorAt(ply);
      const analysis = synthesizeAnalysis({
        gameId: id,
        ply,
        nextColor,
        playerPerspective: perspective,
      });
      const classification = classifyDemoMove(ply);
      return NextResponse.json({
        ok: true,
        data: {
          analysis,
          ply,
          nextColor,
          classification,
          perspective,
        },
      });
    }

    return NextResponse.json({ ok: false, error: 'Unknown action' }, { status: 400 });
  } catch (e: unknown) {
    const err = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ ok: false, error: err }, { status: 500 });
  }
}
