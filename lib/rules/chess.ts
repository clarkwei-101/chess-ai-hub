// 国际象棋规则 - 基于 chess.js
// chess.js 1.0.0-beta: 完整 FEN/PGN/规则支持

import { Chess, Move } from 'chess.js';

export class ChessEngine {
  private chess: Chess;

  constructor(fen?: string) {
    this.chess = new Chess(fen);
  }

  fen(): string {
    return this.chess.fen();
  }

  turn(): 'w' | 'b' {
    return this.chess.turn();
  }

  /** 应用一步 UCI move ("e2e4"),返回 { legal, san, fen } */
  applyMove(uci: string): { legal: boolean; san?: string; fen?: string } {
    const from = uci.slice(0, 2);
    const to = uci.slice(2, 4);
    const promotion = uci.length > 4 ? uci.slice(4, 5) : undefined;
    try {
      const move = this.chess.move({ from, to, promotion });
      if (move) {
        return { legal: true, san: move.san, fen: this.chess.fen() };
      }
      return { legal: false };
    } catch {
      return { legal: false };
    }
  }

  /** 列出当前所有合法走法 (UCI) */
  legalMovesUci(): string[] {
    return this.chess.moves({ verbose: true }).map((m) => {
      const promo = m.promotion ? m.promotion : '';
      return `${m.from}${m.to}${promo}`;
    });
  }

  /** 获取指定格子的棋子 */
  pieceAt(square: string): { type: string; color: 'w' | 'b' } | null {
    const piece = this.chess.get(square as any);
    if (!piece) return null;
    return { type: piece.type, color: piece.color };
  }

  /** 棋盘渲染: 8x8 array, [row 0=top, row 7=bottom], 元素是 type+color 或 null */
  boardGrid(): ({ type: string; color: 'w' | 'b' } | null)[][] {
    const grid: ({ type: string; color: 'w' | 'b' } | null)[][] = [];
    for (let r = 0; r < 8; r++) {
      const row: ({ type: string; color: 'w' | 'b' } | null)[] = [];
      for (let c = 0; c < 8; c++) {
        const sq = String.fromCharCode('a'.charCodeAt(0) + c) + (8 - r);
        const p = this.chess.get(sq as any);
        row.push(p ? { type: p.type, color: p.color } : null);
      }
      grid.push(row);
    }
    return grid;
  }

  isCheckmate(): boolean { return this.chess.isCheckmate(); }
  isStalemate(): boolean { return this.chess.isStalemate(); }
  isCheck(): boolean { return this.chess.isCheck(); }
  isGameOver(): boolean { return this.chess.isGameOver(); }
  inDraw(): boolean { return this.chess.isDraw(); }
}