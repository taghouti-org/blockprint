// One click (desktop) or tap (phone) on an item of the list puts it in your hand; /kit refills the palette.
const { chromium, devices } = require('playwright-core')
const assert = require('assert')
const BASE = process.env.BASE || 'http://127.0.0.1:8090'
const sleep = ms => new Promise(r => setTimeout(r, ms))
async function run (browser, ctxOpts, name, tap) {
  const ctx = await browser.newContext(ctxOpts); const page = await ctx.newPage()
  await page.goto(`${BASE}/mc/?ip=city&version=1.21.4&proxy=${encodeURIComponent(BASE)}&username=${name}&autoConnect=true&lockConnect=true`)
  for (let i = 0; i < 60; i++) { await sleep(2000); if (await page.evaluate(() => !!window.bot?.entity && window.bot.inventory.slots.some(Boolean)).catch(() => false)) break }
  await sleep(2000)
  const vp = page.viewportSize()
  if (tap) await page.evaluate(() => window.bot.emit('openInventory')).catch(() => {})
  await page.mouse.click(vp.width / 2, vp.height / 2); await sleep(400)
  await page.keyboard.press('KeyE'); await sleep(3000)
  if (!(await page.locator('.mc-inv-jei-item-wrapper').count())) {   // phones: the inventory button
    const btn = page.locator('[class*=inventory], [aria-label*=nventory]').first(); if (await btn.count()) await btn.click(); await sleep(2500)
  }
  const target = page.locator('.mc-inv-jei-item-wrapper', { has: page.locator('[aria-label^="Slot -3: Granite"]') }).first()
  assert.ok(await target.count(), name + ': item list visible')
  if (tap) await target.tap(); else await target.click()
  await sleep(1500)
  const held = await page.evaluate(() => window.bot.heldItem && window.bot.heldItem.name + ' x' + window.bot.heldItem.count)
  console.log(name, 'hand after clicking Granite:', held)
  assert.match(held || '', /^granite x64$/)
  await page.keyboard.press('Escape').catch(() => {}); await sleep(500)
  await page.evaluate(() => { window.bot.chat('/kit') }); await sleep(2500)
  const inv = await page.evaluate(() => window.bot.inventory.slots.filter(Boolean).length)
  console.log(name, 'items after /kit:', inv)
  assert.ok(inv >= 36)
  await ctx.close()
}
;(async () => {
  for (let i = 0; i < 60; i++) { const r = await fetch(BASE + '/api/vm/net/connect', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ host: 'city', port: 25565 }) }).catch(() => null); if (r && r.status === 200) break; await sleep(2000) }
  const browser = await chromium.launch({ executablePath: process.env.CHROME || '/usr/bin/google-chrome', args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] })
  await run(browser, { viewport: { width: 1100, height: 700 } }, 'DeskPick', false)
  await run(browser, { ...devices['iPhone 13'] }, 'PhonePick', true)
  console.log('PICK OK'); await browser.close()
})().catch(e => { console.error('FAILED:', e.message); process.exit(1) })
