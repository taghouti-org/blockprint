// Full flow in the browser: upload -> Claude reads (real API call) -> questionnaire -> build -> showcase.
const { chromium } = require('playwright-core')
const assert = require('assert')
const BASE = process.env.BASE || 'http://127.0.0.1:8090'
const OUT = __dirname + '/out'
;(async () => {
  const browser = await chromium.launch({ executablePath: process.env.CHROME || '/usr/bin/google-chrome', args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'] })
  const page = await browser.newPage({ viewport: { width: 1360, height: 900 } })
  page.on('pageerror', e => console.log('[pageerror]', e.message))
  await page.goto(BASE + '/create')
  await page.setInputFiles('#files', [__dirname + '/fixtures/ground_floor.png', __dirname + '/fixtures/upper_floor.png'])
  await page.fill('#title', 'Test Dar Modern'); await page.fill('#author', 'E2E')
  await page.screenshot({ path: OUT + '/create_upload.png' })
  await page.click('#go')
  await page.waitForURL(/\/create\/[a-z0-9-]+$/)
  const id = page.url().split('/').pop(); console.log('created', id)
  await page.waitForSelector('#reading', { timeout: 30000 })
  await page.screenshot({ path: OUT + '/create_reading.png' })
  const t0 = Date.now()
  await page.waitForSelector('details.q', { timeout: 300000 })
  console.log('questionnaire after', Math.round((Date.now() - t0) / 1000), 's')
  const stats = await page.evaluate(() => ({
    cards: document.querySelectorAll('details.q').length,
    open: document.querySelectorAll('details.q[open]').length,
    plan: document.querySelectorAll('summary .src.plan').length,
    guess: document.querySelectorAll('summary .src.guess').length,
    minis: document.querySelectorAll('.mini svg').length,
    assumptions: document.querySelectorAll('.assume li').length }))
  console.log('questionnaire', JSON.stringify(stats))
  assert.ok(stats.cards >= 15 && stats.plan >= 5 && stats.minis >= 2)
  await page.screenshot({ path: OUT + '/create_questions.png', fullPage: false })
  // change the style to Modern
  const styleCard = page.locator('details.q', { hasText: 'Decoration style' }).first()
  if (!(await styleCard.evaluate(d => d.open))) await styleCard.locator('summary').click()
  await styleCard.locator('label', { hasText: 'Modern' }).click()
  assert.match(await styleCard.locator('summary').innerText(), /Modern/)
  await page.click('#build')
  await page.waitForSelector('text=is built', { timeout: 120000 })
  await page.screenshot({ path: OUT + '/create_ready.png' })
  const sc = await (await fetch(`${BASE}/api/showcases/${id}`)).json()
  console.log('built', JSON.stringify({ status: sc.status, style: sc.style, stats: sc.stats, notes: sc.notes }))
  assert.strictEqual(sc.status, 'ready'); assert.strictEqual(sc.style, 'modern')
  await page.click('text=Walk inside'); await page.waitForURL(/\/s\//)
  await page.waitForTimeout(1500); await page.screenshot({ path: OUT + '/create_showcase.png' })
  console.log('CREATE FLOW OK', id)
  await browser.close()
})().catch(e => { console.error('FAILED:', e.message); process.exit(1) })
