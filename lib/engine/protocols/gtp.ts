// GTP 协议解析 — KataGo 围棋专用
// 参考: https://github.com/lightvector/KataGo/blob/master/docs/GTP_Extensions.md

import { Analysis, PvLine } from '../../types';

export interface GtpAnalysisRaw {
  // kata-genmove_analyze / lz-genmove_analyze 输出的字段
  turnNumber?: number;
  rootInfo?: {
    winRate: number;
    scoreLead: number;
    scoreStdev?: number;
    utility?: number;
  };
  moveInfos?: Map<string, GtpMoveInfo>; // by move string
  isDone?: boolean;
}

export interface GtpMoveInfo {
  move: string;
  visits: number;
  winRate: number;
  scoreLead: number;
  scoreStdev?: number;
  utility?: number;
  lcb?: number;
  pv?: string[];
  policy?: number; // 0~1
  order?: number;
}

/**
 * 解析 GTP kata-analyze 行。
 * 格式: kata-...: <turn> visits winrate X scoreLead Y [scoreStdev Z utility U] move D4 visits ... winrate X ... pv ... policy ... ownership ...
 *
 * Example:
 *   kata-genmove_analyze B 0.1
 *   ...
 *   info turn 1 visits 1 utility 0.335384 winrate 0.461741 scoreLead -2.41258 ... pv B Q16 ... policy 0.0123
 *   info move Q4 visits 1 prior 0.012345 ... winrate 0.487932 scoreLead -2.34 ... pv Q4 D16 ...
 *   ...
 */
export function parseGtpInfoLine(line: string): GtpAnalysisRaw | null {
  if (!line.startsWith('info ')) return null;
  // 移除前缀
  const tokens = line.slice(5).split(/\s+/);
  const out: GtpAnalysisRaw = { moveInfos: new Map() };
  let currentMove: string | null = null;

  // root info 出现在 line 开头,后面可能跟 'move X visits...' 子段
  let i = 0;
  // root 部分
  const root: { winRate?: number; scoreLead?: number; scoreStdev?: number; utility?: number; visits?: number; turn?: number } = {};
  while (i < tokens.length) {
    const tok = tokens[i];
    if (tok === 'move') {
      // 进入 move 子段
      break;
    }
    switch (tok) {
      case 'turn':
        root.turn = parseInt(tokens[++i], 10);
        out.turnNumber = root.turn;
        break;
      case 'visits':
        root.visits = parseInt(tokens[++i], 10);
        break;
      case 'winrate':
        root.winRate = parseFloat(tokens[++i]);
        break;
      case 'scoreLead':
        root.scoreLead = parseFloat(tokens[++i]);
        break;
      case 'scoreStdev':
        root.scoreStdev = parseFloat(tokens[++i]);
        break;
      case 'utility':
        root.utility = parseFloat(tokens[++i]);
        break;
      default:
        break;
    }
    i++;
  }

  if (root.winRate !== undefined || root.scoreLead !== undefined) {
    out.rootInfo = {
      winRate: root.winRate ?? 0.5,
      scoreLead: root.scoreLead ?? 0,
      scoreStdev: root.scoreStdev,
      utility: root.utility,
    };
  }

  // move 子段
  while (i < tokens.length) {
    const tok = tokens[i];
    if (tok === 'move') {
      const moveName = tokens[++i];
      currentMove = moveName;
      const info: GtpMoveInfo = {
        move: moveName,
        visits: 0,
        winRate: 0,
        scoreLead: 0,
        pv: [],
      };
      out.moveInfos!.set(moveName, info);
      i++;
      continue;
    }
    if (currentMove && out.moveInfos!.has(currentMove)) {
      const info = out.moveInfos!.get(currentMove)!;
      switch (tok) {
        case 'visits':
          info.visits = parseInt(tokens[++i], 10);
          break;
        case 'winrate':
          info.winRate = parseFloat(tokens[++i]);
          break;
        case 'scoreLead':
          info.scoreLead = parseFloat(tokens[++i]);
          break;
        case 'scoreStdev':
          info.scoreStdev = parseFloat(tokens[++i]);
          break;
        case 'utility':
          info.utility = parseFloat(tokens[++i]);
          break;
        case 'lcb':
          info.lcb = parseFloat(tokens[++i]);
          break;
        case 'pv':
          // pv 后面一直到下一个关键字
          const pvTokens: string[] = [];
          i++;
          while (i < tokens.length && !['move', 'visits', 'winrate', 'scoreLead', 'policy', 'order', 'ownership'].includes(tokens[i])) {
            pvTokens.push(tokens[i]);
            i++;
          }
          info.pv = pvTokens;
          continue;
        case 'policy':
          info.policy = parseFloat(tokens[++i]);
          break;
        case 'prior':
          // KataGo uses 'prior' (policy prior probability) instead of 'policy'
          (info as any).prior = parseFloat(tokens[++i]);
          break;
        case 'order':
          info.order = parseInt(tokens[++i], 10);
          break;
        default:
          i++;
      }
      i++;
    } else {
      i++;
    }
  }

  return out;
}

/**
 * 解析 kata-set_rules 给的 ownership 字符串 (按 board 顺序,从左上到右下)
 * KataGo 输出: ownership <space-separated 361 values for 19x19>
 */
export function parseOwnership(blob: string, boardSize: number): number[][] {
  const tokens = blob.trim().split(/\s+/);
  const grid: number[][] = [];
  for (let r = 0; r < boardSize; r++) {
    const row: number[] = [];
    for (let c = 0; c < boardSize; c++) {
      const idx = r * boardSize + c;
      const v = parseFloat(tokens[idx] ?? '0');
      row.push(isNaN(v) ? 0 : v);
    }
    grid.push(row);
  }
  return grid;
}

/**
 * 解析 kata-search_analyze 的 policy (整个 board 的概率)
 */
export function parsePolicy(blob: string, boardSize: number): number[][] {
  return parseOwnership(blob, boardSize); // 同格式
}

/**
 * GTP move (e.g. "Q16") → GTPCoord (row, col, 0-indexed)
 */
export function gtpMoveToCoord(move: string, boardSize = 19): { row: number; col: number; pass: boolean } | null {
  if (move === 'pass' || move === 'PASS' || move === 'resign') {
    return { row: -1, col: -1, pass: true };
  }
  // GTP format: <column letter>(skipping I)<row number>
  // e.g. Q16 → col Q = 16 (A=0, B=1, ..., H=7, J=8, ..., Q=16), row 16 → 15 (0-indexed)
  const colChar = move[0]?.toUpperCase();
  if (!colChar) return null;
  let col: number;
  if (colChar === 'I') return null; // I is skipped in GTP
  col = colChar.charCodeAt(0) - 'A'.charCodeAt(0);
  if (colChar > 'I') col--; // adjust for skipping I
  const row = parseInt(move.slice(1), 10) - 1;
  if (isNaN(row) || row < 0 || row >= boardSize) return null;
  if (col < 0 || col >= boardSize) return null;
  return { row, col, pass: false };
}

/**
 * Coord → GTP move
 */
export function coordToGtpMove(row: number, col: number, boardSize = 19): string {
  let letter = String.fromCharCode('A'.charCodeAt(0) + col);
  if (letter >= 'I') letter = String.fromCharCode(letter.charCodeAt(0) + 1);
  return `${letter}${row + 1}`;
}

/**
 * 把 GtpAnalysisRaw 累积成 Analysis
 */
export function buildGtpAnalysis(opts: {
  raw: GtpAnalysisRaw;
  engine: string;
  boardSize: number;
  playerColor: 'B' | 'W';
  ownership?: number[][];
}): Analysis {
  const lines: PvLine[] = [];
  // 多线: 取 visit 数前 N
  const sorted = Array.from(opts.raw.moveInfos?.values() ?? [])
    .sort((a, b) => b.visits - a.visits)
    .slice(0, 5);
  for (let i = 0; i < sorted.length; i++) {
    const info = sorted[i];
    // winRate 从 KataGo 是 side-to-move 视角; 玩家执子视角需转换
    let winRate = info.winRate;
    if (opts.playerColor === 'W') winRate = 1 - winRate;
    lines.push({
      id: i + 1,
      move: info.move,
      pv: info.pv ?? [info.move],
      winRate,
    });
  }

  // policy 热力图 (按玩家概率,可用于可视化)
  const policy: number[][] = [];
  for (let r = 0; r < opts.boardSize; r++) {
    const row: number[] = [];
    for (let c = 0; c < opts.boardSize; c++) {
      row.push(0);
    }
    policy.push(row);
  }
  if (opts.raw.moveInfos) {
    for (const info of opts.raw.moveInfos.values()) {
      const coord = gtpMoveToCoord(info.move, opts.boardSize);
      // 优先用 'prior' (KataGo 格式), fallback 到 'policy'
      const priorProb = (info as any).prior ?? info.policy;
      if (coord && !coord.pass && priorProb !== undefined) {
        policy[coord.row][coord.col] = priorProb;
      }
    }
  }

  // 胜率: rootInfo.winRate 是 side-to-move 视角, 玩家执白则翻转
  const rootWr = opts.raw.rootInfo?.winRate ?? 0.5;
  const winRate = opts.playerColor === 'W' ? 1 - rootWr : rootWr;
  const scoreLead = opts.raw.rootInfo?.scoreLead ?? 0;

  return {
    variant: 'go',
    depth: opts.raw.rootInfo ? Math.round((opts.raw.rootInfo.utility ?? 0) * 100) : 0,
    winRate,
    scoreCp: Math.round(scoreLead * 100), // KataGo scoreLead → centipoints
    multiPv: lines,
    engine: opts.engine,
    ts: Date.now(),
    policy,
    ownership: opts.ownership,
  };
}