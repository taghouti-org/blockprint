const { chromium } = require('playwright-core')
const BASE = process.env.BASE || 'http://127.0.0.1:8090'
const shots = [ // [name, tp command] (y = player feet)
  ['salle', [6.5, -59, 10.5], 2.4, -0.25],
  ['kitchen', [10.5, -59, 18.5], 3.3, -0.35],
  ['parents', [9.5, -53, 15.5], -2.3, -0.3],
  ['roof', [7.5, -40, 34.5], 0, -0.6]
]
;(async () => {
  const browser = await chromium.launch({ executablePath: '/usr/bin/google-chrome', args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] })
  const page = await browser.newPage({ viewport: { width: 1100, height: 700 } })
  await page.goto(`${BASE}/mc/?map=${encodeURIComponent(BASE + '/view/maison-tunisienne/world.zip')}&noSave=true`)
  await page.waitForFunction(() => window.bot?.entity && window.bot.blockAt(new window.bot.entity.position.constructor(2, -59, 9)), null, { timeout: 180000, polling: 1000 })
  await page.waitForTimeout(8000)
  for (const [name, pos, yaw, pitch] of shots) {
    await page.evaluate(([p, yaw, pitch]) => {
      const b = window.bot
      b.chat(`/tp ${p[0]} ${p[1]} ${p[2]}`)
      setTimeout(() => { if (Math.abs(b.entity.position.x - p[0]) > 1) b.entity.position.set(...p); b.look(yaw, pitch, true) }, 1500)
    }, [pos, yaw, pitch])
    await page.waitForTimeout(6000)
    const at = await page.evaluate(() => { const p = window.bot.entity.position; return [p.x, p.y, p.z].map(v => +v.toFixed(1)) })
    await page.screenshot({ path: `${__dirname}/out/inside_${name}.png` })
    console.log(name, 'pos', JSON.stringify(at))
  }
  await browser.close()
})().catch(e => { console.error('FAILED', e.message); process.exit(1) })
