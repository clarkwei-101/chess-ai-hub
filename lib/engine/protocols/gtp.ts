// GTP 协议解析 — KataGo 围棋专用
// KataGo kata-analyze 输出格式: `info move X visits N ... pv X info move Y visits N ...`
// 每个 info 行可能包含 1-N 个候选着法的完整数据(visit/winrate/pv 等),
// 不再有 "turn 1 visits 1" 的 root 段。

import { Analysis, PvLine } from '../../types';

export interface GtpAnalysisRaw {
  turnNumber?: number;
  rootInfo?: {
    winRate: number;
    scoreLead: number;
    scoreStdev?: number;
    utility?: number;
    visits?: number;
  };
  moveInfos?: Map<string, GtpMoveInfo>; // by move string
  isDone?: boolean;
  /** 整个棋盘 ownership (Black territory probability per vertex, 1=Black, -1=White, 0=neutral) */
  ownership?: number[][];
  /** 累积中的 raw ownership tokens (1D) */
  ownershipRaw?: number[];
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
  policy?: number;
  order?: number;
  prior?: number;
}

const STOP_TOKENS = new Set([
  'move', 'visits', 'winrate', 'scoreLead', 'policy', 'order',
  'ownership', 'ownershipStones', 'pvOwnership', 'pvOwnershipStones',
  'info', 'pv', 'lcb', 'utility', 'scoreStdev', 'scoreMean',
  'scoreSelfplay', 'prior', 'edgeVisits', 'weight', 'utilityLcb',
  'isSymmetryOf', 'turn',
]);

/**
 * 解析 GTP kata-analyze 行。
 *
 * KataGo v1.18.1 kata-analyze 实际输出格式:
 *   info move R16 visits 0 prior 0.073 winrate 0.351 scoreLead -1.02 lcb -4.64 order 0 pv R16
 *   info move R4 visits 0 prior 0.045 winrate 0.348 ...
 *   (多个 move 段在同一行内)
 *
 * 注意: 没有 "turn 1 visits 1" 格式的 root 段。
 * rootInfo 从 top-visits move 的数据推导。
 */
export function parseGtpInfoLine(line: string): GtpAnalysisRaw | null {
  if (!line.startsWith('info ')) return null;
  const tokens = line.slice(5).split(/\s+/);
  const out: GtpAnalysisRaw = { moveInfos: new Map() };
  let i = 0;

  // Process token stream: each 'move <name>' starts a new candidate.
  while (i < tokens.length) {
    const tok = tokens[i];

    if (tok === 'move') {
      const moveName = tokens[++i];
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

    // At this point we're processing properties for the current move.
    // Find the current move (last one added to moveInfos).
    let currentMove: string | null = null;
    if (out.moveInfos!.size > 0) {
      // Last added key
      currentMove = Array.from(out.moveInfos!.keys()).at(-1) ?? null;
    }

    if (!currentMove) {
      // No move context yet — skip this token (shouldn't happen with valid KataGo output)
      i++;
      continue;
    }

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
      case 'prior':
        // KataGo uses 'prior' (policy prior probability) instead of 'policy'
        info.prior = parseFloat(tokens[++i]);
        break;
      case 'policy':
        info.policy = parseFloat(tokens[++i]);
        break;
      case 'order':
        info.order = parseInt(tokens[++i], 10);
        break;
      case 'pv': {
        const pvTokens: string[] = [];
        i++;
        while (
          i < tokens.length &&
          !STOP_TOKENS.has(tokens[i])
        ) {
          pvTokens.push(tokens[i]);
          i++;
        }
        info.pv = pvTokens;
        continue; // don't i++
      }
      case 'ownership':
      case 'ownershipStones':
      case 'pvOwnership':
      case 'pvOwnershipStones': {
        // Collect ownership tokens (361 values = 19x19 board)
        if (!out.ownership) out.ownership = [];
        const ownTokens: number[] = [];
        i++;
        while (i < tokens.length && !STOP_TOKENS.has(tokens[i])) {
          const v = parseFloat(tokens[i]);
          if (!isNaN(v)) ownTokens.push(v);
          i++;
        }
        // Convert 1D → 2D (19x19) if we have 361 tokens
        if (out.ownership.length === 0 && ownTokens.length >= 361) {
          for (let r = 0; r < 19; r++) {
            const row: number[] = [];
            for (let c = 0; c < 19; c++) {
              row.push(ownTokens[r * 19 + c] ?? 0);
            }
            out.ownership.push(row);
          }
        }
        continue; // don't i++
      }
      case 'turn':
        out.turnNumber = parseInt(tokens[++i], 10);
        break;
      default:
        // Unknown token — skip its value (the token itself; the value was consumed by switch's i++)
        // Actually unknown tokens appear WITHOUT a following value in KataGo output
        // (edgeVisits, weight, isSymmetryOf, etc.) — just skip the token
        break;
    }
    i++;
  }

  // Derive rootInfo from the best-visited move (KataGokata-analyze has no explicit root line)
  if (!out.rootInfo && out.moveInfos && out.moveInfos.size > 0) {
    let bestMove: GtpMoveInfo | null = null;
    let bestVisits = -1;
    let totalVisits = 0;

    for (const info of out.moveInfos.values()) {
      totalVisits += info.visits;
      if (info.visits > bestVisits) {
        bestVisits = info.visits;
        bestMove = info;
      }
    }

    out.rootInfo = {
      winRate: bestMove?.winRate ?? 0.5,
      scoreLead: bestMove?.scoreLead ?? 0,
      scoreStdev: bestMove?.scoreStdev,
      utility: bestMove?.utility,
      visits: totalVisits,
    };
  }

  return out;
}

/**
 * GTP move (e.g. "Q16") → GTPCoord (row, col, 0-indexed)
 */
export function gtpMoveToCoord(move: string, boardSize = 19): { row: number; col: number; pass: boolean } | null {
  if (move === 'pass' || move === 'PASS' || move === 'resign') {
    return { row: -1, col: -1, pass: true };
  }
  const colChar = move[0]?.toUpperCase();
  if (!colChar || colChar === 'I') return null;
  let col = colChar.charCodeAt(0) - 'A'.charCodeAt(0);
  if (colChar > 'I') col--;
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
 * ownership 不从 kata-analyze 获取 — KataGo kata-analyze 不输出 ownership。
 * 通过 engineManager.requestOwnership() 单独拉取。
 */
export function buildGtpAnalysis(opts: {
  raw: GtpAnalysisRaw;
  engine: string;
  boardSize: number;
  playerColor: 'B' | 'W';
  ownership?: number[][];
}): Analysis {
  const lines: PvLine[] = [];

  // Sort by visits (descending), take top 12
  const sorted = Array.from(opts.raw.moveInfos?.values() ?? [])
    .sort((a, b) => b.visits - a.visits)
    .slice(0, 12);

  for (let i = 0; i < sorted.length; i++) {
    const info = sorted[i];
    // winRate: KataGo is side-to-move perspective; flip for white player
    let winRate = info.winRate;
    if (opts.playerColor === 'W') winRate = 1 - winRate;
    const scoreLead = info.scoreLead;
    const scoreCp = opts.playerColor === 'W' ? -Math.round(scoreLead * 100) : Math.round(scoreLead * 100);

    lines.push({
      id: i + 1,
      move: info.move,
      pv: info.pv ?? [info.move],
      winRate,
      scoreCp,
      visits: info.visits,
      order: info.order,
      prior: info.prior,
    });
  }

  // Policy heatmap (policy prior probability per vertex)
  const policy: number[][] = [];
  for (let r = 0; r < opts.boardSize; r++) {
    policy.push(new Array(opts.boardSize).fill(0));
  }
  if (opts.raw.moveInfos) {
    for (const info of opts.raw.moveInfos.values()) {
      const coord = gtpMoveToCoord(info.move, opts.boardSize);
      const priorProb = info.prior ?? info.policy;
      if (coord && !coord.pass && priorProb !== undefined) {
        policy[coord.row][coord.col] = priorProb;
      }
    }
  }

  // Win rate: rootInfo.winRate is side-to-move perspective; flip for white
  const rootWr = opts.raw.rootInfo?.winRate ?? 0.5;
  const winRate = opts.playerColor === 'W' ? 1 - rootWr : rootWr;
  const scoreLead = opts.raw.rootInfo?.scoreLead ?? 0;

  return {
    variant: 'go',
    depth: opts.raw.rootInfo?.visits ?? 0,
    winRate,
    scoreCp: Math.round(scoreLead * 100),
    multiPv: lines,
    engine: opts.engine,
    ts: Date.now(),
    policy,
    // ownership 从外部传入 (通过 kata-ownership 单独请求)
    ownership: opts.raw.ownership ?? opts.ownership,
  };
}
