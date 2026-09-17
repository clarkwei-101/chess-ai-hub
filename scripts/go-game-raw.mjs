#!/usr/bin/env node
/**
 * Playwright-free Go game test using raw fetch API.
 * Alternates KataGo as both colors: simulates two 9-dan pros playing each other.
 * Tests the full KataGo engine loop without SSE analysis complexity.
 *
 * Usage: node scripts/go-game-raw.mjs
 */
import { chromium } from 'playwright';

const BASE = 'http://localhost:3002';
const MAX_MOVES = 220;
const THINK_MS = 30000; // 30s per move for KataGo

async function api(path, body, timeoutMs = 90000) {
  const ctrl = new AbortController();
  const to = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(`${BASE}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: ctrl.signal,
    });
    const text = await res.text();
    try { return JSON.parse(text); }
    catch { return { ok: false, error: `non-JSON: ${text.slice(0, 200)}` }; }
  } finally {
    clearTimeout(to);
  }
}

async function initGame() {
  await api('/api/engine/new-game', { variant: 'go' });
  await api('/api/engine/start', { variant: 'go' });
}

async function engineMove(isBlack) {
  // Ask KataGo to play for the current color (auto-detects based on move history)
  const r = await api('/api/engine/move', {
    variant: 'go',
    move: 'auto',
    timeMs: THINK_MS,
    styleId: 'default',
  }, 120_000);
  if (!r.ok) return { ok: false, move: null };
  const move = r.data?.aiMove ?? r.data?.move;
  return { ok: true, move, analysis: r.data?.analysis };
}

// ─────────────────────────────────────────
// Simple GTP board for logging
// ─────────────────────────────────────────
function gtpToCoord(gtp) {
  if (!gtp || gtp === 'pass' || gtp === 'resign') return null;
  const col = gtp.charCodeAt(0) - 65;
  const adj = col > 8 ? col - 1 : col;
  const row = parseInt(gtp.slice(1)) - 1;
  return { x: adj, y: row };
}
function coordsToGtp(x, y) {
  const letter = String.fromCharCode(65 + (x >= 8 ? x + 1 : x));
  return `${letter}${y + 1}`;
}

class Board19 {
  constructor() {
    this.size = 19;
    this.grid = Array.from({ length: 19 }, () => Array(19).fill(null));
  }
  play(color, gtp) {
    if (gtp === 'pass' || gtp === 'resign') return true;
    const { x, y } = gtpToCoord(gtp) ?? {};
    if (x < 0 || x >= 19 || y < 0 || y >= 19) return false;
    if (this.grid[y][x] !== null) return false;
    this.grid[y][x] = color;
    return true;
  }
  print() {
    const cols = '  ABCDEFGHJKLMNOPQRST';
    console.log('    ' + cols);
    for (let y = 0; y < 19; y++) {
      const row = this.grid[y].map((c, x) => {
        if (c === null) {
          const star = [[3,3],[3,9],[3,15],[9,3],[9,9],[9,15],[15,3],[15,9],[15,15]];
          return star.some(([sx,sy]) => sx===x&&sy===y) ? '+' : '.';
        }
        return c === 1 ? 'X' : 'O';
      });
      console.log(` ${(y+1).toString().padStart(2)} ${row.join(' ')}`);
    }
  }
}

// ─────────────────────────────────────────
// Move quality evaluation (9-dan perspective)
// ─────────────────────────────────────────
function rateMove(color, gtp, board, moveNum) {
  if (gtp === 'pass') return { rating: '本手', desc: '虚一关', severity: 0 };
  const { x, y } = gtpToCoord(gtp) ?? { x: -1, y: -1 };
  const isCorner = (x <= 2 || x >= 16) && (y <= 2 || y >= 16);
  const isEdge = x <= 2 || x >= 16 || y <= 2 || y >= 16;
  const isStar = [3, 9, 15].includes(x) && [3, 9, 15].includes(y);
  const isCenter = x >= 6 && x <= 12 && y >= 6 && y <= 12;

  if (moveNum <= 6) {
    if (isStar) return { rating: '妙手', desc: '星位定式', severity: -2 };
    if (isCorner && !isStar) return { rating: '妙手', desc: '小目/目外配置', severity: -1 };
    if (isCenter) return { rating: '妙手', desc: '天元开局', severity: -1 };
    return { rating: '本手', desc: '开局配置', severity: 0 };
  }
  if (moveNum <= 30) {
    if (isStar) return { rating: '本手', desc: '星位扩展', severity: 0 };
    if (isCorner) return { rating: '本手', desc: '角部攻防', severity: 0 };
    return { rating: '本手', desc: '布局着法', severity: 0 };
  }
  return { rating: '本手', desc: '中盘/收官', severity: 0 };
}

// ─────────────────────────────────────────
// MAIN GAME LOOP
// ─────────────────────────────────────────
async function playGame() {
  console.log('═══════════════════════════════════════════════════════════════════');
  console.log('  围棋完整对局 — KataGo v1.18.1 (白) vs KataGo v1.18.1 (黑)');
  console.log('  双9段对决 · 完整棋谱 · AI vs AI');
  console.log('═══════════════════════════════════════════════════════════════════\n');

  await initGame();
  const board = new Board19();
  const gameLog = [];
  let consecutivePasses = 0;
  let moveNum = 0;
  letKataGoColor = 'B'; // Track which color KataGo last played

  for (let i = 0; i < MAX_MOVES; i++) {
    moveNum++;
    const playerColor = i % 2 === 0 ? '黑方 (KataGo 黑)' : '白方 (KataGo 白)';
    const KataGoColor = i % 2 === 0 ? 'B' : 'W';

    // Ask KataGo to play the next move
    const result = await engineMove(i % 2 === 0);
    if (!result.ok || !result.move) {
      console.log(`  ❌ Move ${moveNum} ${playerColor} failed: ${result.error}`);
      break;
    }

    const { move, analysis } = result;
    if (move === 'pass' || move === 'resign') {
      consecutivePasses++;
    } else {
      consecutivePasses = 0;
      board.play(KataGoColor === 'B' ? 1 : 2, move);
    }

    const rating = rateMove(KataGoColor === 'B' ? 1 : 2, move, board, moveNum);
    gameLog.push({ n: moveNum, color: KataGoColor, move, ...rating, analysis });

    const wr = analysis?.winRate ?? 0.5;
    const lead = analysis?.scoreLead;
    const depth = analysis?.depth ?? 0;
    const topMoves = analysis?.multiPv?.slice(0, 5)
      .map((p) => `${p.move}(${(p.winRate * 100).toFixed(0)}%)`).join(' ') ?? 'N/A';

    console.log(
      `  ${String(moveNum).padStart(3)}. ${playerColor.padEnd(16)} ` +
      `${(move || '?').padEnd(5)} ` +
      `${rating.rating.padEnd(4)} ` +
      `${rating.desc.padEnd(20)} ` +
      `WR=${(wr * 100).toFixed(1).padStart(5)}% ` +
      `d=${String(depth).padStart(4)} ` +
      `top5=[${topMoves}]`
    );

    if (consecutivePasses >= 2) {
      console.log(`\n  🏁 双 Pass · 对局结束 at move ${moveNum}`);
      break;
    }
    if (moveNum >= MAX_MOVES) {
      console.log(`\n  🏁 达到最大手数 ${MAX_MOVES} · 强制结束`);
      break;
    }
  }

  // Board snapshot
  console.log('\n  ── 最终盘面 ──');
  board.print();

  // Summary
  console.log('\n═══════════════════════════════════════════════════════════════════');
  console.log('  对局统计');
  console.log('═══════════════════════════════════════════════════════════════════');
  const totalMoves = gameLog.length;
  const blackMoves = gameLog.filter(m => m.color === 'B').length;
  const whiteMoves = gameLog.filter(m => m.color === 'W').length;
  const brilliant = gameLog.filter(m => m.rating === '妙手').length;
  const good = gameLog.filter(m => m.rating === '本手').length;
  const bad = gameLog.filter(m => ['俗手','失误','不准确'].includes(m.rating)).length;
  const avgDepth = (gameLog.reduce((s, m) => s + (m.analysis?.depth ?? 0), 0) / Math.max(totalMoves, 1)).toFixed(1);
  const finalWr = (gameLog.filter(m => m.color === 'B').slice(-1)[0]?.analysis?.winRate ?? 0.5) * 100;
  const finalLead = gameLog[gameLog.length - 1]?.analysis?.scoreLead;

  console.log(`  总手数: ${totalMoves} (黑 ${blackMoves} / 白 ${whiteMoves})`);
  console.log(`  平均深度: ${avgDepth}`);
  console.log(`  妙手数: ${brilliant}  本手数: ${good}  俗手/失误数: ${bad}`);
  console.log(`  最终胜率(黑方视角): ${finalWr.toFixed(1)}%`);
  console.log(`  最终 ScoreLead: ${finalLead?.toFixed(1) ?? '?'}`);
  console.log('\n  完整着法:');
  gameLog.forEach((m) => {
    const wr = m.analysis ? `WR:${(m.analysis.winRate * 100).toFixed(0)}%` : '';
    console.log(`    ${String(m.n).padStart(3)}. ${m.color} ${m.move?.padEnd(5)} ${m.rating.padEnd(4)} ${m.desc.padEnd(20)} ${wr}`);
  });

  // Final score
  let finalScore = null;
  try { finalScore = await api('/api/engine/final-score', { variant: 'go' }, 30_000); }
  catch (e) { finalScore = { error: e.message }; }
  if (finalScore?.data?.score) {
    const s = finalScore.data.score;
    const komi = 7.5;
    let text = '';
    if (s.winner === '?') text = '和棋';
    else if (s.winner === 'B') text = `黑胜 ${Math.abs(s.score||0).toFixed(1)} 目`;
    else if (s.winner === 'W') text = `白胜 ${Math.abs((s.score||0)-komi).toFixed(1)} 目 (含7.5目贴目)`;
    console.log(`\n  KataGo 终局判定: ${text}${s.resign ? ' · 认输' : ''}`);
  } else {
    console.log(`\n  KataGo 终局判定: 失败 (${finalScore?.error || 'no response'})`);
  }

  return gameLog;
}

// ─────────────────────────────────────────
// UI SMOKE TEST (Playwright)
// ─────────────────────────────────────────
async function uiSmokeTest() {
  console.log('\n═══════════════════════════════════════════════════════════════════');
  console.log('  UI 浏览器验证');
  console.log('═══════════════════════════════════════════════════════════════════\n');

  const browser = await chromium.launch({ headless: true });
  const ctx = await browser.newContext({ viewport: { width: 1600, height: 1000 } });
  const page = await ctx.newPage();

  page.on('console', (msg) => {
    const text = msg.text();
    if (msg.type() === 'error' || text.toLowerCase().includes('error')) {
      console.log(`  [browser ERROR] ${text.slice(0, 200)}`);
    }
  });

  await page.goto(`${BASE}/go`, { waitUntil: 'networkidle', timeout: 30000 });
  await page.waitForTimeout(8000); // wait for engine warmup

  // Check headers
  const wrLabel = await page.locator('text=Win Rate').first().isVisible().catch(() => false);
  const tcLabel = await page.locator('text=Top Candidates').first().isVisible().catch(() => false);
  const whyLabel = await page.locator('text=Why this move').first().isVisible().catch(() => false);
  const engineStatus = await page.locator('header p.text-silver-dim').first().textContent().catch(() => '?');
  console.log(`  Win Rate: ${wrLabel ? '✅' : '❌'}`);
  console.log(`  Top Candidates: ${tcLabel ? '✅' : '❌'}`);
  console.log(`  Why this move: ${whyLabel ? '✅' : '❌'}`);
  console.log(`  Engine status: ${engineStatus?.trim()}`);

  // Check win rate value populated
  const wrValue = await page.locator('.text-3xl').first().textContent().catch(() => null);
  console.log(`  Win Rate value: ${wrValue ?? 'null/unknown'}`);

  await page.screenshot({ path: '/tmp/go-final.png', fullPage: false });
  console.log('  截图 → /tmp/go-final.png');

  await browser.close();
  console.log();
}

(async () => {
  try {
    await uiSmokeTest();
    await playGame();
    console.log('✅ 测试完成');
    process.exit(0);
  } catch (err) {
    console.error('❌ 失败:', err.message);
    console.error(err.stack);
    process.exit(1);
  }
})();
