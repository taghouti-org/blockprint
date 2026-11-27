// Admin in the city: per-plot editing, live reset, live disable/enable, city restart. A scripted player checks each effect.
const assert = require('assert')
const mineflayer = require('mineflayer')
const { Vec3 } = require('vec3')
const BASE = process.env.BASE || 'http://127.0.0.1:8090'
const CITY_PORT = 25700
const B_ID = 'maison-read-by-claude', A_ID = 'maison-tunisienne'
let cookie = ''
async function call (method, url, body) {
  const r = await fetch(BASE + url, { method, headers: { 'content-type': 'application/json', cookie }, body: body && JSON.stringify(body) })
  const sc = r.headers.get('set-cookie'); if (sc) cookie = sc.split(';')[0]
  return { status: r.status, json: await r.json().catch(() => ({})) }
}
const sleep = ms => new Promise(r => setTimeout(r, ms))
async function join (name, id) {
  await call('POST', '/api/city/visit', { username: name, id })
  return new Promise((res, rej) => {
    const b = mineflayer.createBot({ host: '127.0.0.1', port: CITY_PORT, username: name, version: '1.21.4', auth: 'offline' })
    b.once('spawn', () => setTimeout(() => res(b), 3000)); b.once('error', rej); setTimeout(() => rej(new Error('spawn timeout')), 40000)
  })
}
async function tryDig (bot, pos) { try { bot.dig(bot.blockAt(pos), true).catch(() => {}) } catch {} await sleep(2500); return bot.blockAt(pos)?.name }
;(async () => {
  assert.strictEqual((await call('POST', '/api/admin/showcases/' + B_ID, { editable: true })).status, 401, 'locked without login')
  assert.strictEqual((await call('POST', '/api/admin/login', { password: 'wrong' })).status, 401)
  assert.strictEqual((await call('POST', '/api/admin/login', { password: process.env.ADMIN_PASSWORD })).status, 200)
  console.log('login ok')
  await call('POST', '/api/admin/showcases/' + B_ID, { editable: false })
  await call('POST', '/api/admin/showcases/' + A_ID, { editable: false })
  const city = (await call('GET', '/api/city')).json
  const B = city.plots.find(p => p.id === B_ID), A = city.plots.find(p => p.id === A_ID)
  const wallB = new Vec3(B.x, -59, B.z + 10), wallA = new Vec3(A.x, -59, A.z + 10)   // west outer walls
  const bot = await join('Admin_t', B_ID)
  const before = bot.blockAt(wallB).name
  assert.strictEqual(bot.game.gameMode, 'creative')
  assert.strictEqual(await tryDig(bot, wallB), before, 'editing off: block stays'); console.log('editing off: refused ok')
  await call('POST', '/api/admin/showcases/' + B_ID, { editable: true }); await sleep(1500)
  assert.strictEqual(await tryDig(bot, wallB), 'air', 'editing on: block can be broken'); console.log('editing on for B: dig works ok')
  bot.entity.position.set(A.x - 1, -59, A.z + 10); await sleep(1500)
  assert.strictEqual(await tryDig(bot, wallA), bot.blockAt(wallA).name === 'air' ? 'air' : bot.blockAt(wallA).name)
  assert.notStrictEqual(bot.blockAt(wallA).name, 'air', 'house A is still protected'); console.log('house A still protected ok')
  // reset B live: the broken wall comes back, the player stays connected
  assert.strictEqual((await call('POST', `/api/admin/showcases/${B_ID}/reset`)).status, 200)
  await sleep(1500)
  assert.strictEqual(bot.blockAt(wallB).name, before, 'reset restores the house live'); console.log('reset house live ok')
  // disable B: removed live and hidden; enable: back
  await call('POST', '/api/admin/showcases/' + B_ID, { enabled: false, editable: false }); await sleep(4000)
  assert.strictEqual(bot.blockAt(wallB).name, 'air', 'disabled house removed from the city')
  assert.ok(!(await call('GET', '/api/city')).json.plots.some(p => p.id === B_ID) && !(await (await fetch(BASE + '/api/showcases')).json()).some(s => s.id === B_ID))
  console.log('disable: removed live + hidden ok')
  await call('POST', '/api/admin/showcases/' + B_ID, { enabled: true }); await sleep(5000)
  assert.strictEqual(bot.blockAt(wallB).name, before, 'enabled house is back'); console.log('enable: back live ok')
  // restart the city: everyone disconnected, back after a few seconds
  const ended = new Promise(r => bot.once('end', r))
  assert.strictEqual((await call('POST', '/api/admin/city/restart')).status, 200)
  await Promise.race([ended, sleep(8000)])
  const bot2 = await join('Admin_t2', B_ID)
  assert.strictEqual(bot2.blockAt(wallB).name, before); bot2.quit()
  console.log('city restart ok')
  console.log('ADMIN OK'); process.exit(0)
})().catch(e => { console.error('FAILED:', e.message); process.exit(1) })
