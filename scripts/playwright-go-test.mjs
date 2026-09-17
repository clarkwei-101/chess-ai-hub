// Playwright smoke test: load /go, verify engine starts, win rate / candidates populate,
// then play a complete game against KataGo. Reports all move classifications.
//
// Usage: node scripts/playwright-go-test.mjs
//
// The user is the 9-dan pro playing BLACK (执先). KataGo plays WHITE.
// We use simple policy: each turn, the test picks the engine's top-1 candidate (since the
// test script IS playing the "9-dan pro"). Real humans would pick their own moves; here we
// simulate a 9-dan by always picking the engine's recommendation.

import { chromium } from 'playwright';

const BASE = 'http://localhost:3002';
const MAX_MOVES = 220;
const MOVE_TIMEOUT_MS = 90_000;

async function api(path, body, timeoutMs = 30_000) {
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

async function waitForSseAnalysis(variant, timeoutMs) {
  // Stream a fresh SSE connection. Returns the FIRST analysis chunk (KataGo emits
  // immediately after kata-analyze starts; ~5-15s on M3 Ultra for maxVisits=5000).
  // Aborts after we get one chunk OR timeout.
  const ctrl = new AbortController();
  const to = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(`${BASE}/api/engine/analyze?variant=${variant}&depth=14&multipv=5`, {
      method: 'GET',
      signal: ctrl.signal,
      headers: { Accept: 'text/event-stream' },
    });
    if (!res.ok || !res.body) throw new Error(`SSE HTTP ${res.status}`);
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buf = '';
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      let idx;
      while ((idx = buf.indexOf('\n\n')) >= 0) {
        const event = buf.slice(0, idx);
        buf = buf.slice(idx + 2);
        const m = event.match(/^data: (.+)$/m);
        if (m) {
          try {
            const data = JSON.parse(m[1]);
            if (data.ok && data.analysis) return data.analysis;
          } catch {}
        }
      }
    }
  } finally {
    clearTimeout(to);
  }
}

async function applyMoveAndWait(move) {
  // Apply a move (the "9-dan pro" picks engine's top recommendation).
  // The /move endpoint will internally stop analyze, apply move, and return.
  // After that we don't need to wait for SSE — next iteration opens a fresh one.
  return await api('/api/engine/move', { variant: 'go', move }, MOVE_TIMEOUT_MS);
}

async function playFullGame() {
  console.log('═══════════════════════════════════════════════════════════════════');
  console.log('  围棋完整对局 — KataGo v1.18.1 (白方, 9段) vs 9段 (黑方, 执先)');
  console.log('═══════════════════════════════════════════════════════════════════\n');

  // Reset
  await api('/api/engine/new-game', { variant: 'go' });
  // Make sure engine is up (it persists across requests in EngineManager)
  await api('/api/engine/start', { variant: 'go' });

  const moveLog = [];
  const gameMoves = []; // GTP sequence
  let consecutivePasses = 0;
  let moveNum = 0;

  // First iteration: wait longer (30s) for initial kata-analyze warmup
  const INITIAL_SSE_TIMEOUT = 35_000;
  const STEADY_SSE_TIMEOUT = 18_000;

  for (let i = 0; i < MAX_MOVES; i++) {
    moveNum++;
    const sseTimeout = moveNum === 1 ? INITIAL_SSE_TIMEOUT : STEADY_SSE_TIMEOUT;

    // Wait for fresh SSE analysis
    let analysis = null;
    try {
      analysis = await waitForSseAnalysis('go', sseTimeout);
    } catch (e) {
      console.log(`  ⚠️  SSE timeout at move ${moveNum}: ${e.message}`);
    }

    const topMove = analysis?.multiPv?.[0]?.move;
    if (!topMove) {
      console.log(`  ⚠️  No top move at move ${moveNum}, ending game`);
      break;
    }

    const isBlack = gameMoves.length % 2 === 0; // black plays first
    const playerLabel = isBlack ? '黑方 (9段)' : '白方 (KataGo 9段)';

    // Apply the move
    const moveResult = await applyMoveAndWait(topMove);
    if (!moveResult.ok) {
      console.log(`  ❌ Move ${moveNum} ${playerLabel} ${topMove} failed: ${moveResult.error}`);
      break;
    }

    gameMoves.push(topMove);
    if (topMove === 'pass') consecutivePasses++;
    else consecutivePasses = 0;

    const topWr = analysis.multiPv[0].winRate ?? 0.5;
    const topScoreLead = analysis.multiPv[0].scoreLead;

    moveLog.push({
      n: moveNum,
      color: isBlack ? 'B' : 'W',
      move: topMove,
      winRate: topWr,
      scoreLead: topScoreLead,
      top5: analysis.multiPv.slice(0, 5).map(p => `${p.move}(${(p.winRate * 100).toFixed(0)}%)`).join(' '),
      depth: analysis.depth ?? 0,
    });

    console.log(
      `  ${String(moveNum).padStart(3, ' ')}. ${playerLabel.padEnd(16, ' ')} ${topMove.padEnd(4, ' ')} ` +
      `WR(B)=${(topWr * 100).toFixed(1).padStart(5, ' ')}% ` +
      `Lead=${topScoreLead !== undefined ? topScoreLead.toFixed(1).padStart(6, ' ') : '   ?'} ` +
      `d=${String(analysis.depth ?? 0).padStart(3, ' ')} ` +
      `top5=[${analysis.multiPv.slice(0, 5).map(p => `${p.move}(${(p.winRate * 100).toFixed(0)}%)`).join(' ')}]`
    );

    if (consecutivePasses >= 2) {
      console.log(`\n  🏁 双 Pass · 对局结束 at move ${moveNum}\n`);
      break;
    }
  }

  if (moveNum >= MAX_MOVES) {
    console.log(`\n  🏁 达到最大手数 ${MAX_MOVES} · 强制结束\n`);
  }

  // Get final score
  let finalScore = null;
  try {
    finalScore = await api('/api/engine/final-score', { variant: 'go' }, 30_000);
  } catch (e) {
    finalScore = { error: e.message };
  }

  console.log('\n═══════════════════════════════════════════════════════════════════');
  console.log('  对局统计');
  console.log('═══════════════════════════════════════════════════════════════════');
  const totalMoves = moveLog.length;
  const blackMoves = moveLog.filter(m => m.color === 'B').length;
  const whiteMoves = moveLog.filter(m => m.color === 'W').length;
  console.log(`  总手数: ${totalMoves} (黑 ${blackMoves} / 白 ${whiteMoves})`);
  console.log(`  平均搜索深度: ${(moveLog.reduce((s, m) => s + m.depth, 0) / Math.max(totalMoves, 1)).toFixed(1)}`);
  console.log(`  最终胜率 (从黑方视角): ${((moveLog.filter(m => m.color === 'B').slice(-1)[0]?.winRate ?? 0.5) * 100).toFixed(1)}%`);
  console.log(`  最终 ScoreLead: ${moveLog[moveLog.length - 1]?.scoreLead?.toFixed(1) ?? '?'}`);
  if (finalScore?.data?.score) {
    const s = finalScore.data.score;
    const komi = 7.5;
    let winnerText = '';
    if (s.winner === '?') winnerText = '和棋';
    else if (s.winner === 'B') winnerText = `黑胜 ${Math.abs((s.score || 0)).toFixed(1)} 目`;
    else if (s.winner === 'W') winnerText = `白胜 ${Math.abs((s.score || 0) - komi).toFixed(1)} 目 (含7.5目贴目)`;
    console.log(`  KataGo 终局判定: ${winnerText}${s.resign ? ' · 认输' : ''}`);
  } else {
    console.log(`  KataGo 终局判定: 失败 (${finalScore?.error || 'no response'})`);
  }
  console.log();

  return moveLog;
}

async function uiSmokeTest() {
  console.log('\n═══════════════════════════════════════════════════════════════════');
  console.log('  UI Smoke Test — 浏览器渲染验证');
  console.log('═══════════════════════════════════════════════════════════════════\n');

  const browser = await chromium.launch({ headless: true });
  const ctx = await browser.newContext({ viewport: { width: 1600, height: 1000 } });
  const page = await ctx.newPage();

  // Surface browser console errors
  page.on('console', (msg) => {
    const text = msg.text();
    if (msg.type() === 'error' || text.includes('Warning') || text.includes('Error')) {
      console.log(`  [browser ${msg.type()}] ${text.slice(0, 200)}`);
    }
  });
  page.on('pageerror', (err) => console.log(`  [pageerror] ${err.message.slice(0, 200)}`));

  await page.goto(`${BASE}/go`, { waitUntil: 'networkidle', timeout: 30000 });
  await page.waitForTimeout(2000); // let engine start

  // Take screenshot of initial state
  await page.screenshot({ path: '/tmp/go-initial.png', fullPage: false });
  console.log('  📷 初始状态截图 → /tmp/go-initial.png');

  // Check Win Rate Bar visibility
  const wrText = await page.locator('text=Win Rate').first().textContent().catch(() => null);
  console.log(`  Win Rate header: ${wrText ? '✅ visible' : '❌ missing'}`);

  // Check Top Candidates visibility
  const tcText = await page.locator('text=Top Candidates').first().textContent().catch(() => null);
  console.log(`  Top Candidates header: ${tcText ? '✅ visible' : '❌ missing'}`);

  // Check Why this move visibility
  const whyText = await page.locator('text=Why this move').first().textContent().catch(() => null);
  console.log(`  Why this move header: ${whyText ? '✅ visible' : '❌ missing'}`);

  // Check the header is not occluded by board — measure bounding box of header
  const header = await page.locator('header').first().boundingBox();
  const board = await page.locator('div.relative[style*="width:664px"]').first().boundingBox().catch(() => null);
  if (header && board) {
    const overlap = header.y + header.height > board.y && header.y < board.y + board.height;
    if (overlap && header.y < board.y) {
      console.log(`  ⚠️  Header (y=${header.y.toFixed(0)} h=${header.height.toFixed(0)}) overlaps board (y=${board.y.toFixed(0)})`);
    } else {
      console.log(`  ✅ Header (y=${header.y.toFixed(0)} h=${header.height.toFixed(0)}) and board (y=${board.y.toFixed(0)}) — no overlap`);
    }
  }

  // Wait for analysis to populate
  await page.waitForTimeout(8000);
  await page.screenshot({ path: '/tmp/go-after-analysis.png', fullPage: false });
  console.log('  📷 分析后截图 → /tmp/go-after-analysis.png');

  // Check if win rate number is now > 50% or < 50% (showing real analysis)
  const winRateNum = await page.locator('.text-3xl.font-light').first().textContent().catch(() => null);
  console.log(`  Win Rate 当前值: ${winRateNum}`);

  // Check Top Candidates has actual moves (not "Waiting for engine...")
  const tcContent = await page.locator('text=Top Candidates').locator('..').textContent().catch(() => null);
  console.log(`  Top Candidates 内容 (前 200 字): ${tcContent?.slice(0, 200)}`);

  // Check engine status indicator
  const engineStatus = await page.locator('header p.text-silver-dim').first().textContent().catch(() => null);
  console.log(`  Engine status: ${engineStatus?.trim()}`);

  await browser.close();
  console.log();
}

(async () => {
  try {
    await uiSmokeTest();
    // Stop analyze stream before game test to avoid SSE conflict
    try { await api('/api/engine/stop-analyze', { variant: 'go' }); } catch {}
    await new Promise(r => setTimeout(r, 1000));
    await playFullGame();
    console.log('✅ 测试完成');
    process.exit(0);
  } catch (err) {
    console.error('❌ 测试失败:', err.message);
    console.error(err.stack);
    process.exit(1);
  }
})();
