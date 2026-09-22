'use client';

import { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { Chess } from 'chess.js';
import { ChessBoard } from './ChessBoard';
import { XiangqiBoard } from './XiangqiBoard';
import { GoBoard } from './GoBoard';
import { WinRateBar } from '../analysis/WinRateBar';
import { MoveList } from '../analysis/MoveList';
import { Explanation } from '../analysis/Explanation';
import { SideSelector } from '../side/SideSelector';
import { StyleSelector } from '../side/StyleSelector';
import { DualClock } from '../control/ChessClock';
import { checkChessGameOver, checkGoGameOver, checkXiangqiGameOver, GameOverResult } from '@/lib/rules/game-over';
import { classifyMoveList, ClassifiedMove, getClassificationColor, getClassificationLabel } from '@/lib/analysis/move-classification';
import { Analysis, GameVariant, MoveRecord, Side } from '@/lib/types';

const STARTING_FEN = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';

interface GameClientProps {
  variant: GameVariant;
  sides: readonly Side[];
  defaultSide: Side;
  engine: string;
}

const DEFAULT_TIME_CONTROL = {
  initialSec: 30 * 60,  // 30 min
  incrementSec: 10,      // 10 sec increment per move
};

export function GameClient({ variant, sides, defaultSide, engine }: GameClientProps) {
  const [playerSide, setPlayerSide] = useState<Side>(defaultSide);
  const [analysis, setAnalysis] = useState<Analysis | null>(null);
  const [ownership, setOwnership] = useState<number[][] | null>(null);
  const [moves, setMoves] = useState<MoveRecord[]>([]);
  const [engineStatus, setEngineStatus] = useState<'idle' | 'starting' | 'ready' | 'thinking' | 'errored'>('idle');
  const [error, setError] = useState<string | null>(null);
  const [boardKey, setBoardKey] = useState(0);
  const [currentFen, setCurrentFen] = useState(STARTING_FEN);
  const [styleId, setStyleId] = useState<string>('default');
  const [gameOver, setGameOver] = useState<GameOverResult | null>(null);
  const [showStyleTip, setShowStyleTip] = useState<string | null>(null);

  const eventSourceRef = useRef<EventSource | null>(null);
  const plyRef = useRef(0);
  const chessRef = useRef(new Chess());
  const aiPendingRef = useRef(false);
  const playerLockedRef = useRef(false);
  const initialGameStartedRef = useRef(false);
  const openingTriggeredRef = useRef(false);
  // Track consecutive passes for Go (game over = both pass)
  const consecutivePassesRef = useRef(0);
  // Always-current moves ref to avoid stale closure in aiMove callbacks
  const movesRef = useRef<typeof moves>(moves);
  movesRef.current = moves;
  // P1-1 fix: 缓存每步走子瞬间的 analysis snapshot,这样 classifyMoveList 用的是该步
  // 走完后的 analysis,而不是后续更新覆盖后的最新值。key = ply,value = Analysis at that ply.
  const analysisAtPlyRef = useRef<Map<number, typeof analysis>>(new Map());
  // AI's current analysis = top moves visible to player right now. We capture this
  // BEFORE applying a new move so the previous step's classification uses the AI's
  // recommendation at that moment.
  const analysisRef = useRef<typeof analysis>(null);
  analysisRef.current = analysis;
  // Always-current player side (used inside callbacks that already have movesRef)
  const playerSideRef = useRef<Side>(playerSide);
  playerSideRef.current = playerSide;

  /** 当前轮到谁 */
  const activeSide: 'player' | 'ai' = (() => {
    if (variant === 'go') {
      const playerColor: 'B' | 'W' = playerSide === 'black' ? 'B' : 'W';
      // 围棋: turn 在 derived 计算, 这里简化用 move 数 mod 2
      const nextIsB = moves.length % 2 === 0;
      return playerColor === 'B' ? (nextIsB ? 'player' : 'ai') : (nextIsB ? 'ai' : 'player');
    }
    if (variant === 'xiangqi') {
      // xiangqi: 红先
      const playerColor: 'red' | 'black' = playerSide === 'red' ? 'red' : 'black';
      const nextIsRed = moves.length % 2 === 0;
      return playerColor === 'red' ? (nextIsRed ? 'player' : 'ai') : (nextIsRed ? 'ai' : 'player');
    }
    // chess
    const playerColor: 'white' | 'black' = playerSide as 'white' | 'black';
    const nextIsWhite = moves.length % 2 === 0;
    return playerColor === 'white' ? (nextIsWhite ? 'player' : 'ai') : (nextIsWhite ? 'ai' : 'player');
  })();

  // 启动引擎
  const startEngine = useCallback(async () => {
    setEngineStatus('starting');
    setError(null);
    try {
      const r = await fetch('/api/engine/start', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ variant }),
      });
      const j = await r.json();
      if (!j.ok) throw new Error(j.error);
      if (j.data?.status === 'unavailable') {
        // Engine binaries missing — show friendly banner instead of crashing
        setEngineStatus('errored');
        setError(
          `${variant.toUpperCase()} engine is not available in this environment. ` +
            `Use Demo Mode at /${variant === 'go' ? 'go' : variant}-demo for offline play with pre-recorded analysis.`,
        );
        return;
      }
      // 启动后立即 apply default style (避免 first aiMove 用错 hint)
      await fetch('/api/engine/set-style', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ variant, styleId }),
      }).catch(() => {});
      setEngineStatus('ready');
    } catch (e: any) {
      setError(e.message);
      setEngineStatus('errored');
    }
  }, [variant, styleId]);

  // 切换棋手风格
  const applyStyle = useCallback(async (newStyleId: string) => {
    setStyleId(newStyleId);
    try {
      const r = await fetch('/api/engine/set-style', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ variant, styleId: newStyleId }),
      });
      const j = await r.json();
      if (j.ok && j.data?.description) {
        setShowStyleTip(j.data.styleNameCn + ' · ' + j.data.description.slice(0, 60));
        setTimeout(() => setShowStyleTip(null), 3000);
      }
    } catch (e: any) {
      setError(e.message);
    }
  }, [variant]);

  // 新对局
  const newGame = useCallback(async () => {
    try {
      await fetch('/api/engine/new-game', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ variant, fen: STARTING_FEN }),
      });
      chessRef.current.reset();
      setMoves([]);
      setAnalysis(null);
      setCurrentFen(STARTING_FEN);
      plyRef.current = 0;
      aiPendingRef.current = false;
      playerLockedRef.current = false;
      openingTriggeredRef.current = false;
      if (variant === 'go') consecutivePassesRef.current = 0;
      setBoardKey((k) => k + 1);
      setGameOver(null);
      setError(null);
      // 立即重应用当前风格
      await fetch('/api/engine/set-style', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ variant, styleId }),
      }).catch(() => {});
      startAnalysisStream();
    } catch (e: any) {
      setError(e.message);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [variant, styleId]);

  // 启动分析 SSE stream — 默认 depth=18 (平衡速度与质量), 无限搜索继续深化
  const startAnalysisStream = useCallback(() => {
    if (eventSourceRef.current) {
      eventSourceRef.current.close();
    }
    const url = `/api/engine/analyze?variant=${variant}&depth=18&multipv=3`;
    const es = new EventSource(url);
    eventSourceRef.current = es;
    es.onopen = () => {
      // 连接建立后立即把 UI 从 'starting' 切到 'thinking', 给用户即时反馈
      setEngineStatus('thinking');
      setError(null);
    };
    es.onmessage = (e) => {
      try {
        const data = JSON.parse(e.data);
        if (data.ok && data.analysis) {
          setAnalysis(data.analysis);
          setEngineStatus('thinking');
        } else if (!data.ok) {
          setError(data.error);
        }
      } catch (err) {
        console.warn('SSE parse error:', err);
      }
    };
    es.onerror = () => {
      setEngineStatus('ready');
    };
    // P1-7 fix: Handle named 'ownership' SSE event from analyze route.
    // After kata-analyze completes, the SSE route calls kata-ownership and sends the result
    // as a named event. This updates the GoBoard heatmap without re-triggering analysis.
    es.addEventListener('ownership', (e) => {
      try {
        const { ownership } = JSON.parse(e.data);
        setOwnership(ownership);
      } catch {}
    });
  }, [variant]);

  // Request KataGo territory scoring (for Go double-pass end game)
  const requestGoFinalScore = useCallback(async () => {
    if (variant !== 'go') return;
    try {
      const r = await fetch('/api/engine/final-score', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ variant }),
      });
      const j = await r.json();
      if (j.ok && j.data?.score) {
        const s = j.data.score;
        const winner: 'player' | 'ai' | 'draw' =
          s.winner === '?' ? 'draw' :
          (playerSide === 'black' ? (s.winner === 'B' ? 'player' : 'ai') :
            (s.winner === 'W' ? 'player' : 'ai'));
        if (s.resign) {
          // Resignation: winner won by resignation
          setGameOver({
            over: true,
            reason: 'resign',
            winner,
            detail: winner === 'player' ? '对手认输 · 你赢了' : '你认输 · AI 赢了',
          });
        } else if (s.winner === '?' || s.score === 0) {
          setGameOver({ over: true, reason: 'pass-tied', winner: 'draw', detail: '和棋' });
        } else {
          // Territory scoring
          const komi = 7.5;
          const adjustedScore = s.score - (s.winner === 'W' ? komi : 0);
          setGameOver({
            over: true,
            reason: 'points',
            winner,
            detail: s.winner === 'B'
              ? `黑胜 ${Math.abs(adjustedScore).toFixed(1)} 目`
              : `白胜 ${Math.abs(adjustedScore).toFixed(1)} 目(含7.5目贴目)`,
          });
        }
      } else {
        // Fallback: show draw
        setGameOver({ over: true, reason: 'pass-tied', winner: 'draw', detail: '双 Pass · 终局计分失败，显示和棋' });
      }
    } catch {
      setGameOver({ over: true, reason: 'pass-tied', winner: 'draw', detail: '双 Pass · 计分请求失败' });
    }
  }, [variant, playerSide]);
  const aiMove = useCallback(async () => {
    if (aiPendingRef.current) return;
    if (gameOver?.over) return;
    aiPendingRef.current = true;
    setEngineStatus('thinking');
    try {
      eventSourceRef.current?.close();
      eventSourceRef.current = null;
      // For Go AI Server: pass the full GTP move sequence so it knows the position
      // Use movesRef to avoid stale closure (moves updates before setTimeout fires)
      const goMovesForServer = variant === 'go'
        ? movesRef.current.map((m) => m.move)
        : undefined;
      // Determine player color for Go AI server
      const goColor: 'B' | 'W' = variant === 'go'
        ? (playerSideRef.current === 'black' ? (movesRef.current.length % 2 === 0 ? 'B' : 'W') : (movesRef.current.length % 2 === 0 ? 'W' : 'B'))
        : 'B';
      const r = await fetch('/api/engine/move', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          variant,
          move: 'auto',
          timeMs: variant === 'go' ? 60000 : 15000, // Go gets 60s for 8000 visits
          styleId,
          goMoves: goMovesForServer,
          color: goColor,
        }),
      });
      const j = await r.json();
      if (!j.ok) { setError(j.error); setEngineStatus('errored'); return; }
      const aiMoveStr = j.data?.aiMove;
      if (!aiMoveStr) { setError('AI could not generate a move'); return; }
      plyRef.current++;
      if (variant === 'chess') {
        try {
          chessRef.current.move(aiMoveStr);
          setCurrentFen(chessRef.current.fen());
          // 立即检查终局
          const over = checkChessGameOver(chessRef.current);
          if (over.over) setGameOver(over);
        } catch {
          console.warn('chess.js rejected AI move:', aiMoveStr);
        }
      }
      setMoves((prev) => [
        ...prev,
        { ply: plyRef.current, move: aiMoveStr, san: aiMoveStr, winRate: analysis?.winRate },
      ]);
      // P1-1 fix: 缓存本步之前的 analysis snapshot → 该步的分类用此值而非后续覆盖。
      analysisAtPlyRef.current.set(plyRef.current, analysis ?? null);
      // Go 终局检测 — 用 consecutivePassesRef 追踪连续 pass，双 pass 时请求 KataGo 计分
      if (variant === 'go') {
        if (aiMoveStr === 'pass') {
          consecutivePassesRef.current++;
        } else {
          consecutivePassesRef.current = 0;
        }
        if (consecutivePassesRef.current >= 2) {
          await requestGoFinalScore();
        } else {
          const over = checkGoGameOver([...moves, aiMoveStr].map((m) => m.move));
          if (over.over) setGameOver(over);
        }
      }
      if (variant === 'xiangqi') {
        const over = checkXiangqiGameOver([...moves, aiMoveStr].map((m) => m.move));
        if (over.over) setGameOver(over);
      }
      startAnalysisStream();
    } catch (e: any) {
      setError(e.message);
    } finally {
      aiPendingRef.current = false;
      setEngineStatus('ready');
    }
  }, [analysis, variant, styleId, gameOver, moves, startAnalysisStream, requestGoFinalScore]);

  // 用户落子
  const onUserMove = useCallback(
    async (move: string, san: string) => {
      if (playerLockedRef.current) return;
      if (gameOver?.over) return;
      playerLockedRef.current = true;
      try {
        if (variant === 'chess') {
          const applied = chessRef.current.move(move);
          if (!applied) { playerLockedRef.current = false; return; }
          setCurrentFen(chessRef.current.fen());
          // 检查终局
          const over = checkChessGameOver(chessRef.current);
          if (over.over) {
            setGameOver(over);
            playerLockedRef.current = false;
            return;
          }
        }
        const r = await fetch('/api/engine/move', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ variant, move }),
        });
        const j = await r.json();
        if (!j.ok) { setError(j.error); playerLockedRef.current = false; return; }
        if (!j.data?.legal) {
          if (variant === 'chess') {
            chessRef.current.undo();
            setCurrentFen(chessRef.current.fen());
          }
          setError(`无效着法: ${move}，请按棋盘提示落子`);
          playerLockedRef.current = false;
          return;
        }
        plyRef.current++;
        const record: MoveRecord = {
          ply: plyRef.current,
          move,
          san,
          winRate: analysis?.winRate,
          scoreCp: analysis?.scoreCp,
        };
        if (variant === 'go') consecutivePassesRef.current = 0;
        // P1-1 fix: 缓存本步之前的 analysis snapshot → 该步的分类用此值。
        analysisAtPlyRef.current.set(plyRef.current, analysis ?? null);
        setMoves((prev) => [...prev, record]);
        startAnalysisStream();
        // AI 回应
        setTimeout(() => aiMove().finally(() => { playerLockedRef.current = false; }), 50);
      } catch (e: any) {
        setError(e.message);
        playerLockedRef.current = false;
      }
    },
    [variant, analysis, aiMove, startAnalysisStream, gameOver],
  );

  // 悔棋
  const onUndo = useCallback(async () => {
    if (playerLockedRef.current) return;
    if (gameOver?.over) return;
    playerLockedRef.current = true;
    try {
      const undoCount = 2;
      let lastError: string | null = null;
      let okCount = 0;
      for (let i = 0; i < undoCount; i++) {
        const r = await fetch('/api/engine/move', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ variant, move: 'undo' }),
        });
        const j = await r.json();
        if (!j.ok) { lastError = j.error; break; }
        if (!j.data?.legal) { lastError = '已经到最初局面'; break; }
        okCount++;
      }
      if (okCount === 0) {
        setError(lastError || '悔棋失败');
        playerLockedRef.current = false;
        return;
      }
      for (let i = 0; i < okCount; i++) chessRef.current.undo();
      if (chessRef.current.history().length === 0) chessRef.current.reset();
      setCurrentFen(chessRef.current.fen());
      setMoves((prev) => prev.slice(0, -okCount));
      plyRef.current = Math.max(0, plyRef.current - okCount);
      if (variant === 'go') consecutivePassesRef.current = 0;
      setGameOver(null);
      startAnalysisStream();
    } catch (e: any) {
      setError(e.message);
    } finally {
      playerLockedRef.current = false;
    }
  }, [variant, startAnalysisStream, gameOver]);

  const onPass = useCallback(async () => {
    if (playerLockedRef.current) return;
    if (gameOver?.over) return;
    playerLockedRef.current = true;
    // Track consecutive passes for Go double-pass detection
    if (variant === 'go') consecutivePassesRef.current++;
    try {
      const r = await fetch('/api/engine/move', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ variant, move: 'pass' }),
      });
      const j = await r.json();
      if (!j.ok) { setError(j.error); playerLockedRef.current = false; return; }
      plyRef.current++;
      setMoves((prev) => [...prev, { ply: plyRef.current, move: 'pass', san: 'Pass' }]);
      startAnalysisStream();
      setTimeout(() => aiMove().finally(() => { playerLockedRef.current = false; }), 50);
    } catch (e: any) {
      setError(e.message);
      playerLockedRef.current = false;
    }
  }, [variant, aiMove, startAnalysisStream, gameOver]);

  const onResign = useCallback(async () => {
    if (typeof window !== 'undefined' && !window.confirm('确认认输？')) return;
    setGameOver({ over: true, reason: 'resign', winner: 'ai', detail: '你认输了 · AI 赢了' });
    setMoves((prev) => [...prev, { ply: plyRef.current + 1, move: 'resign', san: '认输', comment: '玩家认输' }]);
  }, []);

  useEffect(() => {
    startEngine();
    return () => {
      eventSourceRef.current?.close();
      fetch('/api/engine/stop', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ variant }),
      }).catch(() => {});
    };
  }, [startEngine, variant]);

  useEffect(() => {
    if (engineStatus === 'ready' && !initialGameStartedRef.current) {
      initialGameStartedRef.current = true;
      newGame();
    }
  }, [engineStatus, newGame]);

  // 当 playerSide 改变 (用户选边),如果引擎已经 ready 且未开始,触发 newGame
  const sideChangeRef = useRef<string>(playerSide);
  useEffect(() => {
    if (sideChangeRef.current !== playerSide && engineStatus === 'ready') {
      sideChangeRef.current = playerSide;
      newGame();
    }
  }, [playerSide, engineStatus, newGame]);

  // 后手模式的开局着法由 AI 自动生成，确保三种棋都能直接进入人机对弈。
  useEffect(() => {
    if (engineStatus !== 'ready' || !initialGameStartedRef.current || moves.length !== 0 || activeSide !== 'ai' || openingTriggeredRef.current) return;
    openingTriggeredRef.current = true;
    void aiMove();
  }, [activeSide, aiMove, engineStatus, moves.length]);

  // 选手标签
  const playerLabel = (() => {
    if (variant === 'go') return playerSide === 'black' ? '你 (黑)' : '你 (白)';
    if (variant === 'xiangqi') return playerSide === 'red' ? '你 (红)' : '你 (黑)';
    return playerSide === 'white' ? '你 (白)' : '你 (黑)';
  })();
  const aiLabel = (() => {
    if (variant === 'go') return playerSide === 'black' ? 'AI (白)' : 'AI (黑)';
    if (variant === 'xiangqi') return playerSide === 'red' ? 'AI (黑)' : 'AI (红)';
    return playerSide === 'white' ? 'AI (黑)' : 'AI (白)';
  })();
  const playerFlag = variant === 'go' ? 'GO' : variant === 'xiangqi' ? 'CN' : 'CN';
  const aiFlag = styleId === 'default' ? 'AI' : styleId.toUpperCase().slice(0, 4);

  const moveClassifications = useMemo(() => {
    // P1-1 fix: 用每步走子瞬间 (即 SSE 之前) 的 analysis snapshot 分类。
    // 捕获策略: 在 onUserMove / aiMove 里,向 server 发送着法前,把当时的
    // analysis 存进 analysisAtPlyRef[ply]。这样 classify 拿到的就是该步
    // 走子前引擎推荐的 top moves,而非后续 SSE 更新覆盖后的最新值。
    return classifyMoveList(
      moves.map((m) => {
        // m.ply 对应的 analysis = 走该步前引擎推荐的 top moves
        const a = analysisAtPlyRef.current.get(m.ply) ?? analysisRef.current ?? null;
        return {
          move: m.move,
          san: m.san,
          winRate: m.winRate,
          scoreCp: m.scoreCp,
          scoreLead: m.scoreLead,
          analysisMultiPv: a?.multiPv?.map((p) => p.move),
          variant,
        };
      }),
      {
        // 简单棋谱标签: 前 8 着视为定式 (Book)
        isBookMove: (_m, i) => i < 8 && variant !== 'chess',
      },
    );
  }, [moves, variant]);

  return (
    <main className="min-h-screen bg-black-deep">
      {/* Top Bar */}
      <header className="relative z-40 border-b border-silver-border bg-black-rich/80 backdrop-blur-xl">
        <div className="max-w-[1600px] mx-auto px-6 py-4 flex items-center justify-between">
          <div className="flex items-center gap-4">
            <a href="/" className="text-silver-mid hover:text-silver-primary transition-colors text-sm">
              ← Back
            </a>
            <div className="w-px h-6 bg-silver-border" />
            <div>
              <h1 className="text-silver-primary font-medium">{variantLabel(variant)}</h1>
              <p className="text-silver-dim text-xs mt-0.5">
                {engine} · {engineStatus === 'thinking' ? (
                  <span className="inline-flex items-center gap-1">
                    <span className="thinking-dot">●</span>
                    <span className="thinking-dot">●</span>
                    <span className="thinking-dot">●</span>
                    Analyzing
                  </span>
                ) : engineStatus === 'ready' ? 'Ready' : engineStatus}
              </p>
            </div>
          </div>
          <div className="flex items-center gap-3">
            <StyleSelector variant={variant} value={styleId} onChange={applyStyle} />
            <SideSelector variant={variant} sides={sides} value={playerSide} onChange={setPlayerSide} />
            <button
              onClick={newGame}
              className="px-4 py-2 rounded-lg border border-silver-mid/30 text-silver-primary text-sm hover:bg-silver-mid/10 transition-colors"
            >
              New Game
            </button>
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

      {/* Error banner */}
      {error && (
        <div className="bg-red-500/10 border-b border-red-500/30 px-6 py-3 text-red-300 text-sm">
          {error}
          <button onClick={() => setError(null)} className="ml-4 text-red-400 underline">Dismiss</button>
        </div>
      )}

      {/* Game Over overlay */}
      <AnimatePresence>
        {gameOver?.over && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="fixed inset-0 z-40 bg-black/70 backdrop-blur-md flex items-center justify-center"
          >
            <motion.div
              initial={{ scale: 0.8, opacity: 0 }}
              animate={{ scale: 1, opacity: 1 }}
              exit={{ scale: 0.8, opacity: 0 }}
              transition={{ duration: 0.3 }}
              className="glass rounded-2xl p-8 max-w-md text-center border border-silver-mid/30 shadow-2xl"
            >
              <div className="text-5xl mb-4">
                {gameOver.winner === 'player' ? '🏆' : gameOver.winner === 'ai' ? '💀' : '🤝'}
              </div>
              <div className={`text-2xl font-light mb-2 ${
                gameOver.winner === 'player' ? 'text-green-400' :
                gameOver.winner === 'ai' ? 'text-red-400' : 'text-amber-400'
              }`}>
                {gameOver.winner === 'player' ? '你赢了!' : gameOver.winner === 'ai' ? 'AI 赢了' : '和棋'}
              </div>
              <div className="text-silver-mid text-sm mb-6">{gameOver.detail}</div>
              <div className="text-silver-dim text-xs mb-4">着法总数: {moves.length}</div>
              <button
                onClick={() => { setGameOver(null); newGame(); }}
                className="px-6 py-2.5 rounded-xl bg-silver-mid/15 border border-silver-mid/40 text-silver-primary hover:bg-silver-mid/25 transition-colors"
              >
                再来一局
              </button>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Main Game Layout */}
      {/* Layout decisions:
          - <xl (≥1280px): 3 columns [board 1fr] [analysis 420px] [history 360px]
            Board column has min-w-0 so the SVG inside can shrink to fit,
            and the SVG is responsive (see GoBoard / ChessBoard / XiangqiBoard).
          - <lg: 2 columns: board + history, analysis stacks below
          - <lg: single column */}
      <div className="max-w-[1600px] mx-auto px-4 py-6">
        {/* Desktop 3-col */}
        <div className="hidden xl:grid grid-cols-[minmax(0,1fr)_420px_360px] gap-6 items-start">
          <div className="flex justify-center">
            <motion.div
              initial={{ opacity: 0, scale: 0.95 }}
              animate={{ opacity: 1, scale: 1 }}
              transition={{ duration: 0.4 }}
              className="glass rounded-2xl p-4 w-full flex justify-center"
            >
              {variant === 'chess' && (
                <ChessBoard
                  key={boardKey}
                  analysis={analysis}
                  playerSide={playerSide as 'white' | 'black'}
                  onMove={onUserMove}
                  lastMove={moves.length > 0 ? moves[moves.length - 1].move : null}
                  fen={currentFen}
                  isPlayerTurn={activeSide === 'player'}
                />
              )}
              {variant === 'xiangqi' && (
                <XiangqiBoard
                  key={boardKey}
                  analysis={analysis}
                  playerSide={playerSide as 'red' | 'black'}
                  onMove={onUserMove}
                  lastMove={moves.length > 0 ? moves[moves.length - 1].move : null}
                  moves={moves}
                  isPlayerTurn={activeSide === 'player'}
                />
              )}
              {variant === 'go' && (
                <GoBoard
                  key={boardKey}
                  analysis={analysis}
                  ownership={ownership}
                  playerSide={playerSide as 'black' | 'white'}
                  onMove={onUserMove}
                  onPass={onPass}
                  onResign={onResign}
                  onUndo={onUndo}
                  lastMove={moves.length > 0 ? moves[moves.length - 1].move : null}
                  moves={moves}
                  isPlayerTurn={activeSide === 'player'}
                />
              )}
            </motion.div>
          </div>

          {/* Analysis Panel */}
          <div className="space-y-4">
            <DualClock
              activeSide={activeSide}
              playerSec={DEFAULT_TIME_CONTROL.initialSec}
              aiSec={DEFAULT_TIME_CONTROL.initialSec}
              playerLabel={playerLabel}
              aiLabel={`${aiLabel} · ${styleId !== 'default' ? styleId.toUpperCase().slice(0, 8) : 'AI'}`}
              playerFlag={playerFlag}
              aiFlag={aiFlag}
              paused={gameOver?.over ?? false}
            />

            <div className="glass rounded-2xl p-5">
              <div className="text-xs text-silver-dim uppercase tracking-wider mb-3">Win Rate · From Your Side</div>
              <WinRateBar
                value={analysis?.winRate ?? 0.5}
                label={`${analysis ? Math.round(analysis.winRate * 100) : 50}%`}
                sublabel={analysis?.scoreCp !== undefined ? formatScore(analysis.scoreCp) : '—'}
              />
            </div>

            <div className="glass rounded-2xl p-5">
              <div className="text-xs text-silver-dim uppercase tracking-wider mb-3">Top Candidates</div>
              <MoveList
                lines={analysis?.multiPv ?? []}
                variant={variant}
                onPick={(move) => onUserMove(move, move)}
              />
            </div>

            <div className="glass rounded-2xl p-5">
              <div className="text-xs text-silver-dim uppercase tracking-wider mb-3">Why this move?</div>
              <Explanation analysis={analysis} variant={variant} />
            </div>
          </div>

          {/* Move History */}
          <div className="glass rounded-2xl p-5 max-h-[calc(100vh-180px)] overflow-y-auto">
            <div className="text-xs text-silver-dim uppercase tracking-wider mb-3">Move History</div>
            <MoveHistory moves={moves} variant={variant} classifications={moveClassifications} />
          </div>
        </div>

        {/* Tablet 2-col: board + analysis below, history right */}
        <div className="hidden lg:grid xl:hidden grid-cols-[minmax(0,1fr)_340px] gap-6 items-start">
          <div className="flex flex-col items-center gap-4">
            <motion.div
              initial={{ opacity: 0, scale: 0.95 }}
              animate={{ opacity: 1, scale: 1 }}
              transition={{ duration: 0.4 }}
              className="glass rounded-2xl p-4 w-full flex justify-center"
            >
              {variant === 'chess' && (
                <ChessBoard
                  key={boardKey}
                  analysis={analysis}
                  playerSide={playerSide as 'white' | 'black'}
                  onMove={onUserMove}
                  lastMove={moves.length > 0 ? moves[moves.length - 1].move : null}
                  fen={currentFen}
                  isPlayerTurn={activeSide === 'player'}
                />
              )}
              {variant === 'xiangqi' && (
                <XiangqiBoard
                  key={boardKey}
                  analysis={analysis}
                  playerSide={playerSide as 'red' | 'black'}
                  onMove={onUserMove}
                  lastMove={moves.length > 0 ? moves[moves.length - 1].move : null}
                  moves={moves}
                  isPlayerTurn={activeSide === 'player'}
                />
              )}
              {variant === 'go' && (
                <GoBoard
                  key={boardKey}
                  analysis={analysis}
                  ownership={ownership}
                  playerSide={playerSide as 'black' | 'white'}
                  onMove={onUserMove}
                  onPass={onPass}
                  onResign={onResign}
                  onUndo={onUndo}
                  lastMove={moves.length > 0 ? moves[moves.length - 1].move : null}
                  moves={moves}
                  isPlayerTurn={activeSide === 'player'}
                />
              )}
            </motion.div>

            {/* Analysis under board on tablet */}
            <div className="w-full max-w-[680px] grid grid-cols-1 sm:grid-cols-2 gap-4">
              <div className="glass rounded-2xl p-4">
                <div className="text-xs text-silver-dim uppercase tracking-wider mb-3">Win Rate · From Your Side</div>
                <WinRateBar
                  value={analysis?.winRate ?? 0.5}
                  label={`${analysis ? Math.round(analysis.winRate * 100) : 50}%`}
                  sublabel={analysis?.scoreCp !== undefined ? formatScore(analysis.scoreCp) : '—'}
                />
              </div>
              <div className="glass rounded-2xl p-4">
                <div className="text-xs text-silver-dim uppercase tracking-wider mb-3">Top Candidates</div>
                <MoveList
                  lines={analysis?.multiPv ?? []}
                  variant={variant}
                  onPick={(move) => onUserMove(move, move)}
                />
              </div>
            </div>

            <div className="w-full max-w-[680px] glass rounded-2xl p-4">
              <div className="text-xs text-silver-dim uppercase tracking-wider mb-3">Why this move?</div>
              <Explanation analysis={analysis} variant={variant} />
            </div>
          </div>

          {/* Move History right on tablet */}
          <div className="glass rounded-2xl p-4 max-h-[calc(100vh-180px)] overflow-y-auto">
            <div className="text-xs text-silver-dim uppercase tracking-wider mb-3">Move History</div>
            <MoveHistory moves={moves} variant={variant} classifications={moveClassifications} />
          </div>
        </div>

        {/* Mobile: single column */}
        <div className="lg:hidden flex flex-col items-center gap-4 px-2">
          <motion.div
            initial={{ opacity: 0, scale: 0.95 }}
            animate={{ opacity: 1, scale: 1 }}
            transition={{ duration: 0.4 }}
            className="glass rounded-2xl p-3 w-full flex justify-center"
          >
            {variant === 'chess' && (
              <ChessBoard
                key={boardKey}
                analysis={analysis}
                playerSide={playerSide as 'white' | 'black'}
                onMove={onUserMove}
                lastMove={moves.length > 0 ? moves[moves.length - 1].move : null}
                fen={currentFen}
                isPlayerTurn={activeSide === 'player'}
              />
            )}
            {variant === 'xiangqi' && (
              <XiangqiBoard
                key={boardKey}
                analysis={analysis}
                playerSide={playerSide as 'red' | 'black'}
                onMove={onUserMove}
                lastMove={moves.length > 0 ? moves[moves.length - 1].move : null}
                moves={moves}
                isPlayerTurn={activeSide === 'player'}
              />
            )}
            {variant === 'go' && (
              <GoBoard
                key={boardKey}
                analysis={analysis}
                ownership={ownership}
                playerSide={playerSide as 'black' | 'white'}
                onMove={onUserMove}
                onPass={onPass}
                onResign={onResign}
                onUndo={onUndo}
                lastMove={moves.length > 0 ? moves[moves.length - 1].move : null}
                moves={moves}
                isPlayerTurn={activeSide === 'player'}
              />
            )}
          </motion.div>

          <div className="w-full max-w-[680px] glass rounded-2xl p-4">
            <div className="text-xs text-silver-dim uppercase tracking-wider mb-3">Top Candidates</div>
            <MoveList
              lines={analysis?.multiPv ?? []}
              variant={variant}
              onPick={(move) => onUserMove(move, move)}
            />
          </div>

          <div className="w-full max-w-[680px] glass rounded-2xl p-4">
            <div className="text-xs text-silver-dim uppercase tracking-wider mb-3">Win Rate · From Your Side</div>
            <WinRateBar
              value={analysis?.winRate ?? 0.5}
              label={`${analysis ? Math.round(analysis.winRate * 100) : 50}%`}
              sublabel={analysis?.scoreCp !== undefined ? formatScore(analysis.scoreCp) : '—'}
            />
          </div>

          <div className="w-full max-w-[680px] glass rounded-2xl p-4">
            <div className="text-xs text-silver-dim uppercase tracking-wider mb-3">Why this move?</div>
            <Explanation analysis={analysis} variant={variant} />
          </div>

          <div className="w-full max-w-[680px] glass rounded-2xl p-4 max-h-[40vh] overflow-y-auto">
            <div className="text-xs text-silver-dim uppercase tracking-wider mb-3">Move History</div>
            <MoveHistory moves={moves} variant={variant} classifications={moveClassifications} />
          </div>
        </div>
      </div>
    </main>
  );
}

function variantLabel(v: GameVariant) {
  if (v === 'chess') return 'Chess · 国际象棋';
  if (v === 'xiangqi') return 'Xiangqi · 中国象棋';
  return 'Go · 围棋';
}

function formatScore(cp: number): string {
  if (Math.abs(cp) > 9000) return cp > 0 ? '+M' : '-M';
  const pawns = cp / 100;
  return `${pawns >= 0 ? '+' : ''}${pawns.toFixed(2)}`;
}

function MoveHistory({ moves, variant, classifications }: { moves: MoveRecord[]; variant: GameVariant; classifications?: ClassifiedMove[] }) {
  if (moves.length === 0) {
    return <div className="text-silver-dim text-sm py-8 text-center">No moves yet</div>;
  }
  const pairs: [MoveRecord, MoveRecord | null, ClassifiedMove | null, ClassifiedMove | null][] = [];
  for (let i = 0; i < moves.length; i += 2) {
    pairs.push([
      moves[i],
      moves[i + 1] ?? null,
      classifications?.[i] ?? null,
      classifications?.[i + 1] ?? null,
    ]);
  }
  return (
    <div className="space-y-1 text-sm font-mono">
      {pairs.map(([m1, m2, c1, c2], idx) => (
        <div key={idx} className="grid grid-cols-[28px_1fr_1fr] gap-2 py-1.5 px-2 rounded hover:bg-silver-mid/5">
          <span className="text-silver-dim">{idx + 1}.</span>
          <div className="flex items-baseline gap-1.5">
            <span className="text-silver-primary">{m1.san}</span>
            {c1 && (
              <span
                className="text-[10px] px-1 py-0.5 rounded font-bold"
                style={{ color: getClassificationColor(c1.classification), background: `${getClassificationColor(c1.classification)}15` }}
                title={c1.description}
              >
                {c1.label}
              </span>
            )}
          </div>
          {m2 ? (
            <div className="flex items-baseline gap-1.5">
              <span className="text-silver-primary">{m2.san}</span>
              {c2 && (
                <span
                  className="text-[10px] px-1 py-0.5 rounded font-bold"
                  style={{ color: getClassificationColor(c2.classification), background: `${getClassificationColor(c2.classification)}15` }}
                  title={c2.description}
                >
                  {c2.label}
                </span>
              )}
            </div>
          ) : (
            <span />
          )}
        </div>
      ))}
    </div>
  );
}
