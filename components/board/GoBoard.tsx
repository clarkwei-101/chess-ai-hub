'use client';

import { useMemo, useState, useEffect } from 'react';
import { Analysis, MoveRecord } from '@/lib/types';
import { GoBoard as GoBoardType, GoStone, goInitialBoard, isLegalGoMove, applyGoMove, coordToGtp } from '@/lib/rules/go';

interface GoBoardProps {
  analysis: Analysis | null;
  /** Ownership heatmap from kata-ownership (P1-7 fix: separate SSE event after kata-analyze completes) */
  ownership?: number[][] | null;
  playerSide: 'black' | 'white';
  onMove: (move: string, san: string) => void;
  lastMove: string | null;
  /** Move history — 用来同步 AI 走子后的本地局面 (围棋引擎在自己内存维护 board,UI 必须 replay) */
  moves?: MoveRecord[];
  /** Optional: invoked when user clicks Pass. Engine-side "pass" move will be sent. */
  onPass?: () => void;
  /** Optional: invoked when user clicks Resign. */
  onResign?: () => void;
  /** Optional: invoked when user clicks Undo. Pops the local move history (server state must also undo). */
  onUndo?: () => void;
  /** True when it's the user's turn — prevents accidental clicks during AI thinking. */
  isPlayerTurn?: boolean;
}

// Responsive sizing: native 664x664 viewBox, but rendered to fill the
// parent column. At <sm viewports the parent scales the container down
// (CSS scale transform) so the board never overflows or hides controls.
const BOARD_SIZE = 19;
const CELL = 32;
const MARGIN = 28;
const SIZE = BOARD_SIZE * CELL + 2 * MARGIN;

/** 从 GTP 顶点字符串 (e.g. "Q16", "PASS") 解码到 (row, col) */
function gtpToCoord(move: string): { row: number; col: number } | null {
  if (!move || move === 'pass' || move === 'resign') return null;
  const colChar = move[0]?.toUpperCase();
  if (!colChar) return null;
  let col = colChar.charCodeAt(0) - 'A'.charCodeAt(0);
  if (colChar >= 'I') col--;
  if (col < 0 || col >= BOARD_SIZE) return null;
  const rowNum = parseInt(move.slice(1), 10);
  if (isNaN(rowNum) || rowNum < 1 || rowNum > BOARD_SIZE) return null;
  return { row: rowNum - 1, col };
}

export function GoBoard({ analysis, ownership, playerSide, onMove, lastMove, moves, onPass, onResign, onUndo, isPlayerTurn }: GoBoardProps) {
  // 派生 board: 从 moves 列表回放 (保证用户和 AI 的着法都同步到 UI)
  const derived = useMemo(() => {
    let b: GoBoardType = goInitialBoard(BOARD_SIZE);
    let koPt: { r: number; c: number } | undefined = undefined;
    const captured: { B: number; W: number } = { B: 0, W: 0 };
    let nextTurn: 'B' | 'W' = 'B';
    if (moves && moves.length > 0) {
      for (const m of moves) {
        const coord = gtpToCoord(m.move);
        if (coord) {
          // applyGoMove 根据当前局面自动计算 koPoint; 不需要把上一手 koPt 传进去
          const result = applyGoMove(b, nextTurn, coord.row, coord.col);
          b = result.board;
          if (result.captured.length > 0) {
            captured[nextTurn] += result.captured.length;
          }
          koPt = result.koPoint;
          nextTurn = nextTurn === 'B' ? 'W' : 'B';
        } else if (m.move === 'pass') {
          nextTurn = nextTurn === 'B' ? 'W' : 'B';
          koPt = undefined;
        } else {
          // resign / 未知 — 跳过 (局面不变)
          break;
        }
      }
    }
    return { board: b, koPoint: koPt, captured, turn: nextTurn };
  }, [moves]);

  const [board, setBoard] = useState<GoBoardType>(derived.board);
  const [hover, setHover] = useState<{ r: number; c: number } | null>(null);
  const [turn, setTurn] = useState<'B' | 'W'>(derived.turn);
  const [koPoint, setKoPoint] = useState<{ r: number; c: number } | undefined>(derived.koPoint);
  const [captured, setCaptured] = useState<{ B: number; W: number }>(derived.captured);
  // P0-2 fix: 从 moves 列表 derive 连续 pass 计数 (永远跟着 derived 同步)
  const consecutivePasses = useMemo(() => {
    if (!moves || moves.length === 0) return 0;
    let count = 0;
    for (let i = moves.length - 1; i >= 0; i--) {
      if (moves[i].move === 'pass') count++;
      else break;
    }
    return count;
  }, [moves]);

  // 当 derived 变化 (外部 moves 更新) 时,同步本地 state
  useEffect(() => {
    setBoard(derived.board);
    setTurn(derived.turn);
    setKoPoint(derived.koPoint);
    setCaptured(derived.captured);
  }, [derived]);

  const playerColor: 'B' | 'W' = playerSide === 'black' ? 'B' : 'W';

  const lastCoord = useMemo(() => {
    if (!lastMove || lastMove === 'pass' || lastMove === 'resign') return null;
    const colChar = lastMove[0]?.toUpperCase();
    if (!colChar || colChar === 'I') return null;
    let col = colChar.charCodeAt(0) - 'A'.charCodeAt(0);
    if (colChar > 'I') col--;
    const row = parseInt(lastMove.slice(1), 10) - 1;
    if (isNaN(row) || row < 0 || row >= BOARD_SIZE) return null;
    if (col < 0 || col >= BOARD_SIZE) return null;
    return { row, col };
  }, [lastMove]);

  // KataGo policy 最大值 (用于归一化热力图强度)
  const policyMax = useMemo(() => {
    const p = analysis?.policy;
    if (!p) return 0;
    let m = 0;
    for (const row of p) for (const v of row) if (v > m) m = v;
    return m;
  }, [analysis?.policy]);

  // 推荐着法坐标
  const bestCoord = useMemo(() => {
    const m = analysis?.multiPv[0]?.move;
    if (!m || m === 'pass' || m === 'resign') return null;
    const colChar = m[0]?.toUpperCase();
    if (!colChar || colChar === 'I') return null;
    let col = colChar.charCodeAt(0) - 'A'.charCodeAt(0);
    if (colChar > 'I') col--;
    const row = parseInt(m.slice(1), 10) - 1;
    if (isNaN(row) || row < 0 || row >= BOARD_SIZE) return null;
    if (col < 0 || col >= BOARD_SIZE) return null;
    return { row, col };
  }, [analysis?.multiPv]);

  // 非法 hover (打劫点) — 给红色边框
  const isIllegal = (r: number, c: number): boolean => {
    if (board[r][c] !== null) return true;
    if (koPoint && koPoint.r === r && koPoint.c === c) return true;
    // 自杀
    if (!isLegalGoMove(board, turn, r, c, koPoint)) return true;
    return false;
  };

  function handleClick(r: number, c: number) {
    if (isPlayerTurn !== undefined && !isPlayerTurn) return;
    if (turn !== playerColor) return;
    if (isIllegal(r, c)) return;
    // 不直接更新本地 board — 让 parent 通过 moves prop 触发 derived 重算后由 useEffect 同步,
    // 这样 AI 和玩家的着法都走同一条路径,保证 UI 与 engine 永远一致
    onMove(coordToGtp(r, c), coordToGtp(r, c));
  }

  function handlePass() {
    if (isPlayerTurn !== undefined && !isPlayerTurn) return;
    if (turn !== playerColor) return;
    onPass?.();
  }

  function handleResign() {
    if (typeof window !== 'undefined' && !window.confirm('确认认输？')) return;
    onResign?.();
  }

  function handleUndo() {
    onUndo?.();
  }

  return (
    <div
      className="relative w-full max-w-[664px] aspect-square mx-auto"
      style={{ aspectRatio: '1 / 1' }}
    >
      {/* 顶部状态栏: 提子数 + 连续 pass */}
      <div className="absolute -top-9 left-0 right-0 flex items-center justify-between text-[10px] text-silver-dim font-mono">
        <div className="flex items-center gap-3">
          <span>黑提: {captured.B}</span>
          <span className="text-silver-dark">·</span>
          <span>白提: {captured.W}</span>
        </div>
        {consecutivePasses >= 1 && (
          <span className={`px-2 py-0.5 rounded ${consecutivePasses >= 2 ? 'bg-amber-500/20 text-amber-300' : 'bg-silver-mid/10 text-silver-mid'}`}>
            {consecutivePasses >= 2 ? '双 Pass · 和棋' : 'Pass · 等待对手'}
          </span>
        )}
      </div>

      <svg viewBox={`0 0 ${SIZE} ${SIZE}`} preserveAspectRatio="xMidYMid meet" className="w-full h-full rounded-md shadow-2xl shadow-black block" style={{ background: '#0E0E10' }}>
        {/* 棋盘底色 */}
        <rect width={SIZE} height={SIZE} fill="#1A1A1A" />
        <rect x={MARGIN - 6} y={MARGIN - 6} width={SIZE - 2 * MARGIN + 12} height={SIZE - 2 * MARGIN + 12} fill="#D4A574" />

        {/* Policy 热力图 (KataGo policy 概率) */}
        {analysis?.policy && policyMax > 0 && analysis.policy.map((row, r) =>
          row.map((v, c) => {
            if (v <= 0.001) return null;
            const intensity = Math.min(0.45, (v / policyMax) * 0.45);
            const x = MARGIN + c * CELL;
            const y = MARGIN + r * CELL;
            return (
              <rect
                key={`pol-${r}-${c}`}
                x={x - CELL / 2 + 2}
                y={y - CELL / 2 + 2}
                width={CELL - 4}
                height={CELL - 4}
                fill="#22C55E"
                opacity={intensity}
                rx={3}
              />
            );
          }),
        )}

        {/* Ownership 热力图 (kata-ownership: P1-7 fix)
            Blue = Black territory (positive), Red = White territory (negative)
            Ownership from SSE 'ownership' event is merged with analysis?.ownership */}
        {(ownership ?? analysis?.ownership) && (
          (ownership ?? analysis?.ownership)!.map((row, r) =>
            row.map((v, c) => {
              const abs = Math.abs(v);
              if (abs < 0.1) return null; // threshold: ignore near-neutral
              const intensity = Math.min(0.35, abs * 0.5);
              const x = MARGIN + c * CELL;
              const y = MARGIN + r * CELL;
              // positive = Black territory (blue), negative = White territory (red)
              const color = v > 0 ? '#3B82F6' : '#EF4444';
              return (
                <rect
                  key={`own-${r}-${c}`}
                  x={x - CELL / 2 + 2}
                  y={y - CELL / 2 + 2}
                  width={CELL - 4}
                  height={CELL - 4}
                  fill={color}
                  opacity={intensity}
                  rx={3}
                />
              );
            }),
          )
        )}

        {/* 网格线 */}
        {Array.from({ length: BOARD_SIZE }).map((_, i) => (
          <line
            key={`h-${i}`}
            x1={MARGIN}
            y1={MARGIN + i * CELL}
            x2={SIZE - MARGIN}
            y2={MARGIN + i * CELL}
            stroke="#5C4928"
            strokeWidth={i === 0 || i === BOARD_SIZE - 1 ? 1.5 : 0.5}
          />
        ))}
        {Array.from({ length: BOARD_SIZE }).map((_, i) => (
          <line
            key={`v-${i}`}
            x1={MARGIN + i * CELL}
            y1={MARGIN}
            x2={MARGIN + i * CELL}
            y2={SIZE - MARGIN}
            stroke="#5C4928"
            strokeWidth={i === 0 || i === BOARD_SIZE - 1 ? 1.5 : 0.5}
          />
        ))}

        {/* 星位 (天元 + 四角四星) */}
        {[
          [3, 3], [3, 9], [3, 15],
          [9, 3], [9, 9], [9, 15],
          [15, 3], [15, 9], [15, 15],
        ].map(([r, c]) => (
          <circle key={`star-${r}-${c}`} cx={MARGIN + c * CELL} cy={MARGIN + r * CELL} r={3} fill="#5C4928" />
        ))}

        {/* 坐标标签 */}
        {Array.from({ length: BOARD_SIZE }).map((_, i) => {
          const letter = String.fromCharCode('A'.charCodeAt(0) + i);
          const letterDisplay = letter >= 'I' ? String.fromCharCode(letter.charCodeAt(0) + 1) : letter;
          return (
            <g key={`lbl-${i}`}>
              <text
                x={MARGIN + i * CELL}
                y={MARGIN - 10}
                fill="#5C4928"
                fontSize="9"
                textAnchor="middle"
                fontFamily="monospace"
              >
                {letterDisplay}
              </text>
              <text
                x={MARGIN + i * CELL}
                y={SIZE - MARGIN + 18}
                fill="#5C4928"
                fontSize="9"
                textAnchor="middle"
                fontFamily="monospace"
              >
                {letterDisplay}
              </text>
              <text
                x={MARGIN - 12}
                y={MARGIN + i * CELL + 3}
                fill="#5C4928"
                fontSize="9"
                textAnchor="end"
                fontFamily="monospace"
              >
                {i + 1}
              </text>
              <text
                x={SIZE - MARGIN + 12}
                y={MARGIN + i * CELL + 3}
                fill="#5C4928"
                fontSize="9"
                fontFamily="monospace"
              >
                {i + 1}
              </text>
            </g>
          );
        })}

        {/* Hover indicator: 落子预览 (合法 = 绿色, 非法 = 红色, ko 点 = 灰色) */}
        {hover && turn === playerColor && board[hover.r][hover.c] === null && (
          <>
            <rect
              x={MARGIN + hover.c * CELL - CELL / 2 + 2}
              y={MARGIN + hover.r * CELL - CELL / 2 + 2}
              width={CELL - 4}
              height={CELL - 4}
              fill="none"
              stroke={isIllegal(hover.r, hover.c) ? '#EF4444' : '#22C55E'}
              strokeWidth={1.5}
              strokeDasharray="4 3"
              opacity={0.7}
              rx={3}
            />
            {!isIllegal(hover.r, hover.c) && (
              <circle
                cx={MARGIN + hover.c * CELL}
                cy={MARGIN + hover.r * CELL}
                r={CELL * 0.36}
                fill={playerColor === 'B' ? '#0A0A0A' : '#F5F5F0'}
                opacity={0.35}
              />
            )}
          </>
        )}

        {/* 推荐着法标记 (三角形 or 星标, 在最佳点交叉处) */}
        {bestCoord && (
          <g>
            <rect
              x={MARGIN + bestCoord.col * CELL - 5}
              y={MARGIN + bestCoord.row * CELL - 5}
              width={10}
              height={10}
              fill="none"
              stroke="#22C55E"
              strokeWidth={2}
              opacity={0.8}
            />
          </g>
        )}

        {/* 棋子 */}
        {board.map((row, r) =>
          row.map((stone, c) => {
            if (!stone) return null;
            const x = MARGIN + c * CELL;
            const y = MARGIN + r * CELL;
            const isLast = lastCoord?.row === r && lastCoord?.col === c;
            return (
              <g key={`stone-${r}-${c}`}>
                <circle
                  cx={x}
                  cy={y}
                  r={CELL * 0.42}
                  fill={stone === 'B' ? '#0A0A0A' : '#F5F5F0'}
                  stroke={stone === 'B' ? '#000' : '#A0A0A0'}
                  strokeWidth={1}
                  style={{
                    filter: 'drop-shadow(1px 2px 2px rgba(0,0,0,0.4))',
                  }}
                />
                {/* 最后一步棋子上的小红点 */}
                {isLast && (
                  <circle
                    cx={x}
                    cy={y}
                    r={CELL * 0.12}
                    fill={stone === 'B' ? '#EF4444' : '#EF4444'}
                    opacity={0.85}
                  />
                )}
              </g>
            );
          }),
        )}

        {/* 打劫点标记 (ko) — 灰色小方框 */}
        {koPoint && (
          <rect
            x={MARGIN + koPoint.c * CELL - 4}
            y={MARGIN + koPoint.r * CELL - 4}
            width={8}
            height={8}
            fill="none"
            stroke="#888"
            strokeWidth={1.5}
            strokeDasharray="2 2"
            opacity={0.7}
          />
        )}

        {/* Click handler — 透明 rect 覆盖每个交叉点 (CELL=32, 左上对齐) */}
        {Array.from({ length: BOARD_SIZE }).map((_, r) =>
          Array.from({ length: BOARD_SIZE }).map((__, c) => (
            <rect
              key={`click-${r}-${c}`}
              x={MARGIN + c * CELL - CELL / 2}
              y={MARGIN + r * CELL - CELL / 2}
              width={CELL}
              height={CELL}
              fill="transparent"
              onMouseEnter={() => setHover({ r, c })}
              onMouseLeave={() => setHover(null)}
              onClick={(e) => { e.stopPropagation(); handleClick(r, c); }}
              style={{ cursor: turn === playerColor ? (isIllegal(r, c) ? 'not-allowed' : 'pointer') : 'default' }}
            />
          )),
        )}
      </svg>

      {/* 操作按钮: Pass / Resign / Undo */}
      <div className="absolute -bottom-12 left-0 right-0 flex items-center justify-center gap-2">
        <button
          onClick={handlePass}
          disabled={turn !== playerColor}
          className="px-3 py-1 rounded-lg bg-black-elevated border border-silver-border/40 text-silver-mid text-xs hover:bg-silver-mid/10 hover:text-silver-primary disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
          title="虚手"
        >
          Pass
        </button>
        <button
          onClick={handleUndo}
          disabled={!onUndo}
          className="px-3 py-1 rounded-lg bg-black-elevated border border-silver-border/40 text-silver-mid text-xs hover:bg-silver-mid/10 hover:text-silver-primary disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
          title="悔棋"
        >
          ↶ Undo
        </button>
        <button
          onClick={handleResign}
          className="px-3 py-1 rounded-lg bg-black-elevated border border-red-500/30 text-red-300 text-xs hover:bg-red-500/15 transition-colors"
          title="认输"
        >
          Resign
        </button>
      </div>
    </div>
  );
}
