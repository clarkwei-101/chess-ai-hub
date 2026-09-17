// Minimal Go game test (no UI smoke) — focus on the engine flow
import { chromium } from 'playwright';

const BASE = 'http://localhost:3002';
const MAX_MOVES = 220;

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

async function applyMove(move) {
  return await api('/api/engine/move', { variant: 'go', move }, 90_000);
}

async function playFullGame() {
  console.log('═══════════════════════════════════════════════════════════════════');
  console.log('  围棋完整对局 — KataGo v1.18.1 (白方, 9段) vs 9段 (黑方, 执先)');
  console.log('═══════════════════════════════════════════════════════════════════\n');

  await api('/api/engine/new-game', { variant: 'go' });
  await api('/api/engine/start', { variant: 'go' });

  const moveLog = [];
  const gameMoves = [];
  let consecutivePasses = 0;
  let moveNum = 0;
  const INITIAL_TIMEOUT = 35_000;
  const STEADY_TIMEOUT = 18_000;

  for (let i = 0; i < MAX_MOVES; i++) {
    moveNum++;
    const t0 = Date.now();
    let analysis = null;
    try {
      analysis = await waitForSseAnalysis('go', moveNum === 1 ? INITIAL_TIMEOUT : STEADY_TIMEOUT);
    } catch (e) {
      console.log(`  ⚠️  SSE timeout at move ${moveNum}: ${e.message}`);
    }
    const t1 = Date.now();
    const topMove = analysis?.multiPv?.[0]?.move;
    if (!topMove) {
      console.log(`  ⚠️  No top move at move ${moveNum}, ending game`);
      break;
    }

    const isBlack = gameMoves.length % 2 === 0;
    const playerLabel = isBlack ? '黑方 (9段)' : '白方 (KataGo 9段)';

    const moveResult = await applyMove(topMove);
    if (!moveResult.ok) {
      console.log(`  ❌ Move ${moveNum} ${playerLabel} ${topMove} failed: ${moveResult.error}`);
      break;
    }

    gameMoves.push(topMove);
    if (topMove === 'pass') consecutivePasses++;
    else consecutivePasses = 0;

    const topWr = analysis.multiPv[0].winRate ?? 0.5;
    const topScoreLead = analysis.multiPv[0].scoreLead;
    const topCp = analysis.multiPv[0].scoreCp;

    moveLog.push({
      n: moveNum,
      color: isBlack ? 'B' : 'W',
      move: topMove,
      winRate: topWr,
      scoreLead: topScoreLead,
      scoreCp: topCp,
      depth: analysis.depth ?? 0,
    });

    console.log(
      `  ${String(moveNum).padStart(3, ' ')}. ${playerLabel.padEnd(16, ' ')} ` +
      `${topMove.padEnd(4, ' ')} ` +
      `WR(B)=${(topWr * 100).toFixed(1).padStart(5, ' ')}% ` +
      `Lead=${topScoreLead !== undefined ? topScoreLead.toFixed(1).padStart(6, ' ') : '   ?'} ` +
      `Cp=${topCp !== undefined ? topCp.toString().padStart(5, ' ') : '   ?'} ` +
      `d=${String(analysis.depth ?? 0).padStart(3, ' ')} ` +
      `sse=${(t1 - t0) / 1000}s ` +
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

  // Final score
  let finalScore = null;
  try {
    finalScore = await api('/api/engine/final-score', { variant: 'go' }, 30_000);
  } catch (e) { finalScore = { error: e.message }; }

  console.log('\n═══════════════════════════════════════════════════════════════════');
  console.log('  对局统计');
  console.log('═══════════════════════════════════════════════════════════════════');
  const totalMoves = moveLog.length;
  const blackMoves = moveLog.filter(m => m.color === 'B').length;
  const whiteMoves = moveLog.filter(m => m.color === 'W').length;
  console.log(`  总手数: ${totalMoves} (黑 ${blackMoves} / 白 ${whiteMoves})`);
  console.log(`  平均搜索深度: ${(moveLog.reduce((s, m) => s + m.depth, 0) / Math.max(totalMoves, 1)).toFixed(1)}`);
  const finalB = moveLog.filter(m => m.color === 'B').slice(-1)[0];
  console.log(`  最终胜率 (从黑方视角): ${((finalB?.winRate ?? 0.5) * 100).toFixed(1)}%`);
  console.log(`  最终 ScoreLead: ${moveLog[moveLog.length - 1]?.scoreLead?.toFixed(1) ?? '?'}`);
  if (finalScore?.data?.score) {
    const s = finalScore.data.score;
    const komi = 7.5;
    let winnerText = '';
    if (s.winner === '?') winnerText = '和棋';
    else if (s.winner === 'B') winnerText = `黑胜 ${Math.abs(s.score || 0).toFixed(1)} 目`;
    else if (s.winner === 'W') winnerText = `白胜 ${Math.abs((s.score || 0) - komi).toFixed(1)} 目 (含7.5目贴目)`;
    console.log(`  KataGo 终局判定: ${winnerText}${s.resign ? ' · 认输' : ''}`);
  } else {
    console.log(`  KataGo 终局判定: 失败 (${finalScore?.error || 'no response'})`);
  }
  console.log();
  return moveLog;
}

(async () => {
  try {
    await playFullGame();
    console.log('✅ 测试完成');
    process.exit(0);
  } catch (err) {
    console.error('❌ 测试失败:', err.message);
    console.error(err.stack);
    process.exit(1);
  }
})();
