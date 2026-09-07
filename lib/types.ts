// Chess AI Hub — global types
// 适配三棋种的统一类型定义

export type GameVariant = 'chess' | 'xiangqi' | 'go';

export type Side = 'white' | 'black' | 'red' | 'first' | 'second';

// 棋种 - 选边术语映射
export interface SideConfig {
  variant: GameVariant;
  sides: readonly Side[]; // 可选的边
  primary: Side; // 用户执子 (主关键词)
  opponent: Side;
}

// === UCI move (国际象棋 + 中国象棋 Pikafish 都用) ===
// e.g. "e2e4" / "h2e2"
export type UciMove = string;

// === GTP move (围棋) ===
// e.g. "Q16" / "D4" / "pass"
export type GtpMove = string;

// === 引擎分析结果 (三棋种统一) ===
export interface Analysis {
  variant: GameVariant;
  depth: number;
  selDepth?: number;
  nodes?: number;
  nps?: number;
  timeMs?: number;
  // 胜率 (0~1),从用户执子视角
  winRate: number;
  // 棋种特定评估
  scoreCp?: number; // centipawn (chess / xiangqi)
  scoreMate?: number; // 正: 用户赢 N 步, 负: 用户输 N 步 (null=无)
  // 多线推荐着法
  multiPv: PvLine[];
  // 围棋特有: policy 热力图 (每个交叉点的概率)
  policy?: number[][];
  // 围棋特有: ownership (每个点预期归属: 1=black, -1=white, 0=neutral)
  ownership?: number[][];
  // 引擎名 + 协议
  engine: string;
  // 时间戳
  ts: number;
}

export interface PvLine {
  id: number; // multipv index (1-based)
  move: string; // 推荐着法
  pv: string[]; // principal variation (后续着法)
  winRate: number;
  scoreCp?: number;
  scoreMate?: number;
}

// === 引擎状态 ===
export type EngineStatus = 'idle' | 'starting' | 'ready' | 'thinking' | 'errored' | 'stopped';

export interface EngineState {
  variant: GameVariant;
  status: EngineStatus;
  currentAnalysis?: Analysis;
  lastError?: string;
}

// === 棋局状态 (三棋种轻量化状态) ===
export interface GameState {
  variant: GameVariant;
  // 国际象棋: FEN; 中国象棋: 自定义 FEN-like; 围棋: GTPCoord 列表
  fen: string;
  moves: MoveRecord[];
  // 当前轮到谁
  turn: Side;
  // 玩家执子
  playerSide: Side;
  // 游戏结束状态
  result?: GameResult;
}

export interface MoveRecord {
  // 1-indexed
  ply: number;
  move: string;
  // 解析后的人类可读表达 (围棋: Q16, 国际象棋: e4, 中国象棋: 炮二平五)
  san: string;
  // 该步之后的胜率 (从玩家视角)
  winRate?: number;
  // 该步之后的 cp / score
  scoreCp?: number;
  // 该步的分析来源
  pv?: string[];
  comment?: string;
}

export interface GameResult {
  winner?: Side;
  reason: 'checkmate' | 'stalemate' | 'resign' | 'timeout' | 'repetition' | 'pass' | 'resign-lost' | 'pass-tied' | 'points';
  detail?: string;
}

// === 分析请求 ===
export interface AnalyzeRequest {
  variant: GameVariant;
  fen?: string;
  moves?: string[];
  depth?: number;
  multipv?: number;
  timeMs?: number;
}

export interface AnalyzeResponse {
  variant: GameVariant;
  ok: boolean;
  analysis?: Analysis;
  error?: string;
}

// === API Routes 通用 wrapper ===
export interface ApiOk<T> { ok: true; data: T }
export interface ApiErr { ok: false; error: string }
export type ApiResult<T> = ApiOk<T> | ApiErr;