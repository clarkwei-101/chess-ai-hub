// SGF Parser + Style Pattern Miner
// 把徐莹 (及所有大师) 的 SGF 棋谱转换成机器可读的策略树
//
// 输出:
//   - OpeningSequences: 每个开局模式 (前 30 手) 出现次数 + 平均胜率
//   - MoveTransitionTable: position_hash → move (该大师在此局面下最爱走的一手)
//   - EndgameYosePatterns: 终局收官模式
//   - StyleSignature: 该大师的整体签名 (3-3 比例 / 星位比例 / 战斗频率)

import * as fs from 'fs';
import * as path from 'path';

// ============ 类型定义 ============

export interface SgfNode {
  // 节点属性
  PB?: string; // 黑棋选手
  PW?: string; // 白棋选手
  BR?: string; // 黑段位
  WR?: string; // 白段位
  RE?: string; // 结果 e.g. "B+R", "W+0.5"
  DT?: string; // 日期
  EV?: string; // 赛事
  KM?: string; // K-value
  RU?: string; // 规则 (Chinese/TT)
  SZ?: string; // 棋盘大小
  // 着法
  B?: string; // 黑走 (GTP vertex)
  W?: string; // 白走
}

export interface ParsedGame {
  black: string;
  white: string;
  blackRank?: string;
  whiteRank?: string;
  result: 'B' | 'W' | 'Draw' | '?';
  komi: number;
  rules: 'chinese' | 'tromp-taylor' | 'japanese' | 'korean';
  boardSize: number;
  moves: string[]; // GTP vertex sequence (无 'B'/'W' 前缀,按顺序)
  event?: string;
  date?: string;
}

export interface PositionHash {
  // 用 (lastK moves + side-to-move) 作为 hash key
  key: string;
  size: number;
}

export interface MoveTransition {
  positionKey: string;     // hash(前 N 手 + side-to-move)
  sideToMove: 'B' | 'W';
  move: string;             // GTP vertex e.g. "Q16"
  count: number;            // 该大师在此局面下走这步的次数
  gamesObserved: number;    // 该局面在多少盘不同对局中出现过
  winCount: number;         // 走这步之后赢了
}

export interface OpeningSequence {
  sequence: string[];       // 前 N 步 (e.g. ["D4", "Q16", "D16"])
  count: number;            // 出现次数
  winRate: number;          // 该序列后续的平均胜率 (从序列方视角)
  winningSide: 'B' | 'W' | 'mixed';
}

export interface EndgameYosePattern {
  movesFromEnd: number;     // 离终局多少步
  side: 'B' | 'W';
  sequence: string[];       // 终局片段
  frequency: number;        // 该终局模式出现次数
}

export interface StyleSignature {
  // 棋盘占用偏好
  corner3Rate: number;      // 3-3 比例
  starRate: number;         // 星位比例
  smallRate: number;        // 小目比例
  highRate: number;         // 高目比例
  tengenRate: number;       // 天元比例
  // 棋风特征
  fightingRate: number;     // 主动战斗比例 (从断/扳/挖等激进入侵次数推算)
  cornerOpeningRate: number; // 第一步走角的概率
  // 时序特征
  avgGameLength: number;    // 平均对局长度
  earlyYoseRate: number;    // 早期进入收官的比率 (move < 200 即开始收官)
}

export interface StyleKnowledgeBase {
  playerId: string;
  playerName: string;
  totalGames: number;
  totalMoves: number;
  openingSequences: OpeningSequence[];      // Top-K
  moveTransitions: MoveTransition[];         // 全部
  yosePatterns: EndgameYosePattern[];         // 全部
  signature: StyleSignature;
  builtAt: string;
}

// ============ SGF 解析 ============

/** 解析单个 SGF 文件 */
export function parseSgf(content: string): ParsedGame | null {
  // 提取根节点属性
  const rootMatch = content.match(/\(([^)]*)\)/);
  if (!rootMatch) return null;
  const rootBody = rootMatch[1];

  // 提取属性
  const getAttr = (key: string): string | undefined => {
    const m = rootBody.match(new RegExp(`${key}\\[([^\\]]*)\\]`));
    return m?.[1];
  };

  const PB = getAttr('PB') ?? '';
  const PW = getAttr('PW') ?? '';
  const RE = getAttr('RE') ?? '?';
  const SZ = parseInt(getAttr('SZ') ?? '19', 10);
  const KM = parseFloat(getAttr('KM') ?? '7.5');
  const RU = getAttr('RU') ?? 'Chinese';

  const rules: ParsedGame['rules'] =
    RU.toLowerCase().includes('chinese') ? 'chinese' :
    RU.toLowerCase().includes('tt') ? 'tromp-taylor' :
    RU.toLowerCase().includes('japanese') ? 'japanese' :
    RU.toLowerCase().includes('korean') ? 'korean' : 'chinese';

  // 提取所有着法: ;B[xx];W[yy];B[zz]...
  const moveRegex = /;([BW])\[([a-s][a-s])\]/g;
  const moves: string[] = [];
  let m;
  while ((m = moveRegex.exec(rootBody)) !== null) {
    // 'pass' 直接保留, GTP vertex 也保留
    moves.push(m[2]);
  }

  // 结果解析
  let result: ParsedGame['result'] = '?';
  if (RE.startsWith('B')) result = 'B';
  else if (RE.startsWith('W')) result = 'W';
  else if (RE.toLowerCase() === 'draw' || RE === '0') result = 'Draw';

  return {
    black: PB,
    white: PW,
    blackRank: getAttr('BR'),
    whiteRank: getAttr('WR'),
    result,
    komi: KM,
    rules,
    boardSize: SZ,
    moves,
    event: getAttr('EV'),
    date: getAttr('DT'),
  };
}

// ============ Position Hashing ============

/** 把局面 hash 成 key: 用最近 K 手 + side-to-move */
export function hashPosition(
  moves: string[],
  sideToMove: 'B' | 'W',
  historyDepth = 8,
): string {
  const recent = moves.slice(-historyDepth);
  return `${recent.join(' ')}|${sideToMove}`;
}

// ============ 风格挖掘 ============

/** 从棋谱目录挖掘某位棋手的全部风格数据 */
export function minePlayerStyle(
  gamesDir: string,
  playerId: string,
  playerNames: string[],     // 该棋手可能的姓名变体 (e.g. ['Xu Ying', '徐莹'])
  options: {
    openingDepth?: number;   // 开局序列长度 (default 12)
    transitionDepth?: number; // 转换哈希深度 (default 6)
    yoseThreshold?: number;   // 终局片段长度 (default 30)
  } = {},
): StyleKnowledgeBase {
  const openingDepth = options.openingDepth ?? 12;
  const transitionDepth = options.transitionDepth ?? 6;
  const yoseThreshold = options.yoseThreshold ?? 30;

  // 收集该棋手参与的所有 SGF
  const files = fs.existsSync(gamesDir) ? fs.readdirSync(gamesDir).filter((f) => f.endsWith('.sgf')) : [];
  const games: ParsedGame[] = [];
  for (const f of files) {
    const content = fs.readFileSync(path.join(gamesDir, f), 'utf-8');
    const parsed = parseSgf(content);
    if (!parsed) continue;
    // 检查是否该棋手参与了
    const isInvolved =
      playerNames.some((n) => parsed.black.toLowerCase().includes(n.toLowerCase())) ||
      playerNames.some((n) => parsed.white.toLowerCase().includes(n.toLowerCase()));
    if (!isInvolved) continue;
    games.push(parsed);
  }

  // 1. 开局序列 (前 N 手, 不区分黑白 — 因为同一个开局可能黑/白各走一次)
  const openingMap = new Map<string, { seq: string[]; count: number; win: number; lose: number }>();
  for (const g of games) {
    const opening = g.moves.slice(0, openingDepth);
    if (opening.length < openingDepth) continue;
    const key = opening.join(' ');
    const entry = openingMap.get(key) ?? { seq: opening, count: 0, win: 0, lose: 0 };
    entry.count += 1;
    if (g.result !== 'Draw' && g.result !== '?') entry.win += 1;
    openingMap.set(key, entry);
  }

  const openingSequences: OpeningSequence[] = Array.from(openingMap.entries())
    .map(([key, v]) => {
      // 确定 winning side
      let winningSide: OpeningSequence['winningSide'] = 'mixed';
      // 因为我们无法直接判定 (同一序列可能 B/W 各走一次),此处用 wins > loses 推算
      if (v.win > v.count * 0.6) winningSide = 'B';
      else if (v.lose > v.count * 0.6) winningSide = 'W';
      return {
        sequence: v.seq,
        count: v.count,
        winRate: v.count > 0 ? v.win / v.count : 0,
        winningSide,
      };
    })
    .filter((o) => o.count >= 1)
    .sort((a, b) => b.count - a.count)
    .slice(0, 50); // Top-50 开局

  // 2. 转换表 (在该棋手执子时, position_hash → next move)
  //    我们要的是这位棋手的"代表走法",所以只看 ta 是 B/W 时的走法
  const transMap = new Map<string, { side: 'B' | 'W'; move: string; count: number; games: Set<string>; wins: number }>();
  for (const g of games) {
    // 检查该棋手是 B 还是 W
    const isBlack = playerNames.some((n) => g.black.toLowerCase().includes(n.toLowerCase()));
    const isWhite = playerNames.some((n) => g.white.toLowerCase().includes(n.toLowerCase()));
    if (!isBlack && !isWhite) continue;
    const playerSide: 'B' | 'W' = isBlack ? 'B' : 'W';

    for (let i = 0; i < g.moves.length; i++) {
      if ((i % 2 === 0 ? 'B' : 'W') !== playerSide) continue; // 只看这位棋手自己走的
      const sideAtThisMove: 'B' | 'W' = i % 2 === 0 ? 'B' : 'W';
      // hash = 走这步之前的历史
      const key = hashPosition(g.moves.slice(0, i), sideAtThisMove, transitionDepth);
      const move = g.moves[i];
      const entry = transMap.get(key) ?? { side: sideAtThisMove, move, count: 0, games: new Set(), wins: 0 };
      // 因为 transMap key 已经包含 side-to-move, 所以 entry.side 应该和 key 的 side 一致
      entry.count += 1;
      entry.games.add(g.event ?? g.date ?? '?');
      if (g.result === playerSide) entry.wins += 1;
      transMap.set(key, entry);
    }
  }

  const moveTransitions: MoveTransition[] = Array.from(transMap.entries())
    .map(([key, v]) => ({
      positionKey: key,
      sideToMove: v.side,
      move: v.move,
      count: v.count,
      gamesObserved: v.games.size,
      winCount: v.wins,
    }))
    .sort((a, b) => b.count - a.count);

  // 3. 终局模式 (最后 N 手)
  const yosePatterns: EndgameYosePattern[] = [];
  const yoseMap = new Map<string, { movesFromEnd: number; side: 'B' | 'W'; seq: string[]; freq: number }>();
  for (const g of games) {
    if (g.moves.length < yoseThreshold) continue;
    const tail = g.moves.slice(-yoseThreshold);
    const tailKey = tail.join(' ');
    const entry = yoseMap.get(tailKey) ?? { movesFromEnd: yoseThreshold, side: 'B', seq: tail, freq: 0 };
    entry.freq += 1;
    yoseMap.set(tailKey, entry);
  }
  for (const v of Array.from(yoseMap.values())) {
    yosePatterns.push({
      movesFromEnd: v.movesFromEnd,
      side: v.side,
      sequence: v.seq,
      frequency: v.freq,
    });
  }
  yosePatterns.sort((a, b) => b.frequency - a.frequency);

  // 4. Style signature
  let corner3 = 0, star = 0, small = 0, high = 0, tengen = 0;
  let cornerFirstMoves = 0;
  let totalFirstMoves = 0;
  let totalLength = 0;
  for (const g of games) {
    if (g.moves.length === 0) continue;
    totalLength += g.moves.length;
    const first = g.moves[0];
    totalFirstMoves += 1;
    // GTP vertex → (col, row)
    const colChar = first[0]?.toUpperCase();
    const row = parseInt(first.slice(1), 10);
    if (!colChar) continue;
    let col = colChar.charCodeAt(0) - 'A'.charCodeAt(0);
    if (colChar >= 'I') col--;
    // 4-4 points (corner): col in 3-4, row in 3-4 (corner area)
    // 3-3: col==2 or col==16, row==2 or row==16
    const is3_3 = (col === 2 || col === 16) && (row === 3 || row === 17);
    const is4_4 = (col === 3 || col === 15) && (row === 4 || row === 16);
    const isStar = (col === 3 || col === 15) && (row === 4 || row === 16);
    const isSmall = (col === 2 || col === 16) && (row === 4 || row === 16);
    const isHigh = (col === 3 || col === 15) && (row === 3 || row === 17);
    const isTengen = col === 9 && row === 10;
    if (is3_3 || is4_4) cornerFirstMoves += 1;
    if (is3_3) corner3++;
    else if (is4_4) star++;
    else if (isSmall) small++;
    else if (isHigh) high++;
    else if (isTengen) tengen++;
  }

  const n = Math.max(games.length, 1);
  const signature: StyleSignature = {
    corner3Rate: corner3 / n,
    starRate: star / n,
    smallRate: small / n,
    highRate: high / n,
    tengenRate: tengen / n,
    fightingRate: 0,          // TODO: 从 move transitions 推算
    cornerOpeningRate: cornerFirstMoves / Math.max(totalFirstMoves, 1),
    avgGameLength: totalLength / n,
    earlyYoseRate: 0,         // TODO: 推算
  };

  return {
    playerId,
    playerName: playerNames[0] ?? playerId,
    totalGames: games.length,
    totalMoves: games.reduce((s, g) => s + g.moves.length, 0),
    openingSequences,
    moveTransitions,
    yosePatterns,
    signature,
    builtAt: new Date().toISOString(),
  };
}

// ============ 应用风格 — 给定局面,返回该棋手最可能走的着法 ============

/**
 * 给定当前局面 (走过的着法 + side-to-move),返回该棋手的推荐着法 + 置信度。
 *
 * 返回 null 表示该棋手在此局面没有数据 (cold-start),由引擎用默认策略。
 */
export function predictPlayerMove(
  kb: StyleKnowledgeBase,
  moves: string[],
  sideToMove: 'B' | 'W',
  transitionDepth = 6,
): { move: string; confidence: number; gamesObserved: number } | null {
  const key = hashPosition(moves, sideToMove, transitionDepth);

  // 1. 精确匹配 — 找完全相同的 key
  const exact = kb.moveTransitions.find((t) => t.positionKey === key);
  if (exact && exact.count >= 1) {
    return {
      move: exact.move,
      confidence: Math.min(1, exact.count / 3),
      gamesObserved: exact.gamesObserved,
    };
  }

  // 2. 模糊匹配 — 取最近 N 手, 找最相似的 key (按公共子串长度)
  let best: MoveTransition | null = null;
  let bestSim = 0;
  const wantedPrefix = moves.slice(-transitionDepth);
  for (const t of kb.moveTransitions) {
    if (t.sideToMove !== sideToMove) continue;
    const tMoves = t.positionKey.split('|')[0].split(' ');
    // 计算公共后缀长度
    let sim = 0;
    for (let i = 1; i <= Math.min(wantedPrefix.length, tMoves.length); i++) {
      if (wantedPrefix.slice(-i).join(' ') === tMoves.slice(-i).join(' ')) {
        sim = i;
      } else break;
    }
    if (sim > bestSim) {
      bestSim = sim;
      best = t;
    }
  }
  if (best && bestSim >= Math.max(2, transitionDepth - 2)) {
    return {
      move: best.move,
      confidence: 0.3 + 0.4 * (bestSim / transitionDepth),
      gamesObserved: best.gamesObserved,
    };
  }

  return null;
}

/** 用 StyleKB 生成 KataGo 可以接受的 priorPolicy 热力图。
 *  返回 19x19 网格,每个交叉点是该棋手在此局面下走这一步的概率 [0,1].
 *  找不到数据的位置返回 0 (KataGo 会忽略这些 prior).
 */
export function buildPriorPolicy(
  kb: StyleKnowledgeBase,
  moves: string[],
  sideToMove: 'B' | 'W',
  boardSize = 19,
): { grid: number[][]; predictedMove: string | null; confidence: number } {
  const grid: number[][] = Array.from({ length: boardSize }, () => Array(boardSize).fill(0));

  // 用转换表里所有与当前 sideToMove 匹配 + 历史相近的 entry
  const wantedPrefix = moves.slice(-6);
  const candidates: { move: string; weight: number }[] = [];

  for (const t of kb.moveTransitions) {
    if (t.sideToMove !== sideToMove) continue;
    const tMoves = t.positionKey.split('|')[0].split(' ');
    let sim = 0;
    for (let i = 1; i <= Math.min(wantedPrefix.length, tMoves.length); i++) {
      if (wantedPrefix.slice(-i).join(' ') === tMoves.slice(-i).join(' ')) sim = i;
      else break;
    }
    if (sim === 0) continue;
    // weight = count × 相似度 × win-rate
    const winRate = t.count > 0 ? t.winCount / t.count : 0.5;
    const weight = t.count * (sim / 6) * (0.5 + winRate);
    candidates.push({ move: t.move, weight });
  }

  // 软化: 最高权重归一化到 0.6,其余按比例缩放
  let maxW = 0;
  for (const c of candidates) maxW = Math.max(maxW, c.weight);
  let topMove: string | null = null;
  let topWeight = 0;

  for (const c of candidates) {
    const coord = gtpToCoordForSgf(c.move, boardSize);
    if (!coord || coord.pass) continue;
    const norm = maxW > 0 ? (c.weight / maxW) * 0.6 : 0;
    grid[coord.row][coord.col] = Math.max(grid[coord.row][coord.col], norm);
    if (c.weight > topWeight) {
      topWeight = c.weight;
      topMove = c.move;
    }
  }

  return {
    grid,
    predictedMove: topMove,
    confidence: maxW > 0 ? Math.min(1, topWeight / (maxW * 1.5)) : 0,
  };
}

/** GTP vertex → (row, col) 0-indexed for SGF mining */
function gtpToCoordForSgf(move: string, boardSize: number): { row: number; col: number; pass: boolean } | null {
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

// ============ 缓存 ============

const CACHE_DIR = path.resolve(process.cwd(), 'go-knowledge/.cache');
const CACHE_VERSION = 1;

/** 读缓存: 如果有,返回 cached StyleKnowledgeBase */
export function loadCachedStyle(playerId: string): StyleKnowledgeBase | null {
  const cachePath = path.join(CACHE_DIR, `${playerId}.json`);
  if (!fs.existsSync(cachePath)) return null;
  try {
    const raw = JSON.parse(fs.readFileSync(cachePath, 'utf-8'));
    if (raw.__cacheVersion !== CACHE_VERSION) return null;
    return raw.data as StyleKnowledgeBase;
  } catch {
    return null;
  }
}

/** 写缓存 */
export function saveCachedStyle(kb: StyleKnowledgeBase): void {
  if (!fs.existsSync(CACHE_DIR)) fs.mkdirSync(CACHE_DIR, { recursive: true });
  const cachePath = path.join(CACHE_DIR, `${kb.playerId}.json`);
  fs.writeFileSync(
    cachePath,
    JSON.stringify({ __cacheVersion: CACHE_VERSION, data: kb }, null, 2),
    'utf-8',
  );
}
