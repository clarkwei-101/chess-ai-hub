// Game over detector — 判定胜负 (chess / xiangqi / go)
// chess.js 提供 chess.isCheckmate() / isStalemate() / isInsufficientMaterial()
// xiangqi/go 由引擎提示 + 局面特征判断

import { Chess } from 'chess.js';

export type GameOverReason =
  | 'checkmate'         // chess: 将死
  | 'stalemate'         // chess: 困毙
  | 'insufficient-material'
  | 'threefold-repetition'
  | 'fifty-move-rule'
  | 'resign'            // 认输
  | 'timeout'           // 超时
  | 'pass-tied'         // go: 双 pass 和棋
  | 'points'            // go: territory 终局 (KataGo final_score)
  | 'ai-resign'         // AI 自己认输 (rare)
  | 'illegal-move'      // 悔棋 / 错误
  | 'unknown';

export interface GameOverResult {
  over: boolean;
  reason: GameOverReason;
  winner?: 'player' | 'ai' | 'draw';
  detail?: string;
}

/** Chess 检测 */
export function checkChessGameOver(chess: Chess): GameOverResult {
  if (chess.isCheckmate()) {
    return {
      over: true,
      reason: 'checkmate',
      winner: chess.turn() === 'w' ? 'ai' : 'player',
      detail: chess.turn() === 'w' ? '黑方被将死 · 你赢了' : '白方被将死 · AI 赢了',
    };
  }
  if (chess.isStalemate()) {
    return { over: true, reason: 'stalemate', winner: 'draw', detail: '困毙 · 和棋' };
  }
  if (chess.isInsufficientMaterial()) {
    return { over: true, reason: 'insufficient-material', winner: 'draw', detail: '局面不足 · 和棋' };
  }
  if (chess.isThreefoldRepetition()) {
    return { over: true, reason: 'threefold-repetition', winner: 'draw', detail: '三次重复 · 和棋' };
  }
  if (chess.isDraw()) {
    return { over: true, reason: 'fifty-move-rule', winner: 'draw', detail: '和棋' };
  }
  return { over: false, reason: 'unknown' };
}

/**
 * Go 检测 — 引擎 (KataGo) 返回 'pass'/'resign' 标记。
 * UI 拿到连续两次 pass 后用 kata-final_score 判定。
 * 简化: 用 moveHistory 模拟局面 + 连续 pass 数
 */
export function checkGoGameOver(moveHistory: string[]): GameOverResult {
  if (moveHistory.length === 0) return { over: false, reason: 'unknown' };
  const last2 = moveHistory.slice(-2);
  // 连续两次 pass = 双 pass → 和棋 (实际需要 territory scoring,但本地难以判定)
  if (last2.length === 2 && last2[0] === 'pass' && last2[1] === 'pass') {
    return { over: true, reason: 'pass-tied', winner: 'draw', detail: '双 Pass · 等待 territory 计分' };
  }
  // AI resign
  if (moveHistory[moveHistory.length - 1] === 'resign') {
    return { over: true, reason: 'ai-resign', winner: 'player', detail: 'AI 认输 · 你赢了' };
  }
  return { over: false, reason: 'unknown' };
}

/** Xiangqi 检测 — Pikafish 返回 bestmove + 我们自己 track resign pass */
export function checkXiangqiGameOver(moveHistory: string[], fen?: string): GameOverResult {
  if (moveHistory.length === 0) return { over: false, reason: 'unknown' };
  if (moveHistory[moveHistory.length - 1] === 'resign') {
    return { over: true, reason: 'ai-resign', winner: 'player', detail: 'AI 认输 · 你赢了' };
  }
  return { over: false, reason: 'unknown' };
}
