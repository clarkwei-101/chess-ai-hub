// 围棋规则 - 简化版 (Tromp-Taylor)
// 不做完整死活判断,只做落子合法性 + 简单自杀禁止

export type GoColor = 'B' | 'W';
export type GoStone = GoColor | null;
export type GoBoard = GoStone[][]; // [row 0=top, col 0=left]

export function goInitialBoard(size: number = 19): GoBoard {
  return Array.from({ length: size }, () => Array(size).fill(null));
}

/** 检查落子合法性 (Tromp-Taylor): 不重复 + 不自杀 (简单版) */
export function isLegalGoMove(board: GoBoard, color: GoColor, row: number, col: number, koPoint?: { r: number; c: number }): boolean {
  const size = board.length;
  if (row < 0 || row >= size || col < 0 || col >= size) return false;
  if (board[row][col] !== null) return false;
  if (koPoint && koPoint.r === row && koPoint.c === col) return false;
  // 模拟: 检查周围是否有对方无气 + 自己至少有一气
  const enemy: GoColor = color === 'B' ? 'W' : 'B';
  const adj = [
    [row - 1, col], [row + 1, col], [row, col - 1], [row, col + 1],
  ];
  let enemyGroupWouldDie = false;
  for (const [r, c] of adj) {
    if (r < 0 || r >= size || c < 0 || c >= size) continue;
    if (board[r][c] === enemy && groupLiberties(board, r, c).size === 1) {
      enemyGroupWouldDie = true;
      break;
    }
  }
  if (enemyGroupWouldDie) return true;
  // 模拟落子
  const sim = board.map((row) => row.slice());
  sim[row][col] = color;
  // 检查自杀: 落子后自己的 group 是否无气
  if (groupLiberties(sim, row, col).size === 0) return false;
  return true;
}

/** 获取一个 group 的所有气位 (空邻位) */
export function groupLiberties(board: GoBoard, row: number, col: number): Set<string> {
  const size = board.length;
  const color = board[row][col];
  if (!color) return new Set();
  const visited = new Set<string>();
  const liberties = new Set<string>();
  const stack: [number, number][] = [[row, col]];
  while (stack.length > 0) {
    const [r, c] = stack.pop()!;
    const key = `${r},${c}`;
    if (visited.has(key)) continue;
    visited.add(key);
    const neighbors = [
      [r - 1, c], [r + 1, c], [r, c - 1], [r, c + 1],
    ];
    for (const [nr, nc] of neighbors) {
      if (nr < 0 || nr >= size || nc < 0 || nc >= size) continue;
      const np = board[nr][nc];
      if (np === null) liberties.add(`${nr},${nc}`);
      else if (np === color && !visited.has(`${nr},${nc}`)) stack.push([nr, nc]);
    }
  }
  return liberties;
}

/** 应用落子 (clone board + 移除死子 + 计算打劫点) */
export function applyGoMove(
  board: GoBoard,
  color: GoColor,
  row: number,
  col: number,
): { board: GoBoard; captured: [number, number][]; koPoint?: { r: number; c: number } } {
  const size = board.length;
  const next = board.map((row) => row.slice());
  const enemy: GoColor = color === 'B' ? 'W' : 'B';
  const adj = [
    [row - 1, col], [row + 1, col], [row, col - 1], [row, col + 1],
  ];
  const captured: [number, number][] = [];
  for (const [r, c] of adj) {
    if (r < 0 || r >= size || c < 0 || c >= size) continue;
    if (next[r][c] === enemy && groupLiberties(next, r, c).size === 1) {
      // 提走整个 group
      const stack: [number, number][] = [[r, c]];
      while (stack.length > 0) {
        const [gr, gc] = stack.pop()!;
        if (next[gr][gc] !== enemy) continue;
        next[gr][gc] = null;
        captured.push([gr, gc]);
        for (const [nr, nc] of [[gr - 1, gc], [gr + 1, gc], [gr, gc - 1], [gr, gc + 1]]) {
          if (nr < 0 || nr >= size || nc < 0 || nc >= size) continue;
          if (next[nr][nc] === enemy) stack.push([nr, nc]);
        }
      }
    }
  }
  next[row][col] = color;

  // 打劫 (ko) 检测: 落子后该新石所在 group 恰好只有 1 气 (即上一步对方提走我方 1 子后留下的唯一回提点)
  // 完整 ko 检测需要 hash 上一局面, 这里用近似: 提走 1 子 且 落子后该子所在 group 只有 1 气 (即对方的打劫点)
  let koPoint: { r: number; c: number } | undefined;
  if (captured.length === 1) {
    const myLibs = groupLiberties(next, row, col);
    if (myLibs.size === 1) {
      // 提走的那个点就是 ko point (下一手对手不能立即回提)
      koPoint = { r: captured[0][0], c: captured[0][1] };
    }
  }

  return { board: next, captured, koPoint };
}

/** GTP move (e.g. "Q16") → (row, col, 0-indexed) */
export function gtpToCoord(move: string, boardSize: number = 19): { row: number; col: number; pass: boolean } | null {
  if (move === 'pass' || move === 'PASS' || move === 'resign') {
    return { row: -1, col: -1, pass: true };
  }
  const colChar = move[0]?.toUpperCase();
  if (!colChar) return null;
  if (colChar === 'I') return null;
  let col = colChar.charCodeAt(0) - 'A'.charCodeAt(0);
  if (colChar > 'I') col--;
  const row = parseInt(move.slice(1), 10) - 1;
  if (isNaN(row) || row < 0 || row >= boardSize) return null;
  if (col < 0 || col >= boardSize) return null;
  return { row, col, pass: false };
}

export function coordToGtp(row: number, col: number): string {
  let letter = String.fromCharCode('A'.charCodeAt(0) + col);
  if (letter >= 'I') letter = String.fromCharCode(letter.charCodeAt(0) + 1);
  return `${letter}${row + 1}`;
}