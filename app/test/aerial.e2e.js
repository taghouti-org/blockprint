const { chromium } = require('playwright-core')
const BASE = process.env.BASE || 'http://127.0.0.1:8090'
;(async () => {
  const browser = await chromium.launch({ executablePath: '/usr/bin/google-chrome', args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] })
  const page = await browser.newPage({ viewport: { width: 1100, height: 700 } })
  await page.goto(`${BASE}/mc/?map=${encodeURIComponent(BASE + '/view/maison-tunisienne/world.zip')}&noSave=true`)
  await page.waitForFunction(() => window.bot?.entity && window.bot.blockAt(new window.bot.entity.position.constructor(2, -59, 9)), null, { timeout: 180000, polling: 1000 })
  await page.waitForTimeout(6000)
  for (const [name, p, yaw, pitch] of [['aerial_front', [-6.5, -38, -12.5], -2.5, -0.65], ['aerial_back', [20.5, -36, 40.5], 0.5, -0.75]]) {
    await page.evaluate(([p, yaw, pitch]) => {
      const b = window.bot
      try { b.creative.startFlying() } catch {}
      b.chat(`/tp ${p[0]} ${p[1]} ${p[2]}`)
      return new Promise(r => setTimeout(() => { b.entity.position.set(...p); b.entity.velocity.set(0, 0, 0); b.look(yaw, pitch, true); r() }, 1500))
    }, [p, yaw, pitch])
    await page.waitForTimeout(7000)
    const at = await page.evaluate(() => { const q = window.bot.entity.position; return [q.x, q.y, q.z].map(v => +v.toFixed(1)) })
    await page.screenshot({ path: `${__dirname}/out/${name}.png` }); console.log(name, JSON.stringify(at))
  }
  await browser.close()
})().catch(e => { console.error('FAILED', e.message); process.exit(1) })
