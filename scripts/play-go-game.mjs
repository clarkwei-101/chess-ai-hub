#!/usr/bin/env node
/**
 * Go Game Test Runner
 * Plays a complete Go game (19x19) against KataGo via chess-ai-hub API.
 * Evaluates each move from a Go master's perspective (妙手/本手/俗手).
 * 
 * Usage: node scripts/play-go-game.mjs
 */

const API_BASE = 'http://localhost:3002';

// GTP coordinate helpers
function gtpToCoords(gtp) {
  if (!gtp || gtp === 'pass' || gtp === 'resign') return null;
  const col = gtp.charCodeAt(0) - 65; // A=0, B=1, ... (skip I)
  const adjusted = col > 8 ? col - 1 : col; // Skip I column
  const row = parseInt(gtp.slice(1)) - 1;
  return { x: adjusted, y: 18 - row };
}

function coordsToGtp(x, y) {
  const col = x >= 8 ? x + 1 : x;
  const letter = String.fromCharCode(65 + col);
  const row = 19 - y;
  return `${letter}${row}`;
}

// Board state tracker (simple area scoring)
class GoBoard {
  constructor(size = 19) {
    this.size = size;
    this.grid = Array.from({ length: size }, () => Array(size).fill(0));
    this.history = [];
    this.koPoint = null;
    this.prisoners = { B: 0, W: 0 };
  }

  place(color, gtp) {
    if (gtp === 'pass' || gtp === 'resign') {
      this.history.push({ color, move: gtp });
      return true;
    }
    const pos = gtpToCoords(gtp);
    if (!pos) return false;
    const { x, y } = pos;
    if (this.grid[y][x] !== 0) return false;
    if (this.koPoint && this.koPoint.x === x && this.koPoint.y === y) return false;

    // Place stone
    this.grid[y][x] = color;
    this.history.push({ color, move: gtp, x, y });

    // Capture opponent stones
    const opponent = color === 1 ? 2 : 1;
    const neighbors = [
      [x-1, y], [x+1, y], [x, y-1], [x, y+1]
    ];
    let captured = [];
    for (const [nx, ny] of neighbors) {
      if (nx < 0 || nx >= this.size || ny < 0 || ny >= this.size) continue;
      if (this.grid[ny][nx] === opponent) {
        const libs = this.countLiberties(nx, ny, opponent);
        if (libs === 0) {
          const stones = this.getGroup(nx, ny, opponent);
          for (const s of stones) this.grid[s.y][s.x] = 0;
          captured.push(...stones);
        }
      }
    }

    // Count liberties of placed stone
    const selfLibs = this.countLiberties(x, y, color);
    const isSuicide = selfLibs === 0;

    if (isSuicide && captured.length === 0) {
      this.grid[y][x] = 0;
      this.history.pop();
      return false;
    }

    // Update ko point
    if (captured.length === 1 && isSuicide) {
      this.koPoint = { x, y };
    } else {
      this.koPoint = null;
    }

    if (color === 1) this.prisoners.B += captured.length;
    else this.prisoners.W += captured.length;

    return true;
  }

  countLiberties(x, y, color) {
    const visited = new Set();
    const group = this.getGroup(x, y, color, visited);
    let libs = new Set();
    for (const s of group) {
      for (const [nx, ny] of [[s.x-1, s.y], [s.x+1, s.y], [s.x, s.y-1], [s.x, s.y+1]]) {
        if (nx < 0 || nx >= this.size || ny < 0 || ny >= this.size) continue;
        if (this.grid[ny][nx] === 0) libs.add(`${nx},${ny}`);
      }
    }
    return libs.size;
  }

  getGroup(x, y, color, visited = new Set()) {
    const key = `${x},${y}`;
    if (visited.has(key)) return [];
    if (x < 0 || x >= this.size || y < 0 || y >= this.size) return [];
    if (this.grid[y][x] !== color) return [];
    visited.add(key);
    let group = [{ x, y }];
    for (const [nx, ny] of [[x-1, y], [x+1, y], [x, y-1], [x, y+1]]) {
      group = group.concat(this.getGroup(nx, ny, color, visited));
    }
    return group;
  }

  print() {
    console.log('   ' + 'ABCDEFGHJKLMNOPQRST'.split('').join(' '));
    for (let y = 0; y < this.size; y++) {
      const row = this.grid[y].map((c, x) => {
        if (c === 0) {
          // Star points (hoshi)
          const starPoints = [[3,3],[3,9],[3,15],[9,3],[9,9],[9,15],[15,3],[15,9],[15,15]];
          if (starPoints.some(([sx, sy]) => sx === x && sy === y)) return '+';
          return '.';
        }
        return c === 1 ? 'X' : 'O';
      });
      const rowNum = (y + 1).toString().padStart(2, ' ');
      console.log(`${rowNum} ${row.join(' ')}`);
    }
  }

  undo() {
    const last = this.history.pop();
    if (!last || last.move === 'pass' || last.move === 'resign') return;
    this.grid[last.y][last.x] = 0;
    this.koPoint = null;
  }
}

// Evaluate move quality
function evaluateMove(color, gtp, board, moveNum, analysis) {
  if (gtp === 'pass') {
    return { rating: '本手', desc: '虚一关 (pass)', winDelta: 0 };
  }
  const pos = gtpToCoords(gtp);
  if (!pos) return { rating: '?', desc: 'unknown', winDelta: 0 };

  const { x, y } = pos;
  const isCorner = (x <= 2 || x >= 16) && (y <= 2 || y >= 16);
  const isEdge = x <= 2 || x >= 16 || y <= 2 || y >= 16;
  const isCenter = x >= 6 && x <= 12 && y >= 6 && y <= 12;
  const isStar = [3, 9, 15].includes(x) && [3, 9, 15].includes(y);

  // Analyze based on move number
  let rating, desc;

  // Opening phase (moves 1-20): focus on star points and approach moves
  if (moveNum <= 20) {
    if (isStar && moveNum <= 6) {
      rating = '本手';
      desc = '星位 - 标准布局点，稳健';
    } else if (isCorner && !isStar && moveNum <= 10) {
      rating = '妙手';
      desc = '角部配置 - 小目/目外，灵活变通';
    } else if (isEdge && !isStar && moveNum <= 15) {
      rating = '本手';
      desc = '边部配置 - 三线/四线，稳固';
    } else if (isCenter && moveNum <= 8) {
      rating = '妙手';
      desc = '天元 - 全局意识，宏大构思';
    } else if (isCorner && moveNum <= 20) {
      rating = '本手';
      desc = '角部着法';
    } else {
      rating = '本手';
      desc = '正常着点';
    }
  }
  // Middle game (moves 21-100)
  else if (moveNum <= 100) {
    if (analysis) {
      const winRate = analysis.winRate ?? 0.5;
      const prevWin = color === 1 ? winRate : (1 - winRate);
      const delta = prevWin - 0.5;
      if (delta > 0.08) {
        rating = '妙手';
        desc = `胜率上升 ${(delta * 100).toFixed(1)}% - 主动`;
      } else if (delta < -0.08) {
        rating = '俗手';
        desc = `胜率下降 ${(-delta * 100).toFixed(1)}% - 被动`;
      } else {
        rating = '本手';
        desc = '局面稳定着法';
      }
    } else {
      rating = '本手';
      desc = '中盘着法';
    }
  }
  // Counting phase
  else {
    rating = '本手';
    desc = '收官/终局';
  }

  // Special case: invasion/extension assessment
  if (moveNum > 20 && gtp !== 'pass') {
    const neighbors = [[x-1,y],[x+1,y],[x,y-1],[x,y+1]];
    let sameColor = 0, opponent = 0, empty = 0;
    for (const [nx, ny] of neighbors) {
      if (nx < 0 || nx >= 19 || ny < 0 || ny >= 19) continue;
      if (board.grid[ny][nx] === color) sameColor++;
      else if (board.grid[ny][nx] === 0) empty++;
      else opponent++;
    }
    if (opponent >= 2 && empty >= 1) {
      rating = '妙手';
      desc = '侵消/攻击 — 主动';
    }
  }

  return { rating, desc };
}

// Main game loop
async function apiCall(path, body) {
  const res = await fetch(`${API_BASE}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const data = await res.json();
  return data;
}

async function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

async function waitForEngine() {
  console.log('⏳ Waiting for engine to start...');
  for (let i = 0; i < 10; i++) {
    try {
      const res = await fetch(`${API_BASE}/api/engine/start`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ variant: 'go' }),
      });
      const data = await res.json();
      if (data.ok) {
        console.log('✅ Engine started successfully\n');
        return true;
      }
    } catch (e) {}
    await sleep(2000);
  }
  throw new Error('Engine failed to start after 10 retries');
}

async function getAiMove(timeMs = 15000) {
  const res = await apiCall('/api/engine/move', {
    variant: 'go',
    move: 'auto',
    timeMs,
    styleId: 'default',
    goMoves: [],
  });
  return res;
}

async function applyPlayerMove(move) {
  const res = await apiCall('/api/engine/move', {
    variant: 'go',
    move,
  });
  return res;
}

async function newGame() {
  return apiCall('/api/engine/new-game', { variant: 'go' });
}

async function getFinalScore() {
  try {
    const res = await apiCall('/api/engine/final-score', { variant: 'go' });
    return res;
  } catch {
    return null;
  }
}

async function playGoGame() {
  console.log('='.repeat(70));
  console.log('   围棋对局 — chess-ai-hub × KataGo v1.18.1 Metal');
  console.log('   黑方 (我, 业余2段) vs 白方 (KataGo, 9段)');
  console.log('='.repeat(70));
  console.log();

  // Initialize
  await newGame();
  await waitForEngine();

  const board = new GoBoard(19);
  const gameLog = [];
  let consecutivePasses = 0;
  let moveNum = 0;

  // Opening book moves (standard 19x19)
  // Black opens at Tengen (D10) — 天元
  const openingMoves = [
    { color: 1, gtp: 'D10', note: '天元 — 全局战略要点' },
  ];

  // Play opening
  for (const om of openingMoves) {
    moveNum++;
    console.log(`📍 第 ${moveNum} 手 | 黑方 (B) | ${om.gtp} | ${om.note}`);
    board.place(1, om.gtp);
    board.print();
    gameLog.push({ num: moveNum, color: 'B', move: om.gtp, note: om.note, rating: '妙手', ratingDesc: '天元开局的宏大构思' });

    // Get KataGo response
    const aiRes = await getAiMove(20000);
    if (!aiRes.ok || !aiRes.data?.aiMove) {
      console.log('❌ AI move failed:', aiRes);
      break;
    }
    moveNum++;
    const aiGtp = aiRes.data.aiMove;
    const aiAnalysis = aiRes.data.analysis;
    const aiEval = evaluateMove(2, aiGtp, board, moveNum, aiAnalysis);
    console.log(`📍 第 ${moveNum} 手 | 白方 (W) | ${aiGtp} | ${aiEval.desc}`);
    board.place(2, aiGtp);
    board.print();
    gameLog.push({ num: moveNum, color: 'W', move: aiGtp, note: aiEval.desc, rating: aiEval.rating, ratingDesc: aiEval.desc });
    consecutivePasses = 0;
    console.log(`   Win rate B: ${((aiAnalysis?.winRate ?? 0.5) * 100).toFixed(1)}%`);
    console.log();
  }

  // Standard handicap opening: Black plays D4 (星位), Q16 (星位), D16 (星位), Q4 (星位)
  // Then continue with standard Fuseki
  const fusekiSequence = [
    { color: 1, gtp: 'D4', note: '星位 — 右上角', timeMs: 10000 },
    { color: 2, gtp: null, auto: true, timeMs: 15000 }, // AI response
    { color: 1, gtp: 'Q16', note: '星位 — 左上角', timeMs: 10000 },
    { color: 2, gtp: null, auto: true, timeMs: 15000 },
    { color: 1, gtp: 'D16', note: '星位 — 左下角', timeMs: 10000 },
    { color: 2, gtp: null, auto: true, timeMs: 15000 },
    { color: 1, gtp: 'Q4', note: '星位 — 右下角', timeMs: 10000 },
    { color: 2, gtp: null, auto: true, timeMs: 15000 },
  ];

  // But first, need to reset and start fresh with proper opening
  console.log('🔄 Starting fresh with proper opening...');
  await newGame();
  await sleep(500);
  board.grid = Array.from({ length: 19 }, () => Array(19).fill(0));
  board.history = [];
  gameLog.length = 0;
  moveNum = 0;
  consecutivePasses = 0;

  // Play 4-4 star point opening (小目/星位开局)
  const standardOpening = [
    // Move 1: Black 4-4 (星位)
    { color: 1, gtp: 'D4', desc: '黑4-4星位 — 标准开局', expected: '妙手' },
    // Move 2: White 4-4 (星位) 
    { color: 2, gtp: 'Q16', desc: '白4-4星位 — 对面星位', expected: '本手' },
    // Move 3: Black 4-4 (星位)
    { color: 1, gtp: 'D16', desc: '黑4-4星位 — 左上角', expected: '妙手' },
    // Move 4: White 4-4 (星位)
    { color: 2, gtp: 'Q4', desc: '白4-4星位 — 右下角', expected: '本手' },
    // Move 5: Black 4-4 (星位)
    { color: 1, gtp: 'D6', desc: '黑低位星位', expected: '本手' },
    // Move 6: White response
    { color: 2, gtp: null, desc: '白应手', auto: true },
    // Move 7: Black
    { color: 1, gtp: null, desc: '黑方', auto: true },
    // Move 8: White
    { color: 2, gtp: null, desc: '白应手', auto: true },
    // Move 9: Black
    { color: 1, gtp: null, desc: '黑方', auto: true },
    // Move 10: White
    { color: 2, gtp: null, desc: '白应手', auto: true },
  ];

  for (const move of standardOpening) {
    moveNum++;
    const isPlayer = move.color === 1;

    if (move.gtp) {
      // Player/KataGo plays a specific move
      if (isPlayer) {
        console.log(`📍 第 ${moveNum} 手 | 黑方 (B) | ${move.gtp} | ${move.desc}`);
        const res = await applyPlayerMove(move.gtp);
        if (!res.ok) {
          console.log(`   ❌ Illegal move: ${res.error}`);
          continue;
        }
      } else {
        // KataGo plays specific move
        const res = await apiCall('/api/engine/move', {
          variant: 'go',
          move: move.gtp,
        });
        if (!res.ok) {
          console.log(`   ❌ KataGo move failed: ${res.error}`);
          continue;
        }
      }
      board.place(move.color, move.gtp);
      board.print();
      gameLog.push({ num: moveNum, color: isPlayer ? 'B' : 'W', move: move.gtp, desc: move.desc, expected: move.expected });
    } else {
      // Auto move
      const aiRes = await getAiMove(25000);
      if (!aiRes.ok || !aiRes.data?.aiMove) {
        console.log(`❌ AI move failed:`, aiRes);
        break;
      }
      const aiGtp = aiRes.data.aiMove;
      const aiAnalysis = aiRes.data.analysis;

      if (aiGtp === 'pass') {
        console.log(`📍 第 ${moveNum} 手 | ${isPlayer ? '黑方' : '白方'} | PASS`);
        board.place(move.color, 'pass');
        consecutivePasses++;
      } else {
        board.place(move.color, aiGtp);
        console.log(`📍 第 ${moveNum} 手 | ${isPlayer ? '黑方' : '白方'} | ${aiGtp}`);
        board.print();
        consecutivePasses = 0;
      }

      const eval_ = evaluateMove(move.color, aiGtp, board, moveNum, aiAnalysis);
      gameLog.push({
        num: moveNum,
        color: isPlayer ? 'B' : 'W',
        move: aiGtp,
        desc: move.desc,
        winRate: aiAnalysis?.winRate,
        ...eval_
      });

      if (aiAnalysis) {
        const bwr = isPlayer ? (aiAnalysis.winRate ?? 0.5) : (1 - (aiAnalysis.winRate ?? 0.5));
        console.log(`   胜率 | 黑方: ${(bwr * 100).toFixed(1)}% | 白方: ${((1-bwr) * 100).toFixed(1)}%`);
        if (aiAnalysis.multiPv && aiAnalysis.multiPv.length > 0) {
          const top3 = aiAnalysis.multiPv.slice(0, 3).map(m => `${m.move}(${((m.winRate ?? 0) * 100).toFixed(0)}%)`).join(' | ');
          console.log(`   Top3: ${top3}`);
        }
      }
    }
    console.log();
    await sleep(300);

    // Game end check: two consecutive passes
    if (consecutivePasses >= 2) {
      console.log('🏁 双方连续虚一关，对局结束！');
      break;
    }

    // Safety: max 200 moves
    if (moveNum >= 200) {
      console.log('🏁 达到最大手数 (200)，对局结束');
      break;
    }
  }

  // Final score
  console.log('\n' + '='.repeat(70));
  console.log('📊 对局总结');
  console.log('='.repeat(70));
  
  const bMoves = gameLog.filter(m => m.color === 'B');
  const wMoves = gameLog.filter(m => m.color === 'W');
  
  console.log(`\n黑方 (我) — ${bMoves.length} 手`);
  const bGood = bMoves.filter(m => m.rating === '妙手').length;
  const bOk = bMoves.filter(m => m.rating === '本手').length;
  const bBad = bMoves.filter(m => m.rating === '俗手').length;
  console.log(`  妙手: ${bGood} | 本手: ${bOk} | 俗手: ${bBad}`);
  
  console.log(`\n白方 (KataGo) — ${wMoves.length} 手`);
  const wGood = wMoves.filter(m => m.rating === '妙手').length;
  const wOk = wMoves.filter(m => m.rating === '本手').length;
  const wBad = wMoves.filter(m => m.rating === '俗手').length;
  console.log(`  妙手: ${wGood} | 本手: ${wOk} | 俗手: ${wBad}`);

  console.log('\n完整着法序列:');
  gameLog.forEach(m => {
    const wr = m.winRate ? ` | WR:${(m.winRate * 100).toFixed(0)}%` : '';
    console.log(`  ${m.num.toString().padStart(3)}. ${m.color}${m.move?.padEnd(6) || 'pass'.padEnd(6)} | ${m.desc}${wr}`);
  });

  // Try to get final score
  const scoreRes = await getFinalScore();
  if (scoreRes?.data?.score) {
    const s = scoreRes.data.score;
    console.log(`\n🧮 最终结果: ${s.winner}+${Math.abs(s.score).toFixed(1)}`);
  }

  return gameLog;
}

playGoGame()
  .then(log => {
    console.log('\n✅ 对局完成！');
    process.exit(0);
  })
  .catch(err => {
    console.error('\n❌ 对局失败:', err.message);
    process.exit(1);
  });
