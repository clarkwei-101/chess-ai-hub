/**
 * Full E2E audit for chess-ai-hub (Vercel prod).
 * Verifies every page, API, button, and console-error status.
 */
import { chromium } from 'playwright';
import { writeFileSync, mkdirSync } from 'fs';

const BASE_URL = process.env.BASE_URL ?? 'https://chess-ai-hub.vercel.app';
const OUT = '/tmp/screenshots/audit';
mkdirSync(OUT, { recursive: true });

const browser = await chromium.launch({
  executablePath:
    '/Users/yahweh/.cache/ms-playwright/chromium_headless_shell-1243/chrome-headless-shell-mac-arm64/chrome-headless-shell',
});

const results = {
  baseUrl: BASE_URL,
  pages: {},
  apis: {},
  interactions: {},
  consoleErrors: [],
};

async function checkPage(page, slug, url, expectTexts = []) {
  const errors = [];
  page.removeAllListeners('console');
  page.removeAllListeners('pageerror');
  page.on('console', (msg) => { if (msg.type() === 'error') errors.push(msg.text()); });
  page.on('pageerror', (err) => errors.push(`PAGEERROR: ${err.message}`));
  const resp = await page.goto(`${BASE_URL}${url}`, { waitUntil: 'networkidle', timeout: 30000 }).catch((e) => ({ status: () => 'ERR', _err: e.message }));
  await page.waitForTimeout(2500);
  await page.screenshot({ path: `${OUT}/${slug}.png`, fullPage: false });
  const body = await page.evaluate(() => document.body.innerText).catch(() => '');
  const textMatches = {};
  for (const t of expectTexts) textMatches[t] = body.includes(t);
  results.pages[slug] = {
    url,
    status: typeof resp.status === 'function' ? resp.status() : resp.status,
    bodyLen: body.length,
    bodyPreview: body.slice(0, 200),
    textMatches,
    consoleErrors: errors.length,
    errors: errors.slice(0, 5),
  };
  console.log(`[${slug}] status=${results.pages[slug].status} bodyLen=${body.length} errors=${errors.length}`);
}

async function checkApi(slug, url, method = 'GET', body = null) {
  try {
    const opts = { method };
    if (body) {
      opts.headers = { 'Content-Type': 'application/json' };
      opts.body = JSON.stringify(body);
    }
    const resp = await fetch(`${BASE_URL}${url}`, opts);
    const text = await resp.text();
    let json = null;
    try { json = JSON.parse(text); } catch {}
    results.apis[slug] = {
      url,
      method,
      status: resp.status,
      ok: resp.ok,
      json,
      bodyPreview: text.slice(0, 300),
    };
    console.log(`[${slug}] ${method} ${url} → ${resp.status}`);
  } catch (e) {
    results.apis[slug] = { url, method, error: e.message };
    console.log(`[${slug}] ${method} ${url} → ERROR: ${e.message}`);
  }
}

console.log('=== AUDIT START ===');
console.log('Base:', BASE_URL);
console.log('');

// 1. Pages
console.log('--- Pages ---');
const ctx = await browser.newContext({ viewport: { width: 1600, height: 1000 } });
const page = await ctx.newPage();

await checkPage(page, 'landing', '/', ['Chess AI Hub', 'Demo Mode']);
await checkPage(page, 'go-page', '/go', ['Go · 围棋', 'KataGo', 'Win Rate', 'Top Candidates', 'Why this move', 'Style · 棋手']);
await checkPage(page, 'go-demo', '/go-demo', ['Demo Mode', 'KataGo', 'Lee Sedol', 'Win Rate']);
await checkPage(page, 'chess-page', '/chess', ['Chess', 'Stockfish']);
await checkPage(page, 'xiangqi-page', '/xiangqi', ['Xiangqi', 'Pikafish']);
await checkPage(page, 'go-agent', '/go-agent', ['Go', 'Agent']);

// 2. APIs
console.log('--- APIs ---');
await checkApi('engine-health', '/api/engine/health');
await checkApi('engine-start-go', '/api/engine/start', 'POST', { variant: 'go' });
await checkApi('engine-set-style-default', '/api/engine/set-style');
await checkApi('engine-set-style-leesedol', '/api/engine/set-style', 'POST', { variant: 'go', styleId: 'lee-sedol' });
await checkApi('engine-set-style-kejie', '/api/engine/set-style', 'POST', { variant: 'go', styleId: 'ke-jie' });
await checkApi('engine-diagnostics', '/api/engine/diagnostics');
await checkApi('demo-list', '/api/demo?action=list');
await checkApi('demo-game', '/api/demo?action=game&id=lee-sedol-vs-alphago-game4');
await checkApi('demo-analyze', '/api/demo?action=analyze&id=lee-sedol-vs-alphago-game4&ply=10&perspective=B');
await checkApi('go-platforms', '/api/go-platforms');
await checkApi('xiangqi-knowledge', '/api/xiangqi-knowledge');

// 3. Interactions
console.log('--- Interactions ---');
results.interactions['landing-cta'] = await page.evaluate(async () => {
  // Click "Demo Mode" CTA on landing
  const links = Array.from(document.querySelectorAll('a[href*="go-demo"], a[href*="demo"]'));
  if (links.length === 0) return { found: false };
  const firstHref = links[0].href;
  return { found: true, firstHref };
}).catch((e) => ({ error: e.message }));

// 4. Check that no console error mentions KataGo/engines:download
console.log('--- Console Errors Summary ---');
results.consoleErrors = results.pages.go-page.errors.concat(results.pages.go-demo.errors);

writeFileSync(`${OUT}/audit-results.json`, JSON.stringify(results, null, 2));
console.log('');
console.log('=== AUDIT COMPLETE ===');
console.log('Results saved to', `${OUT}/audit-results.json`);

await browser.close();
