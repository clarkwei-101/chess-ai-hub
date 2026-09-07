// Visual mode page — connect to Lichess, fetch game state, get AI move
'use client';

import { useState, useEffect, useRef, useCallback } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { Chess } from 'chess.js';
import { ChessBoard } from '@/components/board/ChessBoard';
import { WinRateBar } from '@/components/analysis/WinRateBar';
import { MoveList } from '@/components/analysis/MoveList';
import { Explanation } from '@/components/analysis/Explanation';
import { fetchLichessGame, lichessPlayMove, parseLichessUrl, LichessGameInfo } from '@/lib/lichess';
import { Analysis, MoveRecord } from '@/lib/types';

type ConnectionStatus = 'disconnected' | 'connecting' | 'connected' | 'error';

export default function VisualPage() {
  const [url, setUrl] = useState('');
  const [apiToken, setApiToken] = useState('');
  const [gameInfo, setGameInfo] = useState<LichessGameInfo | null>(null);
  const [status, setStatus] = useState<ConnectionStatus>('disconnected');
  const [error, setError] = useState<string | null>(null);
  const [analysis, setAnalysis] = useState<Analysis | null>(null);
  const [moves, setMoves] = useState<MoveRecord[]>([]);
  const [playerSide, setPlayerSide] = useState<'white' | 'black' | 'auto'>('auto');
  const [showTokenInput, setShowTokenInput] = useState(false);
  const chessRef = useRef<Chess | null>(null);

  // Determine player side based on lichess turn
  useEffect(() => {
    if (gameInfo && playerSide === 'auto') {
      setPlayerSide(gameInfo.turn === 'white' ? 'white' : 'black');
    }
  }, [gameInfo, playerSide]);

  // Connect to a Lichess game
  const connect = useCallback(async () => {
    if (!url.trim()) return;
    setStatus('connecting');
    setError(null);

    const trimmed = url.trim();

    // Detect raw FEN input
    const isFen = /^[rnbqkpRNBQKP1-8\/]+\s+[wb]\s+[KQkqA-Ha-h\-]+\s+[a-h\-1-8]+\s+\d+\s+\d+$/.test(trimmed);

    if (isFen) {
      const fen = trimmed;
      setGameInfo({
        game_id: '',
        variant: 'standard',
        rated: false,
        status: 'setup',
        players: { white: { name: 'White' }, black: { name: 'Black' } },
        pgn: '',
        fen,
        turn: fen.split(' ')[1] === 'w' ? 'white' : 'black',
        analysis_url: '',
      });
      chessRef.current = new Chess(fen);
      setMoves([]);
      setStatus('connected');
      analyzeFen(fen);
      return;
    }

    // If it's a board URL, analyze the FEN directly
    const boardUrl = parseLichessUrl(trimmed);
    if (boardUrl) {
      setGameInfo({
        game_id: '',
        variant: 'standard',
        rated: false,
        status: 'setup',
        players: { white: { name: 'White' }, black: { name: 'Black' } },
        pgn: '',
        fen: boardUrl.fen,
        turn: boardUrl.fen.split(' ')[1] === 'w' ? 'white' : 'black',
        analysis_url: trimmed,
      });
      chessRef.current = new Chess(boardUrl.fen);
      setMoves([]);
      setStatus('connected');
      analyzeFen(boardUrl.fen);
      return;
    }

    // Extract game ID from URL or use as-is
    const gameIdMatch = trimmed.match(/lichess\.org\/([a-zA-Z0-9]{8,12})/) || trimmed.match(/^([a-zA-Z0-9]{8,12})$/);
    if (!gameIdMatch) {
      setError('Could not extract Lichess game ID. Paste a URL like https://lichess.org/abc12345');
      setStatus('error');
      return;
    }
    const gameId = gameIdMatch[1];

    try {
      const info = await fetchLichessGame(gameId);
      if (!info) {
        setError('Game not found or is private. Make sure the URL is correct.');
        setStatus('error');
        return;
      }
      setGameInfo(info);
      chessRef.current = new Chess(info.fen);
      setMoves([]);
      setStatus('connected');
      analyzeFen(info.fen);
    } catch (e: any) {
      setError(e.message);
      setStatus('error');
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [url]); // analyzeFen 在下方定义,通过 ref 间接触发,避免 use-before-define

  // Analyze FEN by calling the visual server
  const analyzeFen = useCallback(async (fen: string) => {
    try {
      // Visual server port configurable via NEXT_PUBLIC_VISUAL_PORT (default 3003)
      const port = process.env.NEXT_PUBLIC_VISUAL_PORT ?? '3003';
      const resp = await fetch(`http://localhost:${port}/board/analyze`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ fen, depth: 18, multipv: 4 }),
      });
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      const data = await resp.json();
      if (data.ok) {
        const a: Analysis = {
          variant: 'chess',
          depth: data.lines[0]?.depth ?? 18,
          winRate: data.best_win_rate / 100,
          scoreCp: data.lines[0]?.score_cp,
          multiPv: data.lines.map((l: any, idx: number) => ({
            id: idx + 1,
            move: l.move,
            pv: l.pv,
            winRate: l.win_rate / 100,
            scoreCp: l.score_cp,
          })),
          engine: 'Stockfish 18 (Visual)',
          ts: Date.now(),
        };
        setAnalysis(a);
      }
    } catch (e: any) {
      setError('Visual server not running. Start it with: bash scripts/start-visual.sh');
    }
  }, []);

  // Play best move on Lichess (requires bot API token)
  const playOnLichess = useCallback(async () => {
    if (!gameInfo || !analysis?.multiPv[0]) return;
    if (!apiToken) {
      setShowTokenInput(true);
      setError('Lichess API token required. Get one at https://lichess.org/account/oauth/token with "Play games" scope.');
      return;
    }
    const bestMove = analysis.multiPv[0].move;
    const result = await lichessPlayMove(gameInfo.game_id, bestMove, apiToken);
    if (!result.ok) {
      setError(`Failed to play move: ${result.error}`);
    } else {
      // Refresh game state
      setTimeout(async () => {
        const info = await fetchLichessGame(gameInfo.game_id);
        if (info) {
          setGameInfo(info);
          chessRef.current = new Chess(info.fen);
          setMoves((prev) => [
            ...prev,
            {
              ply: prev.length + 1,
              move: bestMove,
              san: bestMove,
              winRate: analysis.winRate,
            },
          ]);
          analyzeFen(info.fen);
        }
      }, 500);
    }
  }, [gameInfo, analysis, apiToken, analyzeFen]);

  const disconnect = useCallback(() => {
    setGameInfo(null);
    setAnalysis(null);
    setMoves([]);
    setStatus('disconnected');
    setError(null);
    setUrl('');
  }, []);

  // Determine current FEN from gameInfo + moves
  const currentFen = gameInfo?.fen ?? 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';

  return (
    <main className="min-h-screen bg-black-deep">
      {/* Top Bar */}
      <header className="border-b border-silver-border bg-black-rich/80 backdrop-blur-xl sticky top-0 z-50">
        <div className="max-w-[1600px] mx-auto px-6 py-4 flex items-center justify-between">
          <div className="flex items-center gap-4">
            <a href="/" className="text-silver-mid hover:text-silver-primary transition-colors text-sm">
              ← Back to Hub
            </a>
            <div className="w-px h-6 bg-silver-border" />
            <div>
              <h1 className="text-silver-primary font-medium">Visual Mode</h1>
              <p className="text-silver-dim text-xs mt-0.5">
                Connect Lichess · AI plays for you · Stockfish analysis
              </p>
            </div>
          </div>
          <div className="flex items-center gap-3">
            <span className={`inline-flex items-center gap-2 px-3 py-1.5 rounded-full text-xs ${
              status === 'connected' ? 'bg-green-500/10 text-green-400 border border-green-500/30' :
              status === 'connecting' ? 'bg-yellow-500/10 text-yellow-400 border border-yellow-500/30' :
              status === 'error' ? 'bg-red-500/10 text-red-400 border border-red-500/30' :
              'bg-silver-mid/5 text-silver-dim border border-silver-border'
            }`}>
              <span className={`w-1.5 h-1.5 rounded-full ${
                status === 'connected' ? 'bg-green-400 animate-pulse' :
                status === 'connecting' ? 'bg-yellow-400 animate-pulse' :
                status === 'error' ? 'bg-red-400' : 'bg-silver-mid'
              }`} />
              {status === 'connected' && gameInfo
                ? gameInfo.game_id
                  ? `${gameInfo.players.white.name} vs ${gameInfo.players.black.name}`
                  : 'Board Setup'
                : status}
            </span>
            {status === 'connected' && (
              <button
                onClick={disconnect}
                className="px-3 py-1.5 rounded-lg border border-silver-border text-silver-mid text-xs hover:bg-silver-mid/10"
              >
                Disconnect
              </button>
            )}
          </div>
        </div>
      </header>

      {/* Error banner */}
      {error && (
        <div className="bg-red-500/10 border-b border-red-500/30 px-6 py-3 text-red-300 text-sm flex items-center justify-between">
          <span>{error}</span>
          <button onClick={() => setError(null)} className="ml-4 text-red-400 underline">Dismiss</button>
        </div>
      )}

      {/* Connection form */}
      {status !== 'connected' && (
        <div className="max-w-2xl mx-auto px-6 py-16">
          <motion.div
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            className="glass rounded-2xl p-8"
          >
            <h2 className="text-2xl font-light text-silver-primary mb-2">Connect a Lichess Game</h2>
            <p className="text-silver-dim text-sm mb-6">
              Paste a Lichess game URL or board URL. The AI will analyze the current position with Stockfish and play the best move.
            </p>

            {/* URL input */}
            <label className="block text-xs uppercase tracking-wider text-silver-dim mb-2">Game or Board URL</label>
            <input
              type="text"
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              placeholder="Lichess URL, FEN, or game ID"
              className="w-full bg-black-rich border border-silver-border rounded-lg px-4 py-3 text-silver-primary placeholder:text-silver-dim/50 focus:outline-none focus:border-silver-mid mb-4 font-mono text-sm"
              onKeyDown={(e) => e.key === 'Enter' && connect()}
            />

            {/* API token (collapsible) */}
            <button
              onClick={() => setShowTokenInput(!showTokenInput)}
              className="text-xs text-silver-mid hover:text-silver-primary mb-2"
            >
              {showTokenInput ? '− Hide' : '+ Show'} Lichess API token (optional, for AI to play moves)
            </button>
            {showTokenInput && (
              <input
                type="password"
                value={apiToken}
                onChange={(e) => setApiToken(e.target.value)}
                placeholder="lip_xxx..."
                className="w-full bg-black-rich border border-silver-border rounded-lg px-4 py-3 text-silver-primary placeholder:text-silver-dim/50 focus:outline-none focus:border-silver-mid mb-4 font-mono text-sm"
              />
            )}

            <button
              onClick={connect}
              disabled={!url.trim() || status === 'connecting'}
              className="w-full bg-silver-primary text-black-deep font-medium rounded-lg px-4 py-3 hover:bg-silver-light disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
            >
              {status === 'connecting' ? 'Connecting...' : 'Connect & Analyze'}
            </button>

            {/* Examples */}
            <div className="mt-6 pt-6 border-t border-silver-border">
              <p className="text-xs text-silver-dim mb-3">Examples to try:</p>
              <div className="space-y-2">
                {['https://lichess.org/analysis/board/rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR_b_KQkq_e3_0_1', 'https://lichess.org/analysis/board/r1bqkb1r/pppp1ppp/2n2n2/4p3/2B1P3/5N2/PPPP1PPP/RNBQK2R_w_KQkq_-_3_3'].map((ex) => (
                  <button
                    key={ex}
                    onClick={() => setUrl(ex)}
                    className="block w-full text-left text-xs font-mono text-silver-mid hover:text-silver-primary bg-black-rich/50 px-3 py-2 rounded border border-silver-border hover:border-silver-mid/30 truncate"
                  >
                    {ex}
                  </button>
                ))}
              </div>
            </div>
          </motion.div>
        </div>
      )}

      {/* Connected state: Board + Analysis */}
      {status === 'connected' && gameInfo && (
        <div className="max-w-[1600px] mx-auto px-6 py-6 grid grid-cols-1 lg:grid-cols-[1fr_420px_360px] gap-6">
          {/* Board */}
          <div className="flex items-start justify-center">
            <motion.div
              initial={{ opacity: 0, scale: 0.95 }}
              animate={{ opacity: 1, scale: 1 }}
              transition={{ duration: 0.4 }}
              className="glass rounded-2xl p-4 lg:p-6"
            >
              <ChessBoard
                analysis={analysis}
                playerSide={playerSide === 'auto' ? 'white' : playerSide}
                onMove={() => {}}
                lastMove={moves.length > 0 ? moves[moves.length - 1].move : null}
                fen={currentFen}
              />
              {/* Opening name */}
              {gameInfo.opening && (
                <div className="mt-4 text-center">
                  <span className="inline-block px-3 py-1 rounded-full bg-silver-mid/10 border border-silver-border text-xs text-silver-mid">
                    {gameInfo.opening.eco} · {gameInfo.opening.name}
                  </span>
                </div>
              )}
            </motion.div>
          </div>

          {/* Analysis Panel */}
          <div className="space-y-4">
            <div className="glass rounded-2xl p-5">
              <div className="text-xs text-silver-dim uppercase tracking-wider mb-3">Win Rate · {playerSide === 'auto' ? 'Side to Move' : (playerSide === 'white' ? 'White' : 'Black')}</div>
              <WinRateBar
                value={analysis?.winRate ?? 0.5}
                label={`${analysis ? Math.round(analysis.winRate * 100) : 50}%`}
                sublabel={analysis?.scoreCp !== undefined ? `${analysis.scoreCp >= 0 ? '+' : ''}${(analysis.scoreCp / 100).toFixed(2)}` : '—'}
              />
            </div>

            <div className="glass rounded-2xl p-5">
              <div className="text-xs text-silver-dim uppercase tracking-wider mb-3">Top Candidates</div>
              <MoveList
                lines={analysis?.multiPv ?? []}
                variant="chess"
              />
            </div>

            <div className="glass rounded-2xl p-5">
              <div className="text-xs text-silver-dim uppercase tracking-wider mb-3">Why this move?</div>
              <Explanation analysis={analysis} variant="chess" />
            </div>

            {/* AI play button */}
            <button
              onClick={playOnLichess}
              disabled={!analysis?.multiPv[0] || !gameInfo.game_id}
              className="w-full bg-gradient-to-r from-cyan-500 to-blue-500 text-white font-medium rounded-lg px-4 py-3 hover:opacity-90 disabled:opacity-50 disabled:cursor-not-allowed transition-all"
            >
              Play Best Move on Lichess →
            </button>
            {!gameInfo.game_id && (
              <p className="text-xs text-silver-dim text-center">
                Board setups cannot be played — connect to a live game instead.
              </p>
            )}
            {gameInfo.game_id && !apiToken && (
              <p className="text-xs text-yellow-400/80 text-center">
                API token required to play moves on Lichess.
              </p>
            )}
          </div>

          {/* Game Info + Move History */}
          <div className="space-y-4">
            <div className="glass rounded-2xl p-5">
              <div className="text-xs text-silver-dim uppercase tracking-wider mb-3">Game Info</div>
              <div className="space-y-2 text-sm">
                <div className="flex justify-between">
                  <span className="text-silver-dim">Status</span>
                  <span className="text-silver-primary font-mono">{gameInfo.status}</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-silver-dim">Variant</span>
                  <span className="text-silver-primary font-mono">{gameInfo.variant}</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-silver-dim">Turn</span>
                  <span className="text-silver-primary font-mono">{gameInfo.turn}</span>
                </div>
                {gameInfo.players.white.rating && (
                  <div className="flex justify-between">
                    <span className="text-silver-dim">White</span>
                    <span className="text-silver-primary font-mono">{gameInfo.players.white.rating}</span>
                  </div>
                )}
                {gameInfo.players.black.rating && (
                  <div className="flex justify-between">
                    <span className="text-silver-dim">Black</span>
                    <span className="text-silver-primary font-mono">{gameInfo.players.black.rating}</span>
                  </div>
                )}
                {gameInfo.game_id && (
                  <a
                    href={gameInfo.analysis_url}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="block mt-3 text-center text-xs text-silver-mid hover:text-silver-primary underline"
                  >
                    Open on Lichess →
                  </a>
                )}
              </div>
            </div>

            <div className="glass rounded-2xl p-5 max-h-[400px] overflow-y-auto">
              <div className="text-xs text-silver-dim uppercase tracking-wider mb-3">Move History</div>
              {moves.length === 0 ? (
                <div className="text-silver-dim text-sm py-4 text-center">No moves played yet</div>
              ) : (
                <div className="space-y-1 text-sm font-mono">
                  {moves.map((m, i) => (
                    <div key={i} className="flex justify-between py-1 px-2 rounded hover:bg-silver-mid/5">
                      <span className="text-silver-dim">{Math.floor(i / 2) + 1}.</span>
                      <span className="text-silver-primary">{m.move}</span>
                    </div>
                  ))}
                </div>
              )}
            </div>

            <div className="glass rounded-2xl p-5">
              <div className="text-xs text-silver-dim uppercase tracking-wider mb-3">Current FEN</div>
              <div className="text-[10px] font-mono text-silver-mid break-all">{currentFen}</div>
            </div>
          </div>
        </div>
      )}
    </main>
  );
}
