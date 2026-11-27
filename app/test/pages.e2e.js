// Screenshots of every page for a visual check (desktop + phone).
const { chromium } = require('playwright-core')
const BASE = process.env.BASE || 'http://127.0.0.1:8090'
;(async () => {
  const browser = await chromium.launch({ executablePath: '/usr/bin/google-chrome' })
  for (const [w, h, tag] of [[1360, 900, 'desk'], [390, 844, 'phone']]) {
    const page = await browser.newPage({ viewport: { width: w, height: h } })
    const errs = []; page.on('pageerror', e => errs.push(e.message)); page.on('console', m => m.type() === 'error' && errs.push(m.text()))
    for (const [p, name] of [['/', 'home'], ['/showcases', 'gallery'], ['/s/maison-tunisienne', 'showcase'], ['/create', 'create'], ['/admin', 'admin'], ['/city', 'city']]) {
      await page.goto(BASE + p); await page.waitForTimeout(1500)
      await page.screenshot({ path: `${__dirname}/out/page_${name}_${tag}.png`, fullPage: name !== 'showcase' })
    }
    console.log(tag, 'errors:', JSON.stringify(errs))
    await page.close()
  }
  await browser.close()
})()
