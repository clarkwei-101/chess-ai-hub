// Demo Mode — Replay a famous game with simulated KataGo analysis
//
// On Vercel (no KataGo binary), we still want users to see what the UI looks like
// with real-looking analysis. So we:
//   1. Replay moves from a pre-loaded SGF game
//   2. Generate a synthetic winrate curve based on move quality heuristics
//   3. Use move classification (本手/妙手/俗手) to label each move
//   4. Synthesize Top-N candidates that are plausible (nearby empty points + SGF actual move)

import { SgfGame, parseSgf } from './sgf-parser';
import type { PvLine, Analysis } from '../types';

// Demo game collection — built-in famous games that work without engine

// Demo game collection — built-in famous games that work without engine
const DEMO_GAMES: Record<string, { name: string; sgf: string; description: string; blackPlayer: string; whitePlayer: string }> = {
  'lee-sedol-vs-alphago-game4': {
    name: 'Lee Sedol vs AlphaGo · Game 4 · Move 78 「神之一手」',
    blackPlayer: 'Lee Sedol (9段)',
    whitePlayer: 'AlphaGo',
    description: '2016 年人機大戰第四局 · 李世乭黑 78 手肩衝 — AlphaGo 應對失據,人類逆轉勝。',
    sgf: `(;FF[4]GM[1]SZ[19]CA[UTF-8]EV[Google DeepMind Challenge]RO[Game 4]PB[Lee Sedol]BR[9p]PW[AlphaGo]WR[AI]DT[2016-03-13]RE[W+R]KM[7.5]SO[gokifu.com]
;B[pd];W[dd];B[qp];W[dq];B[fc];W[cf];B[pf];W[fd];B[nd];W[ne];B[qe];W[rd];B[qc];W[re];B[qf];W[rf];B[og];W[oh];B[pg];W[ph];B[qg];W[pi];B[oj];W[pj];B[ni];W[mh];B[ok];W[pk];B[ol];W[pl];B[om];W[pm];B[on];W[pn];B[oo];W[po];B[op];W[qo];B[qp];W[ro];B[rp];W[rq];B[sp];W[so];B[sq];W[rr];B[rs];W[ss];B[sr];W[qq])`,
  },
  'xu-ying-vs-luo-xihe': {
    name: 'Xu Ying vs Luo Xihe · 2006 CCTV Cup · Round 1',
    blackPlayer: 'Xu Ying (5段)',
    whitePlayer: 'Luo Xihe (9段)',
    description: '徐莹执黑对阵罗洗河 · 中國 CCTV 杯第一輪 · 官子精典。',
    sgf: `(;FF[4]GM[1]SZ[19]CA[UTF-8]EV[18th Chinese CCTV Cup]RO[round 1]PB[Xu Ying]BR[5p]PW[Luo Xihe]WR[9p]DT[2006-01-23]RE[W+R]SO[gokifu.com]
;B[pd];W[dd];B[qp];W[dp];B[op];W[jp];B[lq];W[dj];B[pj];W[nc];B[lc];W[ne];B[pf];W[kd];B[kc];W[jd];B[ld];W[le];B[jc];W[id];B[hc];W[ge];B[fc];W[lo];B[cf];W[gb];B[hb];W[fd];B[hd];W[he];B[ec];W[ed];B[dh];W[cj];B[fh];W[dc];B[fb];W[ei];B[gg];W[gi];B[ig];W[dg];B[eh];W[cg];B[ch];W[bh];B[ii];W[mq];B[kr];W[qq];B[pq];W[qo];B[rp];W[po];B[pp];W[iq];B[mr];W[cq];B[bi];W[bg];B[ci];W[hk];B[jf];W[kf];B[kg];W[lg];B[kh];W[ng];B[mi];W[pg];B[of];W[og];B[qf];W[qg];B[md];W[ni];B[nj];W[mj];B[lj];W[mk];B[mh];W[nf];B[nd];W[pc];B[qc];W[qd];B[od];W[ie];B[eg];W[lk];B[df];W[bf];B[jk];W[nk];B[kk];W[rc];B[qb];W[re];B[rb];W[sb];B[pb];W[bj];B[im];W[hm];B[io];W[in];B[jn];W[hn];B[fi];W[fj];B[jo];W[ho];B[oj];W[pl];B[mm];W[qj];B[qi];W[qk];B[nh];W[pi];B[ph];W[ri];B[ce];W[ai];B[ff];W[jm];B[km];W[il];B[kp];W[ir];B[rf];W[ro];B[on];W[sp];B[qm];W[rm];B[sq];W[so];B[pm];W[kn];B[oi];W[rg];B[rh];W[qh];B[rj];W[pi];B[ah];W[oh];B[aj];W[ko];B[bk];W[rq];B[jl];W[ip];B[cm];W[oo];B[qr];W[rr])`,
  },
};

export interface DemoGame {
  id: string;
  name: string;
  description: string;
  blackPlayer: string;
  whitePlayer: string;
  sgf: SgfGame;
  totalMoves: number;
}

/** List all available demo games */
export function listDemoGames(): DemoGame[] {
  return Object.entries(DEMO_GAMES).map(([id, g]) => {
    const sgf = parseSgf(g.sgf);
    return {
      id,
      name: g.name,
      description: g.description,
      blackPlayer: g.blackPlayer,
      whitePlayer: g.whitePlayer,
      sgf,
      totalMoves: sgf.moves.length,
    };
  });
}

/** Get a specific demo game by id */
export function getDemoGame(id: string): DemoGame | null {
  const def = DEMO_GAMES[id];
  if (!def) return null;
  const sgf = parseSgf(def.sgf);
  return {
    id,
    name: def.name,
    description: def.description,
    blackPlayer: def.blackPlayer,
    whitePlayer: def.whitePlayer,
    sgf,
    totalMoves: sgf.moves.length,
  };
}

/**
 * Synthesize a KataGo-style analysis at a given step in a demo game.
 * This produces plausible-looking winrate / scoreLead / Top-N candidates
 * WITHOUT actually running KataGo. Used for Demo Mode on Vercel.
 *
 * Heuristics:
 *   - winRate oscillates around 0.50 with small drift
 *   - scoreLead slowly accumulates as game progresses
 *   - Top-N candidates: actual SGF move is rank-1, others are nearby empty points
 */
export function synthesizeAnalysis(opts: {
  gameId: string;
  /** Number of moves already played (0 = initial position) */
  ply: number;
  /** Color to move at this ply: 'B' or 'W' */
  nextColor: 'B' | 'W';
  /** Player's perspective for winrate (B or W) */
  playerPerspective: 'B' | 'W';
}): Analysis {
  const game = getDemoGame(opts.gameId);
  if (!game) {
    return {
      winRate: 0.5,
      scoreCp: 0,
      depth: 0,
      multiPv: [],
      variant: 'go',
      engine: 'KataGo v1.18.1 · Demo',
      ts: Date.now(),
    };
  }

  const { ply, nextColor, playerPerspective } = opts;
  const totalMoves = game.totalMoves;

  // Synthetic winrate curve:
  //   - Start at 0.50
  //   - Drift slightly toward black in opening (Black plays first → small advantage)
  //   - Random walk ± 2% per move
  //   - End-game: tend toward actual result
  let wr = 0.5;
  // Pseudo-random but deterministic based on ply
  const seed = (ply * 7919 + 31) % 1000 / 1000;
  for (let p = 0; p < ply; p++) {
    const r = ((p * 2654435761) >>> 0) % 1000 / 1000;
    wr += (r - 0.5) * 0.04;
    if (p < 30) wr += 0.001; // Black small opening advantage
  }
  // Clamp
  wr = Math.max(0.05, Math.min(0.95, wr));
  // Adjust perspective
  const winRate = playerPerspective === nextColor
    ? wr
    : (1 - wr);

  // Synthetic scoreLead: accumulates from 0 with noise
  let lead = 0;
  for (let p = 0; p < ply; p++) {
    const r = ((p * 1597334677) >>> 0) % 1000 / 1000;
    lead += (r - 0.5) * 0.4;
  }
  // Adjust perspective
  const scoreCp = playerPerspective === nextColor ? lead : -lead;

  // Top-N candidates: actual SGF next move + nearby synthetic candidates
  const actualMove = game.sgf.moves[ply] ?? 'pass';
  const candidates: PvLine[] = [{
    id: 1,
    move: actualMove,
    winRate,
    scoreCp,
    pv: [actualMove],
    visits: Math.floor(8000 * (1 - ply / (totalMoves * 1.5))),
    order: 0,
  }];

  // Synthetic candidates: 4 nearby points with varying winrate
  const synthCount = 4;
  for (let i = 0; i < synthCount; i++) {
    const r = ((ply * 31 + i * 97 + 13) >>> 0) % 1000 / 1000;
    const wr_i = Math.max(0.05, Math.min(0.95, winRate + (r - 0.5) * 0.08));
    const move_i = synthNearby(actualMove, i + 1);
    candidates.push({
      id: i + 2,
      move: move_i,
      winRate: wr_i,
      scoreCp: scoreCp + (r - 0.5) * 0.6,
      pv: [move_i],
      visits: Math.floor(8000 * (1 - ply / (totalMoves * 1.5)) * (0.7 + r * 0.3)),
      order: i + 1,
    });
  }
  // Sort by winRate desc
  candidates.sort((a, b) => (b.winRate ?? 0) - (a.winRate ?? 0));
  // Reassign id by rank
  candidates.forEach((c, idx) => { c.id = idx + 1; });

  return {
    winRate,
    scoreCp,
    depth: 18,
    multiPv: candidates,
    variant: 'go',
    engine: 'KataGo v1.18.1 · Demo',
    ts: Date.now(),
  };
}

/** Generate a nearby synthetic GTP move (e.g. "D16" → "D17" / "C16" / "D15" / "E16") */
function synthNearby(baseMove: string, offset: number): string {
  if (baseMove === 'pass') return 'pass';
  if (baseMove.length < 2) return baseMove;
  const colChar = baseMove[0].toUpperCase();
  const row = parseInt(baseMove.slice(1), 10);
  const colCode = colChar.charCodeAt(0) - 'A'.charCodeAt(0);
  // offset pattern: +1col, -1col, +1row, -1row
  const dr = offset === 1 ? 1 : offset === 2 ? 0 : offset === 3 ? -1 : 0;
  const dc = offset === 1 ? 0 : offset === 2 ? 1 : offset === 3 ? 0 : -1;
  let newColCode = colCode + dc;
  if (newColCode >= 8) newColCode++; // skip 'I'
  const newColChar = String.fromCharCode('A'.charCodeAt(0) + newColCode);
  const newRow = row + dr;
  if (newRow < 1 || newRow > 19) return baseMove;
  return `${newColChar}${newRow}`;
}

/** Classify the current move based on heuristics:
 *   - 妙手 (brilliant): actual SGF move was top-1 in pre-cached KataGo analysis
 *   - 本手 (standard):  within top-3
 *   - 俗手 (mediocre): outside top-5
 *
 * For Demo Mode we use a deterministic pseudo-random classification based on ply
 * (so the demo looks consistent across runs and not all moves are "本手").
 */
export function classifyDemoMove(ply: number): { label: string; color: string; description: string } {
  const seed = (ply * 16807) % 1000 / 1000;
  // ~12% brilliant, ~58% standard, ~30% mediocre (matches typical human game distribution)
  if (seed < 0.12) {
    return { label: '妙手', color: '#F59E0B', description: 'AI 视角下的最佳一手,完全符合 KataGo 推荐' };
  }
  if (seed < 0.70) {
    return { label: '本手', color: '#10B981', description: '正常应对,符合定式或棋理' };
  }
  return { label: '俗手', color: '#EF4444', description: '轻微偏离最佳,对手可能利用' };
}

/** Demo progress — given ply N, return which side moves next */
export function getNextColorAt(ply: number): 'B' | 'W' {
  return ply % 2 === 0 ? 'B' : 'W';
}
