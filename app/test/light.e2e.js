// Rooms are lit: in-game screenshots inside a house in the city (compare with the dark shots before the light engine).
const { chromium } = require('playwright-core')
const BASE = process.env.BASE || 'http://127.0.0.1:8090'
const sleep = ms => new Promise(r => setTimeout(r, ms))
;(async () => {
  const browser = await chromium.launch({ executablePath: '/usr/bin/google-chrome', args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] })
  const page = await browser.newPage({ viewport: { width: 1100, height: 700 } })
  const city = await (await fetch(BASE + '/api/city')).json(); const A = city.plots.find(p => p.id === 'maison-tunisienne')
  await fetch(BASE + '/api/city/visit', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username: 'LightTest', id: A.id }) })
  await page.goto(`${BASE}/mc/?ip=city&version=1.21.4&proxy=${encodeURIComponent(BASE)}&username=LightTest&autoConnect=true&lockConnect=true`)
  for (let i = 0; i < 60; i++) { await sleep(2000); if (await page.evaluate(() => window.bot?.entity?.position.x > 0).catch(() => false)) break }
  for (const [name, pos, yaw, pitch] of [['light_living', [A.x + 6.5, -59, A.z + 10.5], 2.4, -0.25], ['light_kitchen', [A.x + 10.5, -59, A.z + 18.5], 3.3, -0.35], ['light_bedroom', [A.x + 8.5, -53, A.z + 14.5], -2.0, -0.2]]) {
    await page.evaluate(([p, y, pt]) => { const b = window.bot; try { b.creative.startFlying() } catch {} b.entity.position.set(...p); b.entity.velocity.set(0, 0, 0); b.look(y, pt, true) }, [pos, yaw, pitch])
    for (let k = 0; k < 40; k++) { await sleep(1500); if (!/Loading world chunks/i.test(await page.evaluate(() => document.body.innerText))) break }
    await sleep(3000); await page.screenshot({ path: `${__dirname}/out/${name}.png` }); console.log('saved', name)
  }
  await browser.close()
})()
