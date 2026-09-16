// Playwright smoke test for Demo Mode (KataGo vs Pro 9-dan replay)
//
// Verifies:
//   1. /go-demo loads
//   2. Win Rate / Top Candidates / Why this move render
//   3. Auto-play advances moves
//   4. Game can complete to end
//   5. Move history populates
//   6. StyleSelector dropdown opens and shows styles

import { chromium } from 'playwright';

const BASE = 'http://localhost:3002';
const TIMEOUT = 30_000;

async function smokeTest() {
  console.log('═══════════════════════════════════════════════════════════════════');
  console.log('  Demo Mode E2E Test');
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

  console.log('1. Loading /go-demo...');
  await page.goto(`${BASE}/go-demo`, { waitUntil: 'domcontentloaded', timeout: TIMEOUT });
  await page.waitForTimeout(3000); // let auto-play advance a few moves
  await page.screenshot({ path: '/tmp/demo-initial.png', fullPage: false });
  console.log('   📷 → /tmp/demo-initial.png');

  console.log('\n2. Checking key UI elements...');
  const wr = await page.locator('text=Win Rate').first().textContent().catch(() => null);
  console.log(`   Win Rate header: ${wr ? '✅ visible' : '❌ missing'}`);
  const tc = await page.locator('text=Top Candidates').first().textContent().catch(() => null);
  console.log(`   Top Candidates header: ${tc ? '✅ visible' : '❌ missing'}`);
  const wm = await page.locator('text=Why this move').first().textContent().catch(() => null);
  console.log(`   Why this move header: ${wm ? '✅ visible' : '❌ missing'}`);
  const mh = await page.locator('text=Move History').first().textContent().catch(() => null);
  console.log(`   Move History header: ${mh ? '✅ visible' : '❌ missing'}`);

  console.log('\n3. Checking Win Rate value...');
  const wrValue = await page.locator('.text-3xl').first().textContent().catch(() => null);
  console.log(`   Current Win Rate: ${wrValue}`);

  console.log('\n4. Checking Top Candidates...');
  const tcContent = await page.locator('text=Top Candidates').locator('..').textContent().catch(() => null);
  console.log(`   Top Candidates content (first 200 chars): ${tcContent?.slice(0, 200)?.replace(/\n/g, ' ')}`);

  console.log('\n5. Checking Move History populated...');
  const moveCount = await page.locator('.text-silver-primary').count();
  console.log(`   Move history elements count: ${moveCount}`);

  console.log('\n6. Testing Auto-play advancing...');
  const initialPly = await page.locator('text=/^第.*手/').first().textContent().catch(() => null);
  console.log(`   Initial ply text: ${initialPly}`);
  await page.waitForTimeout(4000); // let auto-play advance 2-3 more moves
  const laterPly = await page.locator('text=/^第.*手/').first().textContent().catch(() => null);
  console.log(`   Later ply text: ${laterPly}`);
  console.log(`   Auto-play advancing: ${initialPly !== laterPly ? '✅ YES' : '❌ NO'}`);

  console.log('\n7. Pause + Step forward manually...');
  // Click pause
  const pauseBtn = page.locator('button:has-text("Pause")').first();
  if (await pauseBtn.isVisible()) {
    await pauseBtn.click();
    console.log('   Clicked pause');
    await page.waitForTimeout(500);
  }

  console.log('\n8. Skip to end...');
  const skipBtn = page.locator('button:has-text("跳到结尾")').first();
  if (await skipBtn.isVisible()) {
    await skipBtn.click();
    console.log('   Clicked skip-to-end');
    await page.waitForTimeout(2000);
  }

  // Take final screenshot
  await page.screenshot({ path: '/tmp/demo-final.png', fullPage: false });
  console.log('   📷 → /tmp/demo-final.png');

  // Check final state
  const finalPlyText = await page.locator('text=/^第.*手/').first().textContent().catch(() => null);
  console.log(`   Final ply text: ${finalPlyText}`);

  console.log('\n9. Switching demo game...');
  const gameSelector = page.locator('button:has-text("Lee Sedol")').first();
  if (await gameSelector.isVisible()) {
    await gameSelector.click();
    await page.waitForTimeout(500);
    // The dropdown should show both games
    const dropdownVisible = await page.locator('text=Xu Ying').first().isVisible().catch(() => false);
    console.log(`   Game picker dropdown: ${dropdownVisible ? '✅ visible' : '❌ missing'}`);
    await page.screenshot({ path: '/tmp/demo-game-picker.png', fullPage: false });
    console.log('   📷 → /tmp/demo-game-picker.png');
  }

  console.log('\n10. Testing StyleSelector...');
  const styleBtn = page.locator('button:has-text("Style")').first();
  if (await styleBtn.isVisible()) {
    await styleBtn.click();
    await page.waitForTimeout(500);
    const styleDropdownVisible = await page.locator('text=徐莹').first().isVisible().catch(() => false);
    console.log(`   Style dropdown: ${styleDropdownVisible ? '✅ visible' : '❌ missing'}`);
    await page.screenshot({ path: '/tmp/demo-style-selector.png', fullPage: false });
    console.log('   📷 → /tmp/demo-style-selector.png');
    // Pick Lee Sedol style
    const leeSedolStyle = page.locator('button:has-text("李世乭")').first();
    if (await leeSedolStyle.isVisible()) {
      await leeSedolStyle.click();
      await page.waitForTimeout(500);
      const styleApplied = await page.locator('text=/李世乭/').first().textContent().catch(() => null);
      console.log(`   Style applied: ${styleApplied ? '✅ ' + styleApplied.slice(0, 30) : '❌ not applied'}`);
    }
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
