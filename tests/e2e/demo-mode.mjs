/**
 * E2E: Demo Mode — KataGo vs Pro 9-dan (Lee Sedol vs AlphaGo Game 4 「神之一手」)
 *
 * Walks through the demo step-by-step and captures screenshots at every
 * "妙手 / 本手 / 俗手" classification so we can sanity-check the
 * commentary engine end-to-end without a live KataGo.
 *
 * Usage:
 *   node tests/e2e/demo-mode.mjs                       # localhost:3002
 *   BASE_URL=http://localhost:3002 node tests/e2e/demo-mode.mjs
 *   BASE_URL=https://chess-ai-hub.vercel.app node tests/e2e/demo-mode.mjs
 */
import { chromium } from 'playwright';
import { writeFileSync, mkdirSync } from 'fs';
import { join } from 'path';

const BASE_URL = process.env.BASE_URL ?? 'http://localhost:3002';
const OUT_DIR = process.env.OUT_DIR ?? '/tmp/screenshots/demo-mode';

mkdirSync(OUT_DIR, { recursive: true });

const browser = await chromium.launch({
  executablePath:
    process.env.CHROME_PATH ??
    '/Users/yahweh/.cache/ms-playwright/chromium_headless_shell-1243/chrome-headless-shell-mac-arm64/chrome-headless-shell',
});
const ctx = await browser.newContext({
  viewport: { width: 1600, height: 1100 },
  locale: 'zh-CN',
});
const page = await ctx.newPage();

const consoleErrors = [];
page.on('console', (msg) => {
  if (msg.type() === 'error') consoleErrors.push(msg.text());
});
page.on('pageerror', (err) => consoleErrors.push(`PAGEERROR: ${err.message}`));

console.log(`[demo-e2e] BASE_URL=${BASE_URL}`);
console.log('[demo-e2e] Loading /go-demo ...');
await page.goto(`${BASE_URL}/go-demo`, { waitUntil: 'networkidle', timeout: 30000 });

console.log('[demo-e2e] Waiting for demo game list ...');
await page.waitForSelector('text=Select Demo Game', { timeout: 5000 }).catch(() => null);
// Pick the Lee Sedol vs AlphaGo game (神之一手)
await page.waitForSelector('text=神之一手', { timeout: 5000 }).catch(() => null);

await page.screenshot({ path: join(OUT_DIR, '00-load.png'), fullPage: false });

// Switch to slow autoplay so we can capture each ply clearly
console.log('[demo-e2e] Setting autoplay speed = 3s ...');
const speedSel = page.locator('select');
if (await speedSel.count()) await speedSel.selectOption('3000');

// Pause autoplay first so we can step through manually
const pauseBtn = page.locator('button:has-text("Pause")');
if (await pauseBtn.count()) await pauseBtn.first().click();

// Open Style selector and pick Lee Sedol to test Style → hint wiring
console.log('[demo-e2e] Selecting 李世乭 style ...');
await page.locator('button:has-text("Style · 棋手")').click();
await page.waitForTimeout(300);
const leeSedol = page.locator('button:has-text("李世乭")');
if (await leeSedol.count()) {
  await leeSedol.first().click();
  await page.waitForTimeout(800);
} else {
  console.log('[demo-e2e] 李世乭 style not found — using default');
}

await page.screenshot({ path: join(OUT_DIR, '01-style-selected.png'), fullPage: false });

// Step through the game manually
const nextBtn = page.locator('button:has-text("下一手")');
const prevBtn = page.locator('button:has-text("← 上一手")');
const totalMoves = await page.locator('text=/第 \\d+ \\/ \\d+ 手/').first().textContent();
console.log(`[demo-e2e] Total moves indicator: ${totalMoves}`);

const results = [];
const plyPromises = [];

// Walk forward 30 moves, capturing screenshot + classification at each
const N_STEPS = Math.min(30, 50);
for (let i = 0; i < N_STEPS; i++) {
  await nextBtn.first().click();
  await page.waitForTimeout(450);
  const ply = await page.locator('.text-xs:has-text("第")').first().textContent().catch(() => `step ${i}`);
  // Read classification label if present
  const cls = await page.evaluate(() => {
    const el = document.querySelector('[style*="color"] [class*="rounded"]') || null;
    return el?.textContent?.trim() || null;
  });
  await page.screenshot({ path: join(OUT_DIR, `ply-${String(i + 1).padStart(2, '0')}.png`), fullPage: false });
  results.push({ step: i + 1, ply, classification: cls });
  if (i % 5 === 0) console.log(`[demo-e2e] ${ply} → ${cls ?? '—'}`);
}

// Jump to end
console.log('[demo-e2e] Jumping to end of game ...');
const skipEnd = page.locator('button:has-text("⏭ 跳到结尾")');
if (await skipEnd.count()) {
  await skipEnd.first().click();
  await page.waitForTimeout(1500);
}
await page.screenshot({ path: join(OUT_DIR, '99-end.png'), fullPage: false });

// Verify nothing crashed
const isComplete = await page.evaluate(() => {
  return !!document.body.textContent?.match(/已完成|完成|完结|对局结束|棋局结束/);
});
console.log(`[demo-e2e] isComplete=${isComplete}`);

console.log(`[demo-e2e] console errors: ${consoleErrors.length}`);
for (const err of consoleErrors.slice(0, 10)) console.log(`  - ${err.slice(0, 200)}`);

// Save results
writeFileSync(join(OUT_DIR, 'walkthrough.json'), JSON.stringify(results, null, 2));
console.log(`[demo-e2e] Wrote walkthrough.json with ${results.length} steps`);

await browser.close();
console.log('[demo-e2e] DONE');
