// Regenerates the README screenshots (docs/screenshots). Needs the site running and ADMIN_PASSWORD in the env.
// node scripts/screenshots.js
const { chromium } = require('playwright-core')
const fs = require('fs')
const path = require('path')
const BASE = process.env.BASE || 'http://127.0.0.1:8090'
const OUT = path.resolve(__dirname, '../../docs/screenshots')
const ARGS = ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist']
fs.mkdirSync(OUT, { recursive: true })
const sleep = ms => new Promise(r => setTimeout(r, ms))

async function inGame (page) {
  for (let i = 0; i < 90; i++) {
    await sleep(2000)
    const f = page.frames().find(fr => fr.url().includes('/mc/'))
    if (!f) continue
    const ok = await f.evaluate(() => !!(window.bot && window.bot.entity && window.bot.entity.position.x !== 0)).catch(() => false)
    if (ok) { await sleep(2000); await quiet(f); return f }
  }
  throw new Error('did not get into the game')
}
// wait until the client has finished loading chunks / textures (its overlays are gone)
async function quiet (f, max = 150000) {
  const t0 = Date.now()
  while (Date.now() - t0 < max) {
    const busy = await f.evaluate(() => /Loading world chunks|Processing GUI|Loading chunks/i.test(document.body.innerText)).catch(() => true)
    if (!busy) { await sleep(2500); return }
    await sleep(1500)
  }
  console.log('  (still loading after', max / 1000, 's)')
}
// mineflayer yaw: 0 = north (-z), PI/2 = west, PI = south (+z), 3PI/2 = east; pitch < 0 looks down
async function look (f, pos, yaw, pitch) {
  await f.evaluate(([pos, yaw, pitch]) => {
    const b = window.bot
    try { b.creative.startFlying() } catch {}
    b.entity.position.set(...pos); b.entity.velocity.set(0, 0, 0); b.look(yaw, pitch, true)
  }, [pos, yaw, pitch])
  await sleep(3000); await quiet(f)
}
async function visit (name, id) {
  await fetch(BASE + '/api/city/visit', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username: name, id }) })
}

;(async () => {
  const browser = await chromium.launch({ executablePath: process.env.CHROME || '/usr/bin/google-chrome', args: ARGS })
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2 })
  const page = await ctx.newPage()
  const shot = async (name, opts = {}) => { await page.screenshot({ path: path.join(OUT, name + '.png'), ...opts }); console.log('saved', name) }

  for (const [url, name, full] of [['/', 'home', false], ['/showcases', 'gallery', false], ['/s/maison-tunisienne', 'showcase', false], ['/create', 'upload', false]]) {
    await page.goto(BASE + url); await sleep(2500); await shot(name, { fullPage: full })
  }
  // questionnaire of a plan read by Claude (admin can reopen it)
  await page.goto(BASE + '/admin')
  await page.fill('#pw', process.env.ADMIN_PASSWORD); await page.click('#go'); await sleep(2000)
  await shot('admin')
  await page.goto(BASE + '/create/maison-read-by-claude?edit=1'); await sleep(3000)
  await page.evaluate(() => window.scrollTo(0, 560)); await sleep(800)
  await shot('questionnaire')
  await page.evaluate(() => { const d = [...document.querySelectorAll('details.q')].find(x => /Non couvert/.test(x.textContent)); if (d) { d.open = true; d.scrollIntoView({ block: 'center' }); d.dispatchEvent(new Event('mouseenter')) } })
  await sleep(800); await shot('questionnaire-open-space')

  // the city: explorer + live map, with a second visitor standing next to us
  const city = await (await fetch(BASE + '/api/city')).json()
  const A = city.plots.find(p => p.id === 'maison-tunisienne')
  const ctx2 = await browser.newContext({ viewport: { width: 1000, height: 700 } }); const p2 = await ctx2.newPage()
  await visit('Yasmine', A.id)
  await p2.goto(`${BASE}/mc/?ip=city&version=1.21.4&proxy=${encodeURIComponent(BASE)}&username=Yasmine&autoConnect=true&lockConnect=true`)
  const f2 = await inGame(p2)
  await page.goto(`${BASE}/city?house=${A.id}`); await page.fill('#name', 'Tarek'); await page.click('#enter')
  const f1 = await inGame(page)
  await f2.evaluate(([x, z]) => { const b = window.bot; try { b.creative.stopFlying() } catch {} b.entity.position.set(x, -59, z); b.look(0, 0, true) }, [A.x + 9, A.z - 4])
  await look(f1, [A.x + 4, -58, A.z - 16], Math.PI * 1.15, -0.05)
  await shot('city')
  // full-frame in-game shots
  const g = await ctx.newPage()
  await visit('Camera', A.id)
  await g.goto(`${BASE}/mc/?ip=city&version=1.21.4&proxy=${encodeURIComponent(BASE)}&username=Camera&autoConnect=true&lockConnect=true&setting=renderDistance:6`)
  const fg = await inGame(g)
  const gshot = async (name) => { await g.screenshot({ path: path.join(OUT, name + '.png') }); console.log('saved', name) }
  await look(fg, [A.x + 4, -58, A.z - 16], Math.PI * 1.22, -0.06); await gshot('game-neighbours')
  await look(fg, [A.x - 26, -12, A.z - 46], Math.PI * 1.27, -0.55); await gshot('game-city-aerial')
  await look(fg, [A.x + 6.5, -59, A.z + 10.5], 2.4, -0.25); await gshot('game-living-room')
  await browser.close()
})().catch(e => { console.error('FAILED', e); process.exit(1) })
