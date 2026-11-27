// The city: two visitors arrive through the website (one from a house page, one from the city page),
// land in front of the house they chose, see the neighbours' houses, and see each other.
const { chromium } = require('playwright-core')
const assert = require('assert')
const BASE = process.env.BASE || 'http://127.0.0.1:8090'
const OUT = __dirname + '/out'
const mcFrame = page => page.frames().find(fr => fr.url().includes('/mc/'))
async function waitIn (page, name) {
  for (let i = 0; i < 90; i++) {
    await page.waitForTimeout(2000)
    const f = mcFrame(page); if (!f) continue
    const st = await f.evaluate(() => { const b = window.bot; if (!b || !b.entity) return null; const p = b.entity.position; return { me: b.username, mode: b.game?.gameMode, pos: [p.x, p.y, p.z].map(v => +v.toFixed(1)) } }).catch(() => null)
    if (st && st.pos[0] !== 0) { await page.waitForTimeout(3000); return st }
  }
  throw new Error(name + ' did not get into the city')
}
;(async () => {
  const city = await (await fetch(BASE + '/api/city')).json()
  const A = city.plots.find(p => p.id === 'maison-tunisienne'), B = city.plots.find(p => p.id === 'maison-read-by-claude'), N = city.plots.find(p => p.id === 'galeria-de-casa')
  assert.ok(A && B, 'sample houses are in the city')
  const browser = await chromium.launch({ executablePath: process.env.CHROME || '/usr/bin/google-chrome', args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] })
  // Alice: from the house page of A
  const ca = await browser.newContext({ viewport: { width: 1280, height: 860 } }); const pa = await ca.newPage()
  await pa.goto(`${BASE}/s/${A.id}`); await pa.fill('#name', 'Alice_c'); await pa.click('#enter')
  const sa = await waitIn(pa, 'Alice'); console.log('Alice arrived', JSON.stringify(sa))
  await pa.waitForTimeout(2500)
  const fa = mcFrame(pa)
  const posA = await fa.evaluate(() => { const p = window.bot.entity.position; return [p.x, p.y, p.z] })
  assert.ok(Math.abs(posA[0] - (A.x + 4)) < 3 && Math.abs(posA[2] - (A.z - 2)) < 3, 'Alice lands in front of house A: ' + posA)
  // neighbours' houses are there: a wall block of house A, of the neighbour and of house B
  const blocks = await fa.evaluate(([A, N, B]) => {
    const b = window.bot, V = b.entity.position.constructor
    const scan = p => { for (let y = -60; y < -45; y++) for (let x = p.x; x < p.x + p.w; x++) { const n = b.blockAt(new V(x, y, p.z + 10))?.name; if (n && !['air', 'grass_block'].includes(n)) return n } return null }
    return { A: scan(A), N: N ? scan(N) : 'none', B: scan(B) }
  }, [A, N, B])
  console.log('houses seen from Alice:', JSON.stringify(blocks))
  assert.ok(blocks.A && blocks.B && blocks.N, 'all houses are visible in the same world')
  // Bob: from the city map, picks house A too
  const cb = await browser.newContext({ viewport: { width: 1280, height: 860 } }); const pb = await cb.newPage()
  await pb.goto(`${BASE}/city?house=${A.id}`); await pb.fill('#name', 'Bob_c'); await pb.click('#enter')
  await waitIn(pb, 'Bob'); const fbb = mcFrame(pb); const posB = await fbb.evaluate(() => { const p = window.bot.entity.position; return [p.x, p.y, p.z] }); console.log('Bob arrived', posB)
  assert.ok(Math.abs(posB[0] - (A.x + 4)) < 3 && Math.abs(posB[2] - (A.z - 2)) < 3, 'Bob, coming from the city map, lands at house A too')
  await pa.waitForTimeout(4000)
  const fb = mcFrame(pb)
  const see = f => f.evaluate(() => { const b = window.bot; return Object.values(b.entities).filter(e => e.type === 'player' && e !== b.entity).map(e => e.username) })
  const aSees = await see(fa), bSees = await see(fb)
  console.log('Alice sees', aSees, '| Bob sees', bSees)
  assert.ok(aSees.some(n => /bob_c/i.test(n)) && bSees.some(n => /alice_c/i.test(n)), 'they see each other')
  await fb.evaluate(() => { window.bot.look(Math.PI, -0.1, true) })
  await fa.evaluate(() => { const b = window.bot; const o = Object.values(b.entities).find(e => e.type === 'player' && e !== b.entity); if (o) b.lookAt(o.position.offset(0, 1.6, 0), true) })
  await pa.waitForTimeout(2500); await pa.screenshot({ path: OUT + '/city_alice.png' })
  const c2 = await (await fetch(BASE + '/api/city')).json()
  console.log('city says online:', c2.online, c2.players.map(p => p.name))
  assert.ok(['alice_c', 'bob_c'].every(n => c2.players.some(p => p.name === n)))
  const sc = await (await fetch(`${BASE}/api/showcases/${A.id}`)).json()
  assert.ok(['alice_c', 'bob_c'].every(n => sc.explorers.includes(n)), 'both counted at house A: ' + sc.explorers)
  console.log('CITY MULTIPLAYER OK')
  await browser.close()
})().catch(e => { console.error('FAILED:', e.message); process.exit(1) })
