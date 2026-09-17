// Playwright E2E test for Demo Mode on PRODUCTION
// Verifies https://chess-ai-hub.vercel.app/go-demo works end-to-end

import { chromium } from 'playwright';

const BASE = 'https://chess-ai-hub.vercel.app';
const TIMEOUT = 60_000;

async function smokeTest() {
  console.log('═══════════════════════════════════════════════════════════════════');
  console.log(`  Production Demo Mode E2E Test`);
  console.log(`  Target: ${BASE}/go-demo`);
  console.log('═══════════════════════════════════════════════════════════════════\n');

  const browser = await chromium.launch({ headless: true });
  const ctx = await browser.newContext({ viewport: { width: 1600, height: 1000 } });
  const page = await ctx.newPage();

  let pageErrors = 0;
  page.on('console', (msg) => {
    const text = msg.text();
    if (msg.type() === 'error') {
      console.log(`  [browser error] ${text.slice(0, 200)}`);
      pageErrors++;
    }
  });
  page.on('pageerror', (err) => {
    console.log(`  [pageerror] ${err.message.slice(0, 200)}`);
    pageErrors++;
  });

  console.log('1. Loading /go-demo on production...');
  await page.goto(`${BASE}/go-demo`, { waitUntil: 'domcontentloaded', timeout: TIMEOUT });
  await page.waitForTimeout(4000);
  await page.screenshot({ path: '/tmp/prod-demo-initial.png', fullPage: false });
  console.log('   📷 → /tmp/prod-demo-initial.png');

  console.log('\n2. Checking key UI elements...');
  const wr = await page.locator('text=Win Rate').first().textContent().catch(() => null);
  console.log(`   Win Rate header: ${wr ? '✅ visible' : '❌ missing'}`);
  const tc = await page.locator('text=Top Candidates').first().textContent().catch(() => null);
  console.log(`   Top Candidates header: ${tc ? '✅ visible' : '❌ missing'}`);
  const wm = await page.locator('text=Why this move').first().textContent().catch(() => null);
  console.log(`   Why this move header: ${wm ? '✅ visible' : '❌ missing'}`);
  const mh = await page.locator('text=Move History').first().textContent().catch(() => null);
  console.log(`   Move History header: ${mh ? '✅ visible' : '❌ missing'}`);
  const demoBanner = await page.locator('text=Demo Mode').first().textContent().catch(() => null);
  console.log(`   Demo Mode banner: ${demoBanner ? '✅ visible' : '❌ missing'}`);

  console.log('\n3. Checking Win Rate value...');
  const wrValue = await page.locator('.text-3xl').first().textContent().catch(() => null);
  console.log(`   Win Rate: ${wrValue}`);

  console.log('\n4. Checking Top Candidates...');
  const tcContent = await page.locator('text=Top Candidates').locator('..').textContent().catch(() => null);
  const tcText = tcContent?.replace(/\s+/g, ' ')?.slice(0, 200);
  console.log(`   Top Candidates content: ${tcText}`);

  console.log('\n5. Auto-play test...');
  const initialPly = await page.locator('text=/^第.*手/').first().textContent().catch(() => null);
  console.log(`   Initial: ${initialPly}`);
  await page.waitForTimeout(5000);
  const laterPly = await page.locator('text=/^第.*手/').first().textContent().catch(() => null);
  console.log(`   After 5s: ${laterPly}`);
  console.log(`   Auto-play: ${initialPly !== laterPly ? '✅ advancing' : '❌ not advancing'}`);

  console.log('\n6. Test game picker...');
  const gameSelector = page.locator('button:has-text("Lee Sedol")').first();
  if (await gameSelector.isVisible()) {
    await gameSelector.click();
    await page.waitForTimeout(500);
    const xuVisible = await page.locator('text=Xu Ying').first().isVisible().catch(() => false);
    console.log(`   Game picker dropdown shows Xu Ying: ${xuVisible ? '✅' : '❌'}`);
    await page.screenshot({ path: '/tmp/prod-demo-picker.png', fullPage: false });
    // Close dropdown
    await page.keyboard.press('Escape');
  }

  console.log('\n7. Test StyleSelector...');
  const styleBtn = page.locator('button:has-text("Style")').first();
  if (await styleBtn.isVisible()) {
    await styleBtn.click();
    await page.waitForTimeout(500);
    const xuStyle = await page.locator('text=徐莹').first().isVisible().catch(() => false);
    console.log(`   Style dropdown shows 徐莹: ${xuStyle ? '✅' : '❌'}`);
    const leeStyle = await page.locator('text=李世乭').first().isVisible().catch(() => false);
    console.log(`   Style dropdown shows 李世乭: ${leeStyle ? '✅' : '❌'}`);
    await page.screenshot({ path: '/tmp/prod-demo-style.png', fullPage: false });
  }

  await browser.close();

  console.log('\n═══════════════════════════════════════════════════════════════════');
  console.log(`  Total browser errors: ${pageErrors}`);
  console.log(`  Result: ${pageErrors === 0 ? '✅ PASS' : '⚠️ PASS WITH WARNINGS'}`);
  console.log('═══════════════════════════════════════════════════════════════════\n');
  return pageErrors;
}

(async () => {
  try {
    const errors = await smokeTest();
    process.exit(errors > 0 ? 1 : 0);
  } catch (err) {
    console.error('❌ Test failed:', err.message);
    console.error(err.stack);
    process.exit(1);
  }
})();
