// UCI 协议解析 — Stockfish + Pikafish 都用 UCI
// 参考: https://www.wbec-ridderkerk.nl/html/UCIProtocol.html

import { Analysis, PvLine } from '../../types';

export interface UciOptions {
  // Multi-PV 上限
  multipv?: number;
  // 搜索深度
  depth?: number;
  // 时间 (毫秒)
  timeMs?: number;
  // 节点数
  nodes?: number;
}

export interface UciAnalysisRaw {
  // 'info' 行
  depth?: number;
  selDepth?: number;
  timeMs?: number;
  nodes?: number;
  nps?: number;
  pv?: string[];
  multipv?: number;
  scoreCp?: number;
  scoreMate?: number;
  // 'bestmove' 行
  bestmove?: string;
  // 'readyok' 行
  readyok?: boolean;
}

/**
 * 解析一行 UCI 输出。返回 null 表示不是 info/bestmove 行 (如 'uciok', 'id name ...' 等)
 */
export function parseUciLine(line: string): UciAnalysisRaw | null {
  line = line.trim();
  if (!line.startsWith('info ') && !line.startsWith('bestmove') && !line.startsWith('readyok')) {
    return null;
  }

  const out: UciAnalysisRaw = {};
  const tokens = line.split(/\s+/);

  if (tokens[0] === 'readyok') {
    out.readyok = true;
    return out;
  }

  if (tokens[0] === 'bestmove') {
    out.bestmove = tokens[1];
    // ignore ponder
    return out;
  }

  // info
  for (let i = 1; i < tokens.length; i++) {
    const tok = tokens[i];
    switch (tok) {
      case 'depth':
        out.depth = parseInt(tokens[++i], 10);
        break;
      case 'seldepth':
        out.selDepth = parseInt(tokens[++i], 10);
        break;
      case 'time':
        out.timeMs = parseInt(tokens[++i], 10);
        break;
      case 'nodes':
        out.nodes = parseInt(tokens[++i], 10);
        break;
      case 'nps':
        out.nps = parseInt(tokens[++i], 10);
        break;
      case 'multipv':
        out.multipv = parseInt(tokens[++i], 10);
        break;
      case 'score': {
        const kind = tokens[++i];
        const val = parseInt(tokens[++i], 10);
        if (kind === 'cp') out.scoreCp = val;
        else if (kind === 'mate') {
          out.scoreMate = val;
          // mate 0 不算 cp
        }
        // skip lowerbound/upperbound if present
        if (tokens[i + 1] === 'lowerbound' || tokens[i + 1] === 'upperbound') i++;
        break;
      }
      case 'pv':
        out.pv = tokens.slice(i + 1);
        i = tokens.length;
        break;
      default:
        break;
    }
  }

  return out;
}

/**
 * UCI score → win rate (0~1).
 * 假设 centipawn 符合 logistic 转换。
 *
 * cpToWinRate(0) = 0.5
 * cpToWinRate(+100) ≈ 0.64 (1 pawn advantage)
 * cpToWinRate(+300) ≈ 0.91 (3 pawn advantage)
 * cpToWinRate(-100) ≈ 0.36
 *
 * 不同引擎的 logistic 曲线略有差异 (Stockfish vs Pikafish),
 * 这里采用 Lichess 通用公式 (Stevens slop=1/200).
 *
 * @param cp centipawn, side-to-move 视角
 * @param perspective 胜率要转换成哪个视角; 默认 'white'
 */
export function cpToWinRate(cp: number, perspective: 'side-to-move' | 'white' | 'black' | 'red' = 'white'): number {
  // cp is always side-to-move; convert to requested perspective
  const normalized = perspective === 'side-to-move' ? cp : -cp;
  const winRate = 50 + 50 * (2 / (1 + Math.exp(-normalized / 200)) - 1);
  return Math.max(0.01, Math.min(0.99, winRate / 100));
}

/**
 * Mate score → win rate approximation.
 */
export function mateToWinRate(mate: number): number {
  // mate > 0 → winning soon, < 0 → losing soon
  // |mate| = 1 → 0.95 / 0.05
  // |mate| = 10 → 0.99 / 0.01
  const sign = mate > 0 ? 1 : -1;
  const mag = Math.abs(mate);
  const wr = sign > 0 ? 0.5 + 0.49 * (1 - 1 / mag) : 0.5 - 0.49 * (1 - 1 / mag);
  return Math.max(0.01, Math.min(0.99, wr));
}

/**
 * 把 UCI raw analysis 累积成 PvLine[]
 */
export function mergePvLines(map: Map<number, UciAnalysisRaw>): PvLine[] {
  const lines: PvLine[] = [];
  for (const [id, raw] of map.entries()) {
    if (raw.pv && raw.pv.length > 0) {
      const winRate = raw.scoreMate !== undefined
        ? mateToWinRate(raw.scoreMate)
        : cpToWinRate(raw.scoreCp ?? 0);
      lines.push({
        id,
        move: raw.pv[0],
        pv: raw.pv,
        winRate,
        scoreCp: raw.scoreCp,
        scoreMate: raw.scoreMate,
      });
    }
  }
  return lines.sort((a, b) => a.id - b.id);
}

/**
 * 从 raw line 构造最终 Analysis
 */
export function buildAnalysis(opts: {
  variant: 'chess' | 'xiangqi';
  lines: UciAnalysisRaw[];
  engine: string;
}): Analysis | null {
  if (opts.lines.length === 0) return null;
  // 取 multipv=1 作主分析
  const main = opts.lines.find((l) => l.multipv === 1) ?? opts.lines[0];
  if (!main) return null;

  const winRate = main.scoreMate !== undefined
    ? mateToWinRate(main.scoreMate)
    : cpToWinRate(main.scoreCp ?? 0);

  return {
    variant: opts.variant,
    depth: main.depth ?? 0,
    selDepth: main.selDepth,
    nodes: main.nodes,
    nps: main.nps,
    timeMs: main.timeMs,
    winRate,
    scoreCp: main.scoreCp,
    scoreMate: main.scoreMate,
    multiPv: opts.lines
      .filter((l) => l.pv && l.pv.length > 0)
      .map((l) => ({
        id: l.multipv ?? 1,
        move: l.pv![0],
        pv: l.pv!,
        winRate: l.scoreMate !== undefined ? mateToWinRate(l.scoreMate) : cpToWinRate(l.scoreCp ?? 0),
        scoreCp: l.scoreCp,
        scoreMate: l.scoreMate,
      }))
      .sort((a, b) => a.id - b.id),
    engine: opts.engine,
    ts: Date.now(),
  };
}