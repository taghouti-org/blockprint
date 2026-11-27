// Blockprint: upload a floor plan, Claude reads it, answer a few questions, explore the built house together.
const express = require('express')
const fs = require('fs')
const path = require('path')
const crypto = require('crypto')
const http = require('http')
const multer = require('multer')
const cookieParser = require('cookie-parser')
const { Store } = require('./src/store')
const { CityServer } = require('./src/worlds')
const { City } = require('./src/city')
const { DATA } = require('./src/store')
const { createProxy } = require('./src/proxy')

const MWC = path.join(__dirname, 'vendor/mwc/dist')
const PUB = path.join(__dirname, 'public')
const log = (...a) => console.log(new Date().toISOString(), ...a)

// ---------------------------------------------------------------- config (secrets live in ~/.config/plan2world/env)
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD
const SESSION_SECRET = process.env.SESSION_SECRET || crypto.randomBytes(32).toString('hex')
const MAX_READS_PER_DAY = Number(process.env.MAX_READS_PER_DAY || 20)
if (!ADMIN_PASSWORD) log('WARNING: ADMIN_PASSWORD is not set, the admin area is locked')

const store = new Store({ log })
const city = new City({ dir: require('path').join(DATA, '..', 'city'), store, log })
const cityServer = new CityServer({ city, resolveState: require('./src/blockstate')('1.21.4').resolve, log })
const proxy = createProxy({ resolveShowcase: () => cityServer.port() })
// build, then put the house in the city (live) if it is published
async function buildAndPublish (id, answers) {
  await store.build(id, answers)
  const m = store.get(id)
  if (m && m.status === 'ready' && m.enabled) cityServer.paste(id).catch(e => log(`[city] paste ${id} failed: ${e.message}`))
}

const app = express()
app.disable('x-powered-by')
app.set('trust proxy', 'loopback')
app.use(cookieParser())

// ---------------------------------------------------------------- admin session (signed cookie)
function sign (v) { return crypto.createHmac('sha256', SESSION_SECRET).update(v).digest('hex') }
function isAdmin (req) {
  const c = req.cookies?.bp_admin; if (!c) return false
  const [exp, sig] = c.split('.')
  return Number(exp) > Date.now() && sig === sign('admin:' + exp)
}
function requireAdmin (req, res, next) { if (isAdmin(req)) return next(); res.status(401).json({ error: 'admin login required' }) }

// ---------------------------------------------------------------- public API
const publicMeta = (m, admin) => {
  const near = cityServer.near(m.id)
  const w = { players: near.length, names: near, running: cityServer.status().running, port: undefined }
  const base = { id: m.id, title: m.title, author: m.author, description: m.description, status: m.status, style: m.style,
    stats: m.stats, rooms: m.rooms, createdAt: m.createdAt, builtAt: m.builtAt, featured: m.featured, enabled: m.enabled,
    editable: m.editable, error: m.status === 'failed' ? m.error : undefined, notes: m.notes, inputs: (m.inputs || []).map(f => f.name),
    online: w.players, explorers: w.names, running: w.running, levels: m.stats?.levels || 0 }
  if (admin) Object.assign(base, { readUsage: m.readUsage, source: m.source, compileInfo: m.compileInfo, port: w.port })
  return base
}

app.get('/api/showcases', (req, res) => {
  const admin = isAdmin(req) && req.query.all
  res.json(store.list().filter(m => admin || (m.enabled && m.status === 'ready')).map(m => publicMeta(m, admin)))
})
app.get('/api/showcases/:id', (req, res) => {
  const m = store.get(req.params.id)
  if (!m || (!m.enabled && !isAdmin(req) && m.status === 'ready')) return res.status(404).json({ error: 'not found' })
  const out = publicMeta(m, isAdmin(req))
  if (m.status === 'questions' || req.query.questions) out.questions = store.readJSON(m.id, 'questions.json')
  if (req.query.questions) out.answers = store.readJSON(m.id, 'answers.json')
  res.json(out)
})

const FILES = {
  'world.zip': id => [store.p(id, 'world', id + '.zip'), id + '.zip'],
  'datapack.zip': id => [store.p(id, 'build', 'maison_rue_datapack.zip'), id + '-datapack.zip'],
  'iso.png': id => [store.p(id, 'build', 'iso.png')],
  'iso_level0.png': id => [store.p(id, 'build', 'iso_level0.png')],
  'iso_level1.png': id => [store.p(id, 'build', 'iso_level1.png')],
  'iso_level2.png': id => [store.p(id, 'build', 'iso_level2.png')],
  'iso_level3.png': id => [store.p(id, 'build', 'iso_level3.png')],
  'layers.png': id => [store.p(id, 'build', 'layers.png')],
  'plan.json': id => [store.p(id, 'plan.json')]
}
app.get('/api/showcases/:id/files/:name', (req, res) => {
  const m = store.get(req.params.id)
  if (!m || (!m.enabled && !isAdmin(req))) return res.status(404).end()
  const f = FILES[req.params.name]
  if (f) {
    const [p, dl] = f(m.id)
    if (!fs.existsSync(p)) return res.status(404).end()
    res.set('Cache-Control', 'no-cache')
    return dl ? res.download(p, dl) : res.sendFile(p)
  }
  const input = (m.inputs || []).find(i => i.name === req.params.name)   // original uploaded plan
  if (input) return res.sendFile(store.p(m.id, 'input', input.stored))
  res.status(404).end()
})
// world zip for the single-player viewer (same origin)
app.get('/view/:id/world.zip', (req, res) => {
  const m = store.get(req.params.id)
  if (!m || !m.enabled || m.status !== 'ready') return res.status(404).end()
  res.sendFile(store.p(m.id, 'world', m.id + '.zip'))
})

// ---------------------------------------------------------------- create: upload -> Claude reads -> questions -> build
const upload = multer({
  dest: path.join(require('os').tmpdir(), 'blockprint-uploads'),
  limits: { fileSize: 20 * 1024 * 1024, files: 6 },
  fileFilter: (req, file, cb) => cb(null, /\.(png|jpe?g|webp|gif|pdf)$/i.test(file.originalname))
})
const reads = []   // timestamps of Claude reads, for the daily cap
app.post('/api/showcases', upload.array('plans', 6), async (req, res) => {
  try { await createShowcase(req, res) } catch (e) {
    log('upload failed', e); for (const f of req.files || []) fs.rmSync(f.path, { force: true })
    if (!res.headersSent) res.status(500).json({ error: 'Saving the upload failed.' })
  }
})
async function createShowcase (req, res) {
  const files = req.files || []
  if (!files.length) return res.status(400).json({ error: 'Add at least one plan (image or PDF).' })
  const now = Date.now(); while (reads.length && now - reads[0] > 86400e3) reads.shift()
  if (reads.length >= MAX_READS_PER_DAY) return res.status(429).json({ error: 'The daily limit of plan readings is reached. Try again tomorrow.' })
  if (!process.env.ANTHROPIC_API_KEY) return res.status(503).json({ error: 'Plan reading is not configured on this server.' })
  reads.push(now)
  const title = String(req.body.title || '').slice(0, 80).trim() || 'My house'
  const author = String(req.body.author || '').slice(0, 40).trim() || 'Anonymous'
  const m = store.create({ title, author, description: String(req.body.description || '').slice(0, 400) })
  const inputs = files.map((f, i) => {
    const stored = `plan-${i + 1}${path.extname(f.originalname).toLowerCase()}`
    fs.copyFileSync(f.path, store.p(m.id, 'input', stored)); fs.rmSync(f.path, { force: true })   // /tmp may be another filesystem
    return { name: f.originalname.replace(/[^\w.\- ]/g, '_'), stored }
  })
  store.update(m.id, { inputs })
  log(`[${m.id}] new plan "${title}" by ${author}, ${files.length} file(s)`)
  const { extractPlan } = require('./src/extract')
  store.read(m.id, { extractPlan })
  res.json({ id: m.id })
}
app.post('/api/showcases/:id/answers', express.json({ limit: '200kb' }), (req, res) => {
  const m = store.get(req.params.id)
  if (!m) return res.status(404).json({ error: 'not found' })
  if (m.status === 'reading' || m.status === 'building') return res.status(409).json({ error: 'busy, try again in a moment' })
  if (m.status === 'ready' && !isAdmin(req)) return res.status(403).json({ error: 'only an admin can change a published showcase' })
  if (!fs.existsSync(store.p(m.id, 'facts.json'))) return res.status(400).json({ error: 'this showcase has no plan reading to answer' })
  const answers = Object.fromEntries(Object.entries(req.body?.answers || {}).filter(([k]) => /^[a-z]+\.[\w.-]+$/.test(k)).slice(0, 500))
  buildAndPublish(m.id, answers)
  res.json({ ok: true })
})
app.post('/api/showcases/:id/retry', (req, res) => {
  const m = store.get(req.params.id)
  if (!m || m.status !== 'failed') return res.status(400).json({ error: 'nothing to retry' })
  if (fs.existsSync(store.p(m.id, 'facts.json'))) buildAndPublish(m.id)
  else { const { extractPlan } = require('./src/extract'); store.read(m.id, { extractPlan }) }
  res.json({ ok: true })
})

// ---------------------------------------------------------------- the city
app.get('/api/city', (req, res) => {
  const st = cityServer.status()
  res.json({ ...city.map(), online: st.online, running: st.running, players: st.players })
})
app.post('/api/city/visit', express.json({ limit: '1kb' }), (req, res) => {   // where this visitor lands when they join
  const username = String(req.body?.username || '')
  if (!/^[A-Za-z0-9_]{3,16}$/.test(username)) return res.status(400).json({ error: 'bad name' })
  const id = req.body?.id && store.get(req.body.id)?.enabled ? req.body.id : null
  cityServer.arrival(username, id)
  res.json({ ok: true, at: id ? city.arrival(id) : { pos: city.spawnPoint() } })
})
app.post('/api/admin/city/restart', requireAdmin, async (req, res) => {
  log('[admin] city restart')
  try { await cityServer.restart(); res.json({ ok: true }) } catch (e) { res.status(500).json({ error: e.message }) }
})

// ---------------------------------------------------------------- admin API
app.post('/api/admin/login', express.json(), (req, res) => {
  const ok = ADMIN_PASSWORD && typeof req.body?.password === 'string' &&
    crypto.timingSafeEqual(crypto.createHash('sha256').update(req.body.password).digest(), crypto.createHash('sha256').update(ADMIN_PASSWORD).digest())
  if (!ok) { log('admin login failed from', req.ip); return setTimeout(() => res.status(401).json({ error: 'wrong password' }), 800) }
  const exp = String(Date.now() + 7 * 86400e3)
  res.cookie('bp_admin', exp + '.' + sign('admin:' + exp), { httpOnly: true, sameSite: 'strict', secure: req.secure || req.get('x-forwarded-proto') === 'https', maxAge: 7 * 86400e3 })
  res.json({ ok: true })
})
app.post('/api/admin/logout', (req, res) => { res.clearCookie('bp_admin'); res.json({ ok: true }) })
app.get('/api/admin/me', (req, res) => res.json({ admin: isAdmin(req) }))
app.post('/api/admin/showcases/:id', requireAdmin, express.json(), (req, res) => {
  const m = store.get(req.params.id); if (!m) return res.status(404).json({ error: 'not found' })
  const patch = {}
  for (const k of ['enabled', 'editable', 'featured']) if (typeof req.body[k] === 'boolean') patch[k] = req.body[k]
  for (const k of ['title', 'author', 'description']) if (typeof req.body[k] === 'string') patch[k] = req.body[k].slice(0, k === 'description' ? 400 : 80)
  const u = store.update(m.id, patch)
  if ('editable' in patch) cityServer.sendRegions()
  if (patch.enabled === false) cityServer.clear(m.id).catch(e => log('[city] clear failed ' + e.message))
  if (patch.enabled === true && u.status === 'ready') cityServer.paste(m.id).catch(e => log('[city] paste failed ' + e.message))
  log(`[admin] ${m.id} ${JSON.stringify(patch)}`)
  res.json(publicMeta(u, true))
})
app.post('/api/admin/showcases/:id/reset', requireAdmin, async (req, res) => {
  const m = store.get(req.params.id); if (!m) return res.status(404).json({ error: 'not found' })
  try { await cityServer.paste(m.id) } catch (e) { return res.status(500).json({ error: e.message }) }   // put the original house back
  log(`[admin] reset house ${m.id}`)
  res.json({ ok: true })
})
app.post('/api/admin/showcases/:id/rebuild', requireAdmin, (req, res) => {
  const m = store.get(req.params.id); if (!m) return res.status(404).json({ error: 'not found' })
  buildAndPublish(m.id); res.json({ ok: true })
})
app.delete('/api/admin/showcases/:id', requireAdmin, async (req, res) => {
  const m = store.get(req.params.id); if (!m) return res.status(404).json({ error: 'not found' })
  await cityServer.clear(m.id).catch(() => {})
  delete city.state.plots[m.id]; city.save()
  store.remove(m.id); log(`[admin] deleted ${m.id}`); res.json({ ok: true })
})

// ---------------------------------------------------------------- multiplayer proxy + in-browser client
app.use(proxy.router)
app.get('/mc/config.json', (req, res) => {   // our own client config: no third-party servers, proxy = this site
  const base = JSON.parse(fs.readFileSync(path.join(MWC, 'config.json'), 'utf8'))
  res.json({ ...base, defaultProxy: '', defaultProxies: [], promoteServers: [], mapsProvider: '', p2pRelayServer: '',
    allowAutoConnect: true, rightSideText: 'Blockprint showcase', splashText: 'Welcome!' })
})
app.get('/config.json', (req, res) => res.redirect('/mc/config.json'))
app.get(['/mc', '/mc/', '/mc/index.html'], (req, res) => {
  if (req.path === '/mc') return res.redirect(301, '/mc/' + (req.url.slice(3) || ''))
  // open the full item list ("Show All") whenever the inventory opens: every item is one click away in creative
  const showAll = `<script>new MutationObserver(() => { for (const b of document.querySelectorAll('button')) { if (/^Show All \\d+ items?$/.test(b.textContent.trim()) && !b.dataset.auto) { b.dataset.auto = 1; b.click() } } }).observe(document.documentElement, { childList: true, subtree: true })</script>`
  const html = fs.readFileSync(path.join(MWC, 'index.html'), 'utf8').replace(/<script[^>]*cloud\.umami\.is[^>]*><\/script>/g, '').replace('</body>', showAll + '</body>')
  res.type('html').send(html)
})
app.use('/mc', express.static(MWC, { index: false }))

// ---------------------------------------------------------------- pages
const page = f => (req, res) => res.sendFile(path.join(PUB, f))
app.get('/', page('index.html'))
app.get('/showcases', page('showcases.html'))
app.get('/s/:id', page('showcase.html'))
app.get(['/create', '/create/:id'], page('create.html'))
app.get('/admin', page('admin.html'))
app.get('/city', page('city.html'))
app.use(express.static(PUB, { index: false }))
app.use(express.static(MWC, { index: false }))   // the client asks for a few files at the site root

module.exports = { app, store, city, cityServer }

if (require.main === module) {
  const port = Number(process.env.PORT || 8090)
  const hosts = (process.env.HOSTS || '127.0.0.1').split(',')
  store.seed().then(() => cityServer.start()).then(() => {
    for (const h of hosts) {
      const srv = http.createServer(app)
      srv.on('upgrade', (req, sock, head) => { if (!proxy.handleUpgrade(req, sock, head)) sock.destroy() })
      srv.listen(port, h, () => log(`listening on http://${h}:${port}`))
    }
  }).catch(e => { console.error(e); process.exit(1) })
  const bye = () => { cityServer.stop(); setTimeout(() => process.exit(0), 300) }
  process.on('SIGTERM', bye); process.on('SIGINT', bye)
}
