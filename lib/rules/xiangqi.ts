// 中国象棋规则 - 完整版本
// 棋盘: 9 列 × 10 行, 红方在下半部(行7-9), 黑方在上半部(行0-2)
// 坐标: a0-i9 (Pikafish 内部坐标) 或中文坐标
//
// 棋子: K(将/帅) A(士) E(象/相) H(马/傌) R(车/俥) C(炮/砲) P(卒/兵)
// 颜色: w=红 (Pikafish 视角下方的玩家), b=黑

export type XqPieceType = 'K' | 'A' | 'E' | 'H' | 'R' | 'C' | 'P';
export type XqColor = 'w' | 'b';

export interface XqPiece {
  type: XqPieceType;
  color: XqColor;
}

export type XqBoard = (XqPiece | null)[][]; // [row 0=top=黑底线, row 9=bottom=红底线]

const FILES = 'abcdefghi';

/** 初始局面 */
export function xqInitialBoard(): XqBoard {
  const board: XqBoard = Array.from({ length: 10 }, () => Array(9).fill(null));
  const setupRow = (row: number, color: XqColor) => {
    board[row][0] = { type: 'R', color };
    board[row][1] = { type: 'H', color };
    board[row][2] = { type: 'E', color };
    board[row][3] = { type: 'A', color };
    board[row][4] = { type: 'K', color };
    board[row][5] = { type: 'A', color };
    board[row][6] = { type: 'E', color };
    board[row][7] = { type: 'H', color };
    board[row][8] = { type: 'R', color };
  };
  setupRow(0, 'b');
  setupRow(9, 'w');
  board[2][1] = { type: 'C', color: 'b' };
  board[2][7] = { type: 'C', color: 'b' };
  board[7][1] = { type: 'C', color: 'w' };
  board[7][7] = { type: 'C', color: 'w' };
  for (let c = 0; c < 9; c += 2) {
    board[3][c] = { type: 'P', color: 'b' };
    board[6][c] = { type: 'P', color: 'w' };
  }
  return board;
}

/** 某颜色九宫的合法列范围 (0-indexed col) */
function inPalace(r: number, c: number, color: XqColor): boolean {
  if (color === 'w') return r >= 7 && r <= 9 && c >= 3 && c <= 5;
  return r >= 0 && r <= 2 && c >= 3 && c <= 5;
}

/**
 * 完整合法性检查 — 覆盖所有棋子的移动规则。
 * 用于 UI 走子提示（绿色/红色圆点）。
 * 完整规则（含将帅对脸/送将检测）由 Pikafish 引擎处理。
 */
export function isLegalXqMove(board: XqBoard, from: { r: number; c: number }, to: { r: number; c: number }, color: XqColor): boolean {
  const piece = board[from.r]?.[from.c];
  if (!piece || piece.color !== color) return false;

  const tr = to.r, tc = to.c;
  // 边界
  if (tr < 0 || tr > 9 || tc < 0 || tc > 8) return false;
  // 不能吃己方子
  const target = board[tr]?.[tc];
  if (target && target.color === color) return false;

  const dr = tr - from.r, dc = tc - from.c;
  const absR = Math.abs(dr), absC = Math.abs(dc);

  switch (piece.type) {
    case 'K': // 将/帅: 一步横竖，九宫内
      if (!inPalace(tr, tc, color)) return false;
      if (absR + absC !== 1) return false;
      return true;

    case 'A': // 士: 一步斜向，九宫内
      if (!inPalace(tr, tc, color)) return false;
      if (absR === 1 && absC === 1) return true;
      return false;

    case 'E': { // 象/相: 走田字，不过河，不塞象眼
      if (color === 'b' && tr < 5) return false; // 黑象不过红河
      if (color === 'w' && tr > 4) return false; // 红相不过黑河
      if (absR !== 2 || absC !== 2) return false;
      const eyeR = from.r + dr / 2;
      const eyeC = from.c + dc / 2;
      if (board[eyeR]?.[eyeC] !== null) return false; // 塞象眼
      return true;
    }

    case 'H': { // 马: 日字，有蹩马腿
      if (absR === 2 && absC === 1) {
        const legR = from.r + dr / 2;
        const legC = from.c;
        if (board[legR]?.[legC] !== null) return false; // 蹩马腿
        return true;
      }
      if (absR === 1 && absC === 2) {
        const legR = from.r;
        const legC = from.c + dc / 2;
        if (board[legR]?.[legC] !== null) return false; // 蹩马腿
        return true;
      }
      return false;
    }

    case 'R': { // 车: 直线任意距离，中间不能有子
      if (absR > 0 && absC > 0) return false;
      const stepR = absR > 0 ? Math.sign(dr) : 0;
      const stepC = absC > 0 ? Math.sign(dc) : 0;
      let cr = from.r + stepR, cc = from.c + stepC;
      while (cr !== tr || cc !== tc) {
        if (board[cr]?.[cc] !== null) return false;
        cr += stepR; cc += stepC;
      }
      return true;
    }

    case 'C': { // 炮: 直线任意距离，吃子需隔一子（炮架）
      if (absR > 0 && absC > 0) return false;
      const stepR = absR > 0 ? Math.sign(dr) : 0;
      const stepC = absC > 0 ? Math.sign(dc) : 0;
      let cr = from.r + stepR, cc = from.c + stepC;
      let platformCount = 0;
      while (cr !== tr || cc !== tc) {
        if (board[cr]?.[cc] !== null) platformCount++;
        cr += stepR; cc += stepC;
      }
      // 不吃子时中间无子，吃子时恰有一个炮架
      if (!target) return platformCount === 0;
      return platformCount === 1;
    }

    case 'P': { // 卒/兵: 过河前只能前进，过河后可左右
      if (color === 'w') {
        if (from.r <= 4) {
          // 已过河: 可平左右或前进
          if (dr === 0 && absC === 1) return true;  // 横走
          if (dr === -1 && absC === 0) return true;  // 前进
          return false;
        }
        // 未过河: 只能前进
        if (dr === -1 && absC === 0) return true;
        return false;
      } else {
        // black pawn
        if (from.r >= 5) {
          // 已过河: 可平左右或前进
          if (dr === 0 && absC === 1) return true;
          if (dr === 1 && absC === 0) return true;
          return false;
        }
        // 未过河: 只能前进
        if (dr === 1 && absC === 0) return true;
        return false;
      }
    }

    default:
      return false;
  }
}

/** 查找将帅位置 */
export function findKing(board: XqBoard, color: XqColor): { r: number; c: number } | null {
  for (let r = 0; r < 10; r++) {
    for (let c = 0; c < 9; c++) {
      const p = board[r]?.[c];
      if (p && p.type === 'K' && p.color === color) return { r, c };
    }
  }
  return null;
}

/** 检查是否被将军 (color方处于被将军状态) */
export function isInCheck(board: XqBoard, color: XqColor): boolean {
  const king = findKing(board, color);
  if (!king) return false;
  const opp: XqColor = color === 'w' ? 'b' : 'w';
  for (let r = 0; r < 10; r++) {
    for (let c = 0; c < 9; c++) {
      const p = board[r]?.[c];
      if (p && p.color === opp) {
        if (isLegalXqMove(board, { r, c }, king, opp)) return true;
      }
    }
  }
  return false;
}

/** 应用一步 (clone board) */
export function applyXqMove(board: XqBoard, move: { from: { r: number; c: number }; to: { r: number; c: number } }): XqBoard {
  const next = board.map((row) => row.slice());
  const piece = next[move.from.r]?.[move.from.c];
  if (!piece) return next;
  next[move.to.r]![move.to.c] = piece;
  next[move.from.r]![move.from.c] = null;
  return next;
}

/** Pikafish 内部坐标 <-> (row, col) 0-indexed
 *  Pikafish uses (file, rank) starting from a=0..i=8 for files, 0..9 for ranks.
 *  Our board[row][col] has row 0 at the top (black's side).
 */
export function uciToXqCoords(uci: string): { from: { r: number; c: number }; to: { r: number; c: number } } | null {
  if (uci.length < 4) return null;
  const fc = FILES.indexOf(uci[0]);
  const fr = parseInt(uci[1], 10);
  const tc = FILES.indexOf(uci[2]);
  const tr = parseInt(uci[3], 10);
  if ([fc, tc].some((v) => v < 0) || [fr, tr].some((v) => isNaN(v))) return null;
  return {
    from: { r: 9 - fr, c: fc },
    to: { r: 9 - tr, c: tc },
  };
}

export function xqCoordsToUci(from: { r: number; c: number }, to: { r: number; c: number }): string {
  const fc = FILES[from.c];
  const fr = 9 - from.r;
  const tc = FILES[to.c];
  const tr = 9 - to.r;
  return `${fc}${fr}${tc}${tr}`;
}

/** 获取某格所有合法着法 (用于 AI 预测高亮) */
export function getLegalMoves(board: XqBoard, from: { r: number; c: number }, color: XqColor): Array<{ r: number; c: number }> {
  const moves: Array<{ r: number; c: number }> = [];
  for (let r = 0; r < 10; r++) {
    for (let c = 0; c < 9; c++) {
      if (isLegalXqMove(board, from, { r, c }, color)) {
        moves.push({ r, c });
      }
    }
  }
  return moves;
}

/** FEN-like 字符串 (用于 engine 启动) */
export function xqToFen(board: XqBoard, turn: XqColor = 'w'): string {
  let boardStr = '';
  for (let r = 0; r < 10; r++) {
    let empty = 0;
    for (let c = 0; c < 9; c++) {
      const p = board[r]?.[c];
      if (!p) { empty++; continue; }
      if (empty > 0) { boardStr += empty; empty = 0; }
      // 黑方小写, 红方大写
      boardStr += p.color === 'b' ? p.type.toLowerCase() : p.type;
    }
    if (empty > 0) boardStr += empty;
    if (r < 9) boardStr += '/';
  }
  return `${boardStr} ${turn} - - 0 1`;
}

/** 中文字符棋名 (用于 UI) */
export const XQ_PIECE_NAMES_CN: Record<XqPieceType, [string, string]> = {
  K: ['帅', '将'],
  A: ['仕', '士'],
  E: ['相', '象'],
  H: ['马', '马'],
  R: ['车', '车'],
  C: ['炮', '炮'],
  P: ['兵', '卒'],
};
