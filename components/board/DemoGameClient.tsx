'use client';

import { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { WinRateBar } from '../analysis/WinRateBar';
import { MoveList } from '../analysis/MoveList';
import { Explanation } from '../analysis/Explanation';
import { StyleSelector } from '../side/StyleSelector';
import { GoBoard } from '../board/GoBoard';
import type { Analysis, MoveRecord, GameVariant } from '@/lib/types';

interface DemoGameSummary {
  id: string;
  name: string;
  description: string;
  blackPlayer: string;
  whitePlayer: string;
  totalMoves: number;
}

interface DemoGameFull extends DemoGameSummary {
  moves: string[];
}

interface DemoAnalysis {
  analysis: Analysis;
  ply: number;
  nextColor: 'B' | 'W';
  classification: { label: string; color: string; description: string };
  perspective: 'B' | 'W';
}

interface DemoGameClientProps {
  initialGameId?: string;
}

export function DemoGameClient({ initialGameId }: DemoGameClientProps) {
  const [games, setGames] = useState<DemoGameSummary[]>([]);
  const [selectedGameId, setSelectedGameId] = useState<string>(initialGameId ?? '');
  const [game, setGame] = useState<DemoGameFull | null>(null);
  const [ply, setPly] = useState(0); // current step (0 = before any move)
  const [analysis, setAnalysis] = useState<DemoAnalysis | null>(null);
  const [autoPlay, setAutoPlay] = useState(true);
  const [autoPlaySpeed, setAutoPlaySpeed] = useState(1500); // ms per move
  const [isComplete, setIsComplete] = useState(false);
  const [styleId, setStyleId] = useState<string>('default');
  const [showStyleTip, setShowStyleTip] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [showGamePicker, setShowGamePicker] = useState(false);
  const playerPerspective: 'B' | 'W' = 'B'; // always play from Black perspective in demo

  const autoPlayTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Load games list
  useEffect(() => {
    fetch('/api/demo?action=list')
      .then((r) => r.json())
      .then((d) => {
        if (d.ok) {
          setGames(d.data.games);
          if (!selectedGameId && d.data.games.length > 0) {
            setSelectedGameId(d.data.games[0].id);
          }
        }
      })
      .catch((e) => setError(String(e)));
  }, [selectedGameId]);

  // Load game when id changes
  useEffect(() => {
    if (!selectedGameId) return;
    fetch(`/api/demo?action=game&id=${encodeURIComponent(selectedGameId)}`)
      .then((r) => r.json())
      .then((d) => {
        if (d.ok) {
          setGame(d.data);
          setPly(0);
          setIsComplete(false);
        } else {
          setError(d.error);
        }
      })
      .catch((e) => setError(String(e)));
  }, [selectedGameId]);

  // Fetch analysis for current ply
  const fetchAnalysis = useCallback(async (targetPly: number) => {
    if (!selectedGameId) return;
    try {
      const r = await fetch(`/api/demo?action=analyze&id=${encodeURIComponent(selectedGameId)}&ply=${targetPly}&perspective=${playerPerspective}`);
      const d = await r.json();
      if (d.ok) {
        setAnalysis(d.data);
      } else {
        setError(d.error);
      }
    } catch (e) {
      setError(String(e));
    }
  }, [selectedGameId, playerPerspective]);

  // Re-fetch analysis when ply changes
  useEffect(() => {
    fetchAnalysis(ply);
  }, [ply, fetchAnalysis]);

  // Autoplay logic
  useEffect(() => {
    if (!autoPlay || !game || isComplete) {
      if (autoPlayTimerRef.current) clearTimeout(autoPlayTimerRef.current);
      return;
    }
    if (ply >= game.totalMoves) {
      setIsComplete(true);
      return;
    }
    autoPlayTimerRef.current = setTimeout(() => {
      setPly((p) => p + 1);
    }, autoPlaySpeed);
    return () => {
      if (autoPlayTimerRef.current) clearTimeout(autoPlayTimerRef.current);
    };
  }, [ply, autoPlay, autoPlaySpeed, game, isComplete]);

  // Mark complete when we reach the end
  useEffect(() => {
    if (game && ply >= game.totalMoves && !isComplete) {
      setIsComplete(true);
    }
  }, [ply, game, isComplete]);

  // Convert current moves to MoveRecord[] for GoBoard replay
  const moveRecords: MoveRecord[] = useMemo(() => {
    if (!game) return [];
    const records: MoveRecord[] = [];
    for (let i = 0; i < ply && i < game.moves.length; i++) {
      const isBlack = i % 2 === 0;
      records.push({
        ply: i + 1,
        move: game.moves[i],
        san: game.moves[i] === 'pass' ? 'Pass' : game.moves[i],
        comment: isBlack ? `黑 · 9段` : `白 · KataGo`,
      });
    }
    return records;
  }, [game, ply]);

  const handleNext = useCallback(() => {
    if (!game) return;
    setPly((p) => Math.min(game.totalMoves, p + 1));
  }, [game]);

  const handlePrev = useCallback(() => {
    setPly((p) => Math.max(0, p - 1));
  }, []);

  const handleReset = useCallback(() => {
    setPly(0);
    setIsComplete(false);
  }, []);

  const handleSkipToEnd = useCallback(() => {
    if (!game) return;
    setPly(game.totalMoves);
  }, [game]);

  // Style change handler
  const applyStyle = useCallback(async (newStyleId: string) => {
    setStyleId(newStyleId);
    try {
      const r = await fetch('/api/engine/set-style', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ variant: 'go' as GameVariant, styleId: newStyleId }),
      });
      const j = await r.json();
      if (j.ok && j.data?.description) {
        setShowStyleTip(j.data.styleNameCn + ' · ' + j.data.description.slice(0, 60));
        setTimeout(() => setShowStyleTip(null), 3000);
      }
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      // Demo Mode: server may not have engine running. Tip is the important thing.
      if (newStyleId !== 'default') {
        setShowStyleTip(`Style · ${newStyleId}`);
        setTimeout(() => setShowStyleTip(null), 2000);
      }
      // Ignore engine-related errors in demo
      void msg;
    }
  }, []);

  if (!game) {
    return (
      <main className="min-h-screen bg-black-deep flex items-center justify-center">
        <div className="text-silver-dim text-sm">Loading demo game...</div>
      </main>
    );
  }

  const currentColor = ply % 2 === 0 ? 'B' : 'W';
  const lastMove = ply > 0 ? game.moves[ply - 1] : null;
  const isBlackPlayer = currentColor === 'B';
  const perspectivePlayer = playerPerspective === 'B' ? '黑 (执先)' : '白';

  return (
    <main className="min-h-screen bg-black-deep">
      {/* Top Bar */}
      <header className="border-b border-silver-border bg-black-rich/80 backdrop-blur-xl">
        <div className="max-w-[1600px] mx-auto px-6 py-4 flex items-center justify-between">
          <div className="flex items-center gap-4">
            <a href="/" className="text-silver-mid hover:text-silver-primary transition-colors text-sm">
              ← Back
            </a>
            <div className="w-px h-6 bg-silver-border" />
            <div>
              <h1 className="text-silver-primary font-medium">Demo Mode · 围棋</h1>
              <p className="text-silver-dim text-xs mt-0.5">
                KataGo v1.18.1 (simulated) vs {game.blackPlayer} · {game.totalMoves} 手
              </p>
            </div>
          </div>
          <div className="flex items-center gap-3">
            <button
              onClick={() => setShowGamePicker((v) => !v)}
              className="px-3 py-2 rounded-lg border border-silver-mid/30 bg-black-elevated hover:bg-silver-mid/10 transition-colors text-sm text-silver-primary"
            >
              {game.name.split(' · ')[0]}
              <span className="ml-1 text-silver-dim">▼</span>
            </button>
            <StyleSelector variant="go" value={styleId} onChange={applyStyle} />
          </div>
        </div>
      </header>

      {/* Style applied toast */}
      <AnimatePresence>
        {showStyleTip && (
          <motion.div
            initial={{ opacity: 0, y: -10 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -10 }}
            className="fixed top-20 right-6 z-50 max-w-sm bg-cyan-500/10 border border-cyan-500/40 rounded-xl px-4 py-3 text-cyan-200 text-sm shadow-2xl"
          >
            {showStyleTip}
          </motion.div>
        )}
      </AnimatePresence>

      {/* Demo Mode banner */}
      <div className="bg-gradient-to-r from-cyan-500/10 via-blue-500/10 to-purple-500/10 border-b border-cyan-500/20">
        <div className="max-w-[1600px] mx-auto px-6 py-3 flex flex-col md:flex-row md:items-center gap-2">
          <div className="flex items-center gap-2">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="text-cyan-400">
              <circle cx="12" cy="12" r="10"/>
              <path d="M12 8v4M12 16h.01"/>
            </svg>
            <span className="text-cyan-300 text-sm font-medium">Demo Mode · UI Preview</span>
          </div>
          <span className="text-silver-dim text-xs md:ml-3">
            复盘 {game.name} · 黑方 <strong className="text-silver-primary">{game.blackPlayer}</strong> · 白方 <strong className="text-silver-primary">{game.whitePlayer}</strong>
          </span>
        </div>
      </div>

      {error && (
        <div className="bg-red-500/10 border-b border-red-500/30 px-6 py-3 text-red-300 text-sm">
          {error}
          <button onClick={() => setError(null)} className="ml-4 text-red-400 underline">Dismiss</button>
        </div>
      )}

      {/* Game picker dropdown */}
      <AnimatePresence>
        {showGamePicker && (
          <motion.div
            initial={{ opacity: 0, y: -10 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -10 }}
            className="fixed top-32 right-6 z-40 glass rounded-2xl border border-cyan-500/30 p-4 w-96 shadow-2xl"
          >
            <div className="text-xs text-silver-dim uppercase tracking-wider mb-3">Select Demo Game</div>
            <div className="space-y-2">
              {games.map((g) => (
                <button
                  key={g.id}
                  onClick={() => { setSelectedGameId(g.id); setShowGamePicker(false); }}
                  className={`block w-full text-left p-3 rounded-xl border transition-all ${
                    g.id === selectedGameId
                      ? 'border-cyan-500/50 bg-cyan-500/10'
                      : 'border-silver-border hover:border-silver-mid/40 hover:bg-silver-mid/5'
                  }`}
                >
                  <div className="text-silver-primary text-sm font-medium">{g.name}</div>
                  <div className="text-silver-dim text-xs mt-1">{g.description}</div>
                  <div className="text-silver-dim text-xs mt-1 font-mono">
                    黑: {g.blackPlayer} · 白: {g.whitePlayer} · {g.totalMoves} 手
                  </div>
                </button>
              ))}
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Main layout */}
      <div className="max-w-[1600px] mx-auto px-4 py-6">
        <div className="grid grid-cols-1 xl:grid-cols-[1fr_420px] gap-6 items-start">
          {/* Board + Controls */}
          <div className="flex flex-col items-center gap-4">
            <div className="glass rounded-2xl p-3">
              <GoBoard
                key={`${selectedGameId}-${ply}`}
                analysis={analysis?.analysis ?? null}
                playerSide="black"
                onMove={() => {}}
                onPass={() => {}}
                onUndo={handlePrev}
                onResign={() => {}}
                lastMove={lastMove}
                moves={moveRecords}
                isPlayerTurn={false}
              />
            </div>

            {/* Playback controls */}
            <div className="w-full max-w-[680px] glass rounded-2xl p-4">
              <div className="flex items-center gap-3">
                <button
                  onClick={handlePrev}
                  disabled={ply === 0}
                  className="px-3 py-2 rounded-lg border border-silver-mid/30 text-silver-primary text-sm hover:bg-silver-mid/10 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
                >
                  ← 上一手
                </button>
                <button
                  onClick={() => setAutoPlay((v) => !v)}
                  disabled={isComplete}
                  className={`px-4 py-2 rounded-lg text-sm transition-colors ${
                    autoPlay
                      ? 'bg-cyan-500/20 border border-cyan-500/40 text-cyan-300'
                      : 'border border-silver-mid/30 text-silver-primary hover:bg-silver-mid/10'
                  } disabled:opacity-40 disabled:cursor-not-allowed`}
                >
                  {autoPlay ? '⏸ Pause' : '▶ Auto Play'}
                </button>
                <button
                  onClick={handleNext}
                  disabled={isComplete}
                  className="px-3 py-2 rounded-lg border border-silver-mid/30 text-silver-primary text-sm hover:bg-silver-mid/10 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
                >
                  下一手 →
                </button>
                <button
                  onClick={handleReset}
                  className="px-3 py-2 rounded-lg border border-silver-mid/30 text-silver-primary text-sm hover:bg-silver-mid/10 transition-colors"
                >
                  ⟲ 重置
                </button>
                <button
                  onClick={handleSkipToEnd}
                  className="px-3 py-2 rounded-lg border border-silver-mid/30 text-silver-primary text-sm hover:bg-silver-mid/10 transition-colors"
                >
                  ⏭ 跳到结尾
                </button>
                <div className="flex-1" />
                <div className="flex items-center gap-2 text-xs text-silver-dim">
                  <span>速度</span>
                  <select
                    value={autoPlaySpeed}
                    onChange={(e) => setAutoPlaySpeed(parseInt(e.target.value, 10))}
                    className="px-2 py-1 rounded bg-black-elevated border border-silver-mid/30 text-silver-primary"
                  >
                    <option value={500}>0.5s</option>
                    <option value={1000}>1s</option>
                    <option value={1500}>1.5s</option>
                    <option value={3000}>3s</option>
                  </select>
                </div>
              </div>
              <div className="mt-3 flex items-center justify-between text-xs text-silver-dim">
                <span>第 <strong className="text-silver-primary">{ply}</strong> / {game.totalMoves} 手</span>
                <span>
                  轮到: <strong className={currentColor === 'B' ? 'text-silver-primary' : 'text-silver-mid'}>{currentColor === 'B' ? '黑方' : '白方'}</strong>
                  {lastMove && (
                    <span className="ml-3 font-mono text-silver-mid">上一手: {lastMove}</span>
                  )}
                </span>
                {analysis?.classification && ply > 0 && ply <= game.totalMoves && (
                  <span
                    className="px-2 py-0.5 rounded font-medium"
                    style={{ color: analysis.classification.color, background: `${analysis.classification.color}15` }}
                  >
                    {analysis.classification.label}
                  </span>
                )}
              </div>
              {/* Progress bar */}
              <div className="mt-2 h-1 bg-black-elevated rounded-full overflow-hidden">
                <div
                  className="h-full bg-gradient-to-r from-cyan-500 to-blue-500 transition-all"
                  style={{ width: `${(ply / game.totalMoves) * 100}%` }}
                />
              </div>
            </div>

            {/* Win Rate + Top Candidates */}
            <div className="w-full max-w-[680px] grid grid-cols-1 sm:grid-cols-2 gap-4">
              <div className="glass rounded-2xl p-4">
                <div className="text-xs text-silver-dim uppercase tracking-wider mb-3">Win Rate · 从{perspectivePlayer}视角</div>
                <WinRateBar
                  value={analysis?.analysis.winRate ?? 0.5}
                  label={`${analysis ? Math.round(analysis.analysis.winRate * 100) : 50}%`}
                  sublabel={analysis?.analysis.scoreCp !== undefined ? `Lead ${analysis.analysis.scoreCp.toFixed(1)} 目` : '—'}
                />
              </div>
              <div className="glass rounded-2xl p-4">
                <div className="text-xs text-silver-dim uppercase tracking-wider mb-3">Top Candidates</div>
                <MoveList
                  lines={analysis?.analysis.multiPv ?? []}
                  variant="go"
                  onPick={() => {}}
                />
              </div>
            </div>

            {/* Why this move */}
            <div className="w-full max-w-[680px] glass rounded-2xl p-4">
              <div className="text-xs text-silver-dim uppercase tracking-wider mb-3">Why this move?</div>
              <Explanation analysis={analysis?.analysis ?? null} variant="go" />
            </div>
          </div>

          {/* Move History sidebar */}
          <div className="glass rounded-2xl p-4 max-h-[calc(100vh-180px)] overflow-y-auto">
            <div className="text-xs text-silver-dim uppercase tracking-wider mb-3">Move History</div>
            {moveRecords.length === 0 ? (
              <div className="text-silver-dim text-sm py-8 text-center">对局尚未开始</div>
            ) : (
              <div className="space-y-1 text-sm font-mono">
                {moveRecords.map((m, i) => {
                  const num = i + 1;
                  const isBlack = i % 2 === 0;
                  return (
                    <div key={i} className={`grid grid-cols-[28px_1fr] gap-2 py-1.5 px-2 rounded transition-colors ${
                      i === ply - 1 ? 'bg-cyan-500/10 border border-cyan-500/30' : 'hover:bg-silver-mid/5'
                    }`}>
                      <span className="text-silver-dim">{num}.</span>
                      <div className="flex items-baseline gap-1.5">
                        <span className="text-silver-mid text-xs w-6 shrink-0">{isBlack ? '●B' : '○W'}</span>
                        <span className="text-silver-primary">{m.san}</span>
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        </div>
      </div>
    </main>
  );
}
