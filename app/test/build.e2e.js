// Building in the city: visitors arrive with a palette, the inventory shows every item, placing works only on plots where building is allowed.
const { chromium } = require('playwright-core')
const assert = require('assert')
const BASE = process.env.BASE || 'http://127.0.0.1:8090'
const sleep = ms => new Promise(r => setTimeout(r, ms))
let cookie = ''
const admin = async (url, body) => { const r = await fetch(BASE + url, { method: 'POST', headers: { 'content-type': 'application/json', cookie }, body: JSON.stringify(body) }); const c = r.headers.get('set-cookie'); if (c) cookie = c.split(';')[0]; return r.status }
;(async () => {
  for (let i = 0; i < 60; i++) { const r = await fetch(BASE + '/api/vm/net/connect', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ host: 'city', port: 25565 }) }).catch(() => null); if (r && r.status === 200) break; await sleep(2000) }
  assert.strictEqual(await admin('/api/admin/login', { password: process.env.ADMIN_PASSWORD }), 200)
  const ID = 'test-dar-modern', OTHER = 'maison-read-by-claude'
  await admin('/api/admin/showcases/' + ID, { editable: true }); await admin('/api/admin/showcases/' + OTHER, { editable: false })
  const city = await (await fetch(BASE + '/api/city')).json(); const P = city.plots.find(p => p.id === ID), O = city.plots.find(p => p.id === OTHER)
  const b = await chromium.launch({ executablePath: process.env.CHROME || '/usr/bin/google-chrome', args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] })
  const page = await b.newPage({ viewport: { width: 1100, height: 700 } })
  await fetch(BASE + '/api/city/visit', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username: 'Builder', id: ID }) })
  await page.goto(`${BASE}/mc/?ip=city&version=1.21.4&proxy=${encodeURIComponent(BASE)}&username=Builder&autoConnect=true&lockConnect=true`)
  for (let i = 0; i < 60; i++) { await sleep(2000); if (await page.evaluate(() => window.bot?.entity?.position.x > 0).catch(() => false)) break }
  await sleep(5000)
  const inv = await page.evaluate(() => window.bot.inventory.slots.filter(Boolean).map(i => i.name))
  console.log('palette:', inv.length, 'items, hotbar:', inv.slice(0, 9).join(', '))
  assert.ok(inv.length >= 30, 'arrives with a building palette')
  await page.mouse.click(550, 350); await sleep(500); await page.keyboard.press('KeyE'); await sleep(3000)
  const listOpen = await page.evaluate(() => /\d+ \/ \d+/.test(document.body.innerText) && !/Show All \d+ items/.test(document.body.innerText))
  const pages = await page.evaluate(() => (document.body.innerText.match(/1 \/ (\d+)/) || [])[1])
  console.log('full item list open by itself:', listOpen, '(pages:', pages + ')')
  assert.ok(listOpen && Number(pages) > 10, 'all items listed when the inventory opens')
  await page.keyboard.press('Escape'); await sleep(800)
  // place a block on the editable plot (in its yard, on the grass) and on the protected neighbour
  const place = (x, z) => page.evaluate(async ([x, z]) => {
    const b = window.bot, V = b.entity.position.constructor
    b.entity.position.set(x + 0.5, -60, z - 1.5); await new Promise(r => setTimeout(r, 1200))
    const ref = b.blockAt(new V(x, -61, z))
    await b.equip(b.inventory.slots.find(i => i && i.name === 'bricks'), 'hand')
    try { await b.placeBlock(ref, new V(0, 1, 0)) } catch (e) {}
    await new Promise(r => setTimeout(r, 2500))
    return b.blockAt(new V(x, -60, z))?.name
  }, [x, z])
  const yard = [P.x + 3, P.z + 4], other = [O.x + 3, O.z + 4]
  const mine = await place(...yard); console.log('placed bricks on the editable plot ->', mine)
  const theirs = await place(...other); console.log('placed bricks on the protected plot ->', theirs)
  assert.strictEqual(mine, 'bricks'); assert.notStrictEqual(theirs, 'bricks')
  await admin(`/api/admin/showcases/${ID}/reset`, {}); await admin('/api/admin/showcases/' + ID, { editable: false })
  console.log('BUILD OK'); await b.close()
})().catch(e => { console.error('FAILED:', e.message); process.exit(1) })
