'use client';

import { useMemo, useState, useEffect } from 'react';
import { Analysis, MoveRecord } from '@/lib/types';
import { XqBoard, XqColor, XqPiece, XQ_PIECE_NAMES_CN, xqInitialBoard, applyXqMove, uciToXqCoords, isLegalXqMove } from '@/lib/rules/xiangqi';

interface XiangqiBoardProps {
  analysis: Analysis | null;
  playerSide: 'red' | 'black';
  onMove: (move: string, san: string) => void;
  lastMove: string | null;
  /** Move history — 用来同步 AI 走子后的本地局面 (引擎在自己内存维护 board,UI 必须 replay) */
  moves?: MoveRecord[];
  /** True when it's the user's turn — prevents accidental clicks during AI thinking. */
  isPlayerTurn?: boolean;
}

const CELL = 56;
const COLS = 9;
const ROWS = 10;
const W = COLS * CELL + 40;
const H = ROWS * CELL + 40;

export function XiangqiBoard({ analysis, playerSide, onMove, lastMove, moves, isPlayerTurn }: XiangqiBoardProps) {
  // 派生 board: 从 moves 列表回放 (保证用户和 AI 的着法都同步到 UI)
  const derived = useMemo(() => {
    let b: XqBoard = xqInitialBoard();
    if (moves && moves.length > 0) {
      for (const m of moves) {
        const coords = uciToXqCoords(m.move);
        if (coords) {
          b = applyXqMove(b, coords);
        } else {
          break;
        }
      }
    }
    return b;
  }, [moves]);

  const [board, setBoard] = useState<XqBoard>(derived);
  const [selected, setSelected] = useState<{ r: number; c: number } | null>(null);
  const playerTurn: XqColor = playerSide === 'red' ? 'w' : 'b';

  // 当 derived 变化 (外部 moves 更新) 时,同步本地 state
  useEffect(() => {
    setBoard(derived);
    setSelected(null); // 切换方时取消选中
  }, [derived]);

  // 计算合法目标格 — 使用完整规则（九宫/过河/蹩腿/炮架）
  const targetSquares = useMemo(() => {
    if (!selected) return new Set<string>();
    const targets = new Set<string>();
    for (let r = 0; r < 10; r++) {
      for (let c = 0; c < 9; c++) {
        if (isLegalXqMove(board, selected, { r, c }, playerTurn)) {
          targets.add(`${r},${c}`);
        }
      }
    }
    return targets;
  }, [selected, board, playerTurn]);

  const pieceName = (p: XqPiece | null, color: XqColor): string => {
    if (!p) return '';
    return XQ_PIECE_NAMES_CN[p.type][color === 'w' ? 0 : 1];
  };

  const lastMoveCoord = useMemo(() => {
    if (!lastMove) return null;
    if (lastMove.length < 4) return null;
    const fc = lastMove[0];
    const fr = parseInt(lastMove[1], 10);
    const tc = lastMove[2];
    const tr = parseInt(lastMove[3], 10);
    const from = { r: 9 - fr, c: fc.charCodeAt(0) - 'a'.charCodeAt(0) };
    const to = { r: 9 - tr, c: tc.charCodeAt(0) - 'a'.charCodeAt(0) };
    return { from, to };
  }, [lastMove]);

  const bestMove = analysis?.multiPv[0]?.move;
  const bestCoords = useMemo(() => {
    if (!bestMove) return null;
    if (bestMove.length < 4) return null;
    const fc = bestMove[0];
    const fr = parseInt(bestMove[1], 10);
    const tc = bestMove[2];
    const tr = parseInt(bestMove[3], 10);
    if ([fc, fr, tc, tr].some((v) => v === undefined || isNaN(Number(v)))) return null;
    return {
      from: { r: 9 - fr, c: fc.charCodeAt(0) - 'a'.charCodeAt(0) },
      to: { r: 9 - tr, c: tc.charCodeAt(0) - 'a'.charCodeAt(0) },
    };
  }, [bestMove]);

  function handleClick(r: number, c: number) {
    if (isPlayerTurn !== undefined && !isPlayerTurn) return;
    const piece = board[r][c];
    if (selected) {
      if (targetSquares.has(`${r},${c}`)) {
        // 应用
        const fc = String.fromCharCode('a'.charCodeAt(0) + selected.c);
        const fr = 9 - selected.r;
        const tc = String.fromCharCode('a'.charCodeAt(0) + c);
        const tr = 9 - r;
        const uci = `${fc}${fr}${tc}${tr}`;
        const san = `${pieceName(piece, playerTurn === 'w' ? 'b' : 'w')}${fc}${colIdxCN(c)}${tr}`;
        onMove(uci, san);
        setSelected(null);
        return;
      }
      // 重选
      if (piece && piece.color === playerTurn) {
        setSelected({ r, c });
        return;
      }
      setSelected(null);
    } else {
      if (piece && piece.color === playerTurn) {
        setSelected({ r, c });
      }
    }
  }

  return (
    <div className="relative" style={{ width: W, height: H }}>
      <svg viewBox={`0 0 ${W} ${H}`} className="rounded-md shadow-2xl shadow-black" style={{ background: '#0E0E10' }}>
        {/* 背景米色 */}
        <rect width={W} height={H} fill="#2A2318" />

        {/* 网格线 */}
        <line x1={20} y1={20} x2={W - 20} y2={20} stroke="#8A6D3F" strokeWidth={1} />
        <line x1={20} y1={H - 20} x2={W - 20} y2={H - 20} stroke="#8A6D3F" strokeWidth={1} />
        <line x1={20} y1={20} x2={20} y2={H - 20} stroke="#8A6D3F" strokeWidth={1} />
        <line x1={W - 20} y1={20} x2={W - 20} y2={H - 20} stroke="#8A6D3F" strokeWidth={1} />

        {/* 中间横线 (留空给"楚河汉界") */}
        <line x1={20} y1={20 + 4 * CELL} x2={W - 20} y2={20 + 4 * CELL} stroke="#8A6D3F" strokeWidth={1} />
        <line x1={20} y1={20 + 5 * CELL} x2={W - 20} y2={20 + 5 * CELL} stroke="#8A6D3F" strokeWidth={1} />

        {/* 内部网格 */}
        {Array.from({ length: ROWS - 1 }).map((_, i) => (
          <line key={`h-${i}`} x1={20} y1={20 + (i + 1) * CELL} x2={W - 20} y2={20 + (i + 1) * CELL} stroke="#5C4928" strokeWidth={0.5} />
        ))}
        {Array.from({ length: COLS - 1 }).map((_, i) => (
          <line key={`v-${i}`} x1={20 + (i + 1) * CELL} y1={20} x2={20 + (i + 1) * CELL} y2={20 + 4 * CELL} stroke="#5C4928" strokeWidth={0.5} />
        ))}
        {Array.from({ length: COLS - 1 }).map((_, i) => (
          <line key={`v2-${i}`} x1={20 + (i + 1) * CELL} y1={20 + 5 * CELL} x2={20 + (i + 1) * CELL} y2={H - 20} stroke="#5C4928" strokeWidth={0.5} />
        ))}

        {/* 楚河汉界文字 */}
        <text x={W / 2 - 80} y={20 + 4.5 * CELL + 5} fill="#4F4128" fontSize="22" fontFamily="serif" letterSpacing={10}>
          楚 河
        </text>
        <text x={W / 2 + 20} y={20 + 4.5 * CELL + 5} fill="#4F4128" fontSize="22" fontFamily="serif" letterSpacing={10}>
          汉 界
        </text>

        {/* 宫格 (九宫) */}
        {[3, 5].map((c1) => (
          <line key={`palace-${c1}`} x1={20 + c1 * CELL} y1={20} x2={20 + (10 - c1) * CELL} y2={20 + 2 * CELL} stroke="#5C4928" strokeWidth={0.5} />
        ))}
        {[3, 5].map((c1) => (
          <line key={`palace2-${c1}`} x1={20 + c1 * CELL} y1={20 + 2 * CELL} x2={20 + (10 - c1) * CELL} y2={20} stroke="#5C4928" strokeWidth={0.5} />
        ))}
        {[3, 5].map((c1) => (
          <line key={`palace3-${c1}`} x1={20 + c1 * CELL} y1={20 + 7 * CELL} x2={20 + (10 - c1) * CELL} y2={20 + 9 * CELL} stroke="#5C4928" strokeWidth={0.5} />
        ))}
        {[3, 5].map((c1) => (
          <line key={`palace4-${c1}`} x1={20 + c1 * CELL} y1={20 + 9 * CELL} x2={20 + (10 - c1) * CELL} y2={20 + 7 * CELL} stroke="#5C4928" strokeWidth={0.5} />
        ))}

        {/* 坐标标签 */}
        {Array.from({ length: COLS }).map((_, i) => (
          <text key={`lbl-x-${i}`} x={20 + i * CELL} y={H - 4} fill="#9A8456" fontSize="9" textAnchor="middle" fontFamily="monospace">
            {String.fromCharCode('a'.charCodeAt(0) + i)}
          </text>
        ))}

        {/* 棋子 */}
        {board.map((row, r) =>
          row.map((piece, c) => {
            if (!piece) return null;
            const x = 20 + c * CELL;
            const y = 20 + r * CELL;
            const isSelected = selected?.r === r && selected?.c === c;
            const isLastFrom = lastMoveCoord?.from.r === r && lastMoveCoord?.from.c === c;
            const isLastTo = lastMoveCoord?.to.r === r && lastMoveCoord?.to.c === c;
            const isBestFrom = bestCoords?.from.r === r && bestCoords?.from.c === c;
            const isBestTo = bestCoords?.to.r === r && bestCoords?.to.c === c;
            return (
              <g key={`xq-${r}-${c}`} onClick={(e) => { e.stopPropagation(); handleClick(r, c); }} style={{ cursor: 'pointer' }}>
                {(isLastFrom || isBestFrom) && (
                  <rect x={x - CELL / 2} y={y - CELL / 2} width={CELL} height={CELL} fill="rgba(232,232,232,0.1)" />
                )}
                {(isLastTo || isBestTo) && (
                  <rect x={x - CELL / 2} y={y - CELL / 2} width={CELL} height={CELL} fill={isBestTo ? 'rgba(34,197,94,0.3)' : 'rgba(232,232,232,0.2)'} />
                )}
                {isSelected && (
                  <rect x={x - CELL / 2 + 2} y={y - CELL / 2 + 2} width={CELL - 4} height={CELL - 4} fill="none" stroke="#E8E8E8" strokeWidth={2} />
                )}
                <XqPieceView piece={piece} x={x} y={y} size={CELL - 4} />
              </g>
            );
          }),
        )}

        {/* 走子提示圆点 */}
        {selected && Array.from(targetSquares).map((key) => {
          const [r, c] = key.split(',').map(Number);
          const x = 20 + c * CELL;
          const y = 20 + r * CELL;
          const target = board[r][c];
          return (
            <circle key={`hint-${key}`} cx={x} cy={y} r={CELL * 0.15} fill={target ? '#EF4444' : '#22C55E'} opacity={0.6} />
          );
        })}
      </svg>
    </div>
  );
}

function XqPieceView({ piece, x, y, size }: { piece: XqPiece; x: number; y: number; size: number }) {
  const isRed = piece.color === 'w';
  const r = size / 2;
  const name = XQ_PIECE_NAMES_CN[piece.type][piece.color === 'w' ? 0 : 1];
  return (
    <g>
      {/* 阴影 */}
      <ellipse cx={x + 1} cy={y + 2} rx={r * 0.95} ry={r * 0.95} fill="rgba(0,0,0,0.4)" />
      {/* 外圈 */}
      <circle cx={x} cy={y} r={r * 0.95} fill={isRed ? '#D4AF6F' : '#F0E1C1'} stroke={isRed ? '#A14426' : '#5C4928'} strokeWidth={2} />
      <circle cx={x} cy={y} r={r * 0.85} fill={isRed ? '#E8C788' : '#FAEED8'} stroke={isRed ? '#A14426' : '#5C4928'} strokeWidth={0.8} />
      {/* 文字 */}
      <text
        x={x}
        y={y + r * 0.32}
        fontSize={r * 1.1}
        textAnchor="middle"
        fill={isRed ? '#A14426' : '#1F1F25'}
        fontWeight="700"
        fontFamily="'Songti SC', STSong, serif"
      >
        {name}
      </text>
    </g>
  );
}

function colIdxCN(c: number): string {
  // 0..8 -> 中文数字 一二三四五六七八九
  return '零一二三四五六七八九'[c] || String(c);
}