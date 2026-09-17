'use client';

import { useMemo, useState, useEffect } from 'react';
import { Chess } from 'chess.js';
import { Analysis } from '@/lib/types';

interface ChessBoardProps {
  analysis: Analysis | null;
  playerSide: 'white' | 'black';
  onMove: (move: string, san: string) => void;
  lastMove: string | null;
  /** External FEN — when the engine makes a move, GameClient updates this prop
   *  and ChessBoard syncs its internal chess.js state to stay in sync. */
  fen?: string;
  /** 轮到我方走子时为 true, 用于 UI hint / 防连点 */
  isPlayerTurn?: boolean;
}

const SIZE = 480;
const FILES = 'abcdefgh';

export function ChessBoard({ analysis, playerSide, onMove, lastMove, fen, isPlayerTurn }: ChessBoardProps) {
  const [chess] = useState(() => new Chess());
  const [, force] = useState(0);
  const [selected, setSelected] = useState<string | null>(null);
  // Responsive square size — SVG scales to fill the container, viewBox stays at native 480.
  // Each cell = 480/8 = 60 in viewBox units regardless of rendered size.
  const squareSize = SIZE / 8;

  // Sync internal chess.js state to the externally-supplied FEN.
  // This keeps the board in sync when the engine (AI) makes a move and
  // GameClient passes the updated fen prop down.
  useEffect(() => {
    if (!fen) return;
    try {
      chess.load(fen);
      force((n) => n + 1);
    } catch {
      // invalid FEN — ignore
    }
  }, [fen, chess]);

  // 计算合法目标格 (基于 selected)
  const targetSquares = useMemo(() => {
    if (!selected) return new Set<string>();
    const moves = chess.moves({ square: selected as any, verbose: true });
    return new Set(moves.map((m) => m.to));
  }, [selected, chess]);

  const turnMatchesSide = (chess.turn() === 'w' && playerSide === 'white') || (chess.turn() === 'b' && playerSide === 'black');
  // 双闸: 本地状态 (turn) 匹配 + 外部传入 (isPlayerTurn) — 任何一者 false 都拒绝
  const isPlayerTurnLocal = isPlayerTurn === undefined ? turnMatchesSide : isPlayerTurn && turnMatchesSide;

  function handleClick(sq: string) {
    if (!isPlayerTurnLocal) return;
    if (selected) {
      if (targetSquares.has(sq)) {
        // 应用走子
        try {
          const m = chess.move({ from: selected, to: sq, promotion: 'q' });
          if (m) {
            onMove(`${selected}${sq}`, m.san);
            setSelected(null);
            force((n) => n + 1);
            return;
          }
        } catch {}
        // 选错: 重选
        if (chess.get(sq as any)) {
          setSelected(sq);
        } else {
          setSelected(null);
        }
      } else {
        setSelected(null);
      }
    } else {
      if (chess.get(sq as any)) setSelected(sq);
    }
  }

  // 推荐着法 → 在 board 上标注
  const bestMove = analysis?.multiPv[0]?.move;

  return (
    <div className="relative w-full max-w-[480px] mx-auto" style={{ aspectRatio: '1 / 1' }}>
      <svg
        viewBox={`0 0 ${SIZE} ${SIZE}`}
        preserveAspectRatio="xMidYMid meet"
        className="w-full h-full rounded-md shadow-2xl shadow-black block"
        style={{ background: '#0E0E10' }}
      >
        {/* 棋盘格子 */}
        {Array.from({ length: 8 }).map((_, row) =>
          Array.from({ length: 8 }).map((__, col) => {
            const isLight = (row + col) % 2 === 0;
            const sq = `${FILES[col]}${8 - row}`;
            const isSelected = selected === sq;
            const isTarget = targetSquares.has(sq);
            const isLast = lastMove?.includes(sq);
            const isBest = bestMove?.includes(sq);
            return (
              <g key={sq}>
                <rect
                  x={col * squareSize}
                  y={row * squareSize}
                  width={squareSize}
                  height={squareSize}
                  fill={isLight ? '#3A3A40' : '#1F1F25'}
                  stroke="#000"
                  strokeWidth={0.5}
                  className={`${isSelected ? 'square-selected' : ''} ${isTarget ? 'square-hint' : ''} ${isLast ? 'square-last' : ''} ${isBest ? 'square-best' : ''}`}
                  onClick={(e) => { e.stopPropagation(); handleClick(sq); }}
                  style={{ cursor: isPlayerTurnLocal ? 'pointer' : 'default' }}
                />
              </g>
            );
          }),
        )}

        {/* 坐标标签 */}
        {Array.from({ length: 8 }).map((_, i) => (
          <g key={`label-${i}`}>
            <text
              x={(i + 0.5) * squareSize}
              y={SIZE - 4}
              fill="#666"
              fontSize="10"
              textAnchor="middle"
              fontFamily="ui-monospace, monospace"
            >
              {FILES[i]}
            </text>
            <text
              x={4}
              y={(i + 0.5) * squareSize + 3}
              fill="#666"
              fontSize="10"
              fontFamily="ui-monospace, monospace"
            >
              {8 - i}
            </text>
          </g>
        ))}

        {/* 棋子 */}
        {Array.from({ length: 8 }).map((_, row) =>
          Array.from({ length: 8 }).map((__, col) => {
            const sq = `${FILES[col]}${8 - row}`;
            const p = chess.get(sq as any);
            if (!p) return null;
            const x = col * squareSize + squareSize / 2;
            const y = row * squareSize + squareSize / 2;
            const isWhite = p.color === 'w';
            return (
              <g key={sq + '-piece'} className="piece" onClick={(e) => { e.stopPropagation(); handleClick(sq); }}>
                <ChessPiece type={p.type} color={isWhite ? 'white' : 'black'} x={x} y={y} size={squareSize * 0.85} isHighlight={isPlayerTurnLocal} />
              </g>
            );
          }),
        )}

        {/* 目标格提示 (棋子影子) */}
        {selected && Array.from(targetSquares).map((sq) => {
          const col = FILES.indexOf(sq[0]);
          const row = 8 - parseInt(sq[1], 10);
          const x = col * squareSize + squareSize / 2;
          const y = row * squareSize + squareSize / 2;
          return (
            <circle
              key={`hint-${sq}`}
              cx={x}
              cy={y}
              r={squareSize * 0.18}
              fill={chess.get(sq as any) ? '#EF4444' : '#22C55E'}
              opacity={0.6}
            />
          );
        })}
      </svg>
    </div>
  );
}

const PIECE_GLYPHS: Record<string, { fill: string; stroke: string }> = {
  K: { fill: '#FFFFFF', stroke: '#1F1F25' },
  Q: { fill: '#FFFFFF', stroke: '#1F1F25' },
  R: { fill: '#FFFFFF', stroke: '#1F1F25' },
  B: { fill: '#FFFFFF', stroke: '#1F1F25' },
  N: { fill: '#FFFFFF', stroke: '#1F1F25' },
  P: { fill: '#FFFFFF', stroke: '#1F1F25' },
  k: { fill: '#1F1F25', stroke: '#888' },
  q: { fill: '#1F1F25', stroke: '#888' },
  r: { fill: '#1F1F25', stroke: '#888' },
  b: { fill: '#1F1F25', stroke: '#888' },
  n: { fill: '#1F1F25', stroke: '#888' },
  p: { fill: '#1F1F25', stroke: '#888' },
};

function ChessPiece({ type, color, x, y, size, isHighlight = false }: { type: string; color: 'white' | 'black'; x: number; y: number; size: number; isHighlight?: boolean }) {
  const r = size / 2 - 2;
  const sym = color === 'white' ? type.toUpperCase() : type.toLowerCase();
  const glyph = PIECE_GLYPHS[sym] || PIECE_GLYPHS[color === 'white' ? 'K' : 'k'];
  return (
    <g style={{ filter: isHighlight ? 'drop-shadow(0 0 4px #22C55E66)' : undefined }}>
      <circle cx={x} cy={y} r={r} fill={glyph.fill} stroke={glyph.stroke} strokeWidth={2} />
      <text
        x={x}
        y={y + r * 0.4}
        fontSize={r * 1.4}
        textAnchor="middle"
        fontWeight="700"
        fill={color === 'white' ? '#1F1F25' : '#E8E8E8'}
        fontFamily="ui-serif, Georgia, serif"
      >
        {color === 'white' ? type.toUpperCase() : type.toLowerCase()}
      </text>
    </g>
  );
}