// Phone check: every page on an emulated iPhone (touch), no horizontal overflow, and the game works with touch controls.
const { chromium, devices } = require('playwright-core')
const assert = require('assert')
const BASE = process.env.BASE || 'http://127.0.0.1:8090'
const OUT = __dirname + '/out'
const sleep = ms => new Promise(r => setTimeout(r, ms))
;(async () => {
  const browser = await chromium.launch({ executablePath: process.env.CHROME || '/usr/bin/google-chrome', args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] })
  const ctx = await browser.newContext({ ...devices['iPhone 13'] })
  const page = await ctx.newPage()
  const errs = []; page.on('pageerror', e => errs.push(e.message))
  const report = {}
  for (const [url, name] of [['/', 'home'], ['/city', 'city'], ['/showcases', 'gallery'], ['/s/maison-tunisienne', 'showcase'], ['/create', 'create'], ['/create/maison-read-by-claude', 'ready'], ['/admin', 'admin']]) {
    await page.goto(BASE + url); await sleep(2000)
    const over = await page.evaluate(() => {
      const w = document.documentElement.clientWidth
      const bad = [...document.querySelectorAll('body *')].filter(e => { const r = e.getBoundingClientRect(); return r.width > 0 && (r.right > w + 1) && getComputedStyle(e).position !== 'fixed' && !e.closest('[data-scroll-x]') })
      return { scrollW: document.documentElement.scrollWidth, w, offenders: bad.slice(0, 5).map(e => e.tagName + '.' + e.className + ' ' + Math.round(e.getBoundingClientRect().right)) }
    })
    report[name] = over
    await page.screenshot({ path: `${OUT}/m_${name}.png`, fullPage: true })
  }
  console.log(JSON.stringify(report, null, 1))
  // enter the city on the phone (wait until the city accepts connections, e.g. right after a restart)
  for (let i = 0; i < 60; i++) {
    const r = await fetch(BASE + '/api/vm/net/connect', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ host: 'city', port: 25565 }) }).catch(() => null)
    if (r && r.status === 200) break
    await sleep(2000)
  }
  await page.goto(BASE + '/city?house=maison-tunisienne'); await sleep(1500)
  await page.fill('#name', 'PhoneTest'); await page.click('#enter')
  let inside = false
  for (let i = 0; i < 60 && !inside; i++) { await sleep(2000); const f = page.frames().find(fr => fr.url().includes('/mc/')); inside = !!(f && await f.evaluate(() => window.bot?.entity?.position.x > 0).catch(() => false)) }
  await sleep(6000)
  await page.screenshot({ path: `${OUT}/m_game.png` })
  const f = page.frames().find(fr => fr.url().includes('/mc/'))
  const touch = f ? await f.evaluate(() => ({ touchUi: !!document.querySelector('[class*=touch], [class*=Touch], [class*=joystick], [class*=Joystick]'), w: innerWidth, h: innerHeight })) : null
  const box = await page.evaluate(() => { const r = document.querySelector('#explorer iframe, iframe')?.getBoundingClientRect(); return r && { w: Math.round(r.width), h: Math.round(r.height), top: Math.round(r.top) } })
  console.log('game inside:', inside, 'touch UI:', JSON.stringify(touch), 'frame:', JSON.stringify(box), 'viewport', JSON.stringify(page.viewportSize()))
  console.log('page errors:', JSON.stringify(errs))
  for (const [k, v] of Object.entries(report)) assert.ok(v.scrollW <= v.w, k + ' scrolls sideways on a phone: ' + v.offenders)
  assert.ok(inside, 'got into the city on the phone')
  assert.ok(touch && touch.touchUi, 'touch controls shown')
  assert.ok(box && box.top === 0 && box.h >= page.viewportSize().height - 2, 'the game fills the phone screen')
  assert.deepStrictEqual(errs, [])
  console.log('MOBILE OK')
  await browser.close()
})().catch(e => { console.error('FAILED', e.message); process.exit(1) })
