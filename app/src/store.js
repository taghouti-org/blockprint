// Showcases on disk + the build pipeline (Claude reading -> questionnaire -> compile -> world).
const fs = require('fs')
const path = require('path')
const crypto = require('crypto')
const { execFile } = require('child_process')
const { promisify } = require('util')
const { buildWorld, zipDir } = require('./world')
const execFileP = promisify(execFile)

const ROOT = path.resolve(__dirname, '../..')            // minecraft-house/
const DATA = process.env.DATA_DIR || path.join(ROOT, 'data', 'showcases')
const PY = 'python3'

function slug (s) {
  return (s || 'plan').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'plan'
}

class Store {
  constructor ({ log = console.log } = {}) {
    this.log = log
    fs.mkdirSync(DATA, { recursive: true })
    this.cache = new Map()
    for (const id of fs.readdirSync(DATA)) {
      try { this.cache.set(id, JSON.parse(fs.readFileSync(this.p(id, 'meta.json'), 'utf8'))) } catch {}
    }
    // a build interrupted by a restart is marked failed so it can be retried
    for (const m of this.cache.values()) if (['reading', 'building'].includes(m.status)) this.update(m.id, { status: 'failed', error: 'interrupted by a server restart, please retry' })
  }

  p (id, ...rest) { return path.join(DATA, id, ...rest) }
  list () { return [...this.cache.values()].sort((a, b) => (b.featured ? 1 : 0) - (a.featured ? 1 : 0) || b.createdAt.localeCompare(a.createdAt)) }
  get (id) { return this.cache.get(id) }
  update (id, patch) {
    const m = { ...this.cache.get(id), ...patch, updatedAt: new Date().toISOString() }
    fs.writeFileSync(this.p(id, 'meta.json'), JSON.stringify(m, null, 1))
    this.cache.set(id, m)
    return m
  }
  readJSON (id, f) { try { return JSON.parse(fs.readFileSync(this.p(id, f), 'utf8')) } catch { return null } }
  worldDir (id) { const d = this.p(id, 'world', id); return fs.existsSync(path.join(d, 'level.dat')) ? d : null }

  create ({ title, author, description = '', source = 'upload' }) {
    let id = slug(title)
    while (this.cache.has(id) || fs.existsSync(this.p(id))) id = slug(title) + '-' + crypto.randomBytes(2).toString('hex')
    fs.mkdirSync(this.p(id, 'input'), { recursive: true })
    const now = new Date().toISOString()
    const m = { id, title: title || 'Untitled plan', author: author || 'Anonymous', description, source, createdAt: now, updatedAt: now,
      status: 'new', enabled: true, editable: false, featured: false, inputs: [] }
    fs.writeFileSync(this.p(id, 'meta.json'), JSON.stringify(m, null, 1))
    this.cache.set(id, m)
    return m
  }

  remove (id) { fs.rmSync(this.p(id), { recursive: true, force: true }); this.cache.delete(id) }

  // ---- pipeline
  async read (id, { extractPlan }) {
    const m = this.get(id)
    this.update(id, { status: 'reading', error: null, startedReadingAt: new Date().toISOString() })
    try {
      const files = m.inputs.map(f => ({ path: this.p(id, 'input', f.stored), label: f.name }))
      const r = await extractPlan(files)
      fs.writeFileSync(this.p(id, 'facts.json'), JSON.stringify(r, null, 1))
      await this.makeQuestions(id)
      this.update(id, { status: 'questions', readUsage: r.usage && { input: r.usage.input_tokens, output: r.usage.output_tokens }, readModel: r.model })
    } catch (e) {
      this.log(`[${id}] reading failed: ${e.stack || e}`)
      this.update(id, { status: 'failed', error: 'Reading the plan failed: ' + (e.message || e) })
    }
  }

  async makeQuestions (id) {
    const { stdout } = await execFileP(PY, [path.join(ROOT, 'compile.py'), 'questions', this.p(id, 'facts.json')], { maxBuffer: 20e6 })
    fs.writeFileSync(this.p(id, 'questions.json'), stdout)
  }

  async build (id, answers) {
    const m = this.get(id)
    this.update(id, { status: 'building', error: null })
    try {
      let planFile = this.p(id, 'plan.json')
      if (answers) fs.writeFileSync(this.p(id, 'answers.json'), JSON.stringify(answers, null, 1))
      if (fs.existsSync(this.p(id, 'facts.json'))) {
        const ans = fs.existsSync(this.p(id, 'answers.json')) ? this.p(id, 'answers.json') : '-'
        const { stdout } = await execFileP(PY, [path.join(ROOT, 'compile.py'), 'plan', this.p(id, 'facts.json'), ans, planFile])
        this.update(id, { compileInfo: JSON.parse(stdout.trim().split('\n').pop()) })
      }
      const plan = JSON.parse(fs.readFileSync(planFile, 'utf8'))
      plan.world.title = m.title
      fs.writeFileSync(planFile, JSON.stringify(plan, null, 1))
      const build = this.p(id, 'build')
      await execFileP(PY, [path.join(ROOT, 'gen.py'), planFile, build], { maxBuffer: 20e6 })
      const worldDir = this.p(id, 'world', id)
      const r = await buildWorld(path.join(build, 'blocks.json'), worldDir, '1.21.4')
      zipDir(worldDir, worldDir + '.zip', id)
      const rooms = plan.levels.flatMap(l => l.floors.map(f => f.room))
      const style = (this.readJSON(id, 'answers.json') || {})['house.style'] || m.style || 'tunisian'
      this.update(id, {
        status: 'ready', builtAt: new Date().toISOString(), style,
        stats: { blocks: r.placed, levels: plan.levels.length, rooms: rooms.length, furniture: plan.levels.reduce((n, l) => n + (l.furniture || []).length, 0),
          scale: `1 block = ${100 / plan.scale} cm` },
        rooms, notes: plan.notes || []
      })
    } catch (e) {
      this.log(`[${id}] build failed: ${e.stack || e}`)
      this.update(id, { status: 'failed', error: 'Building the world failed: ' + (e.stderr || e.message || e).toString().slice(-500) })
    }
  }

  // seed the gallery the first time: the hand-tuned house, and the same house rebuilt from Claude's reading alone
  async seed () {
    if (this.cache.size) return
    const hand = this.create({ title: 'Maison Tunisienne', author: 'Tarek', source: 'sample',
      description: 'Two-floor house with a front yard, a courtyard open to the sky and a roof terrace. Hand-tuned from the original plan.' })
    fs.copyFileSync(path.join(ROOT, 'house_plan.json'), this.p(hand.id, 'plan.json'))
    for (const f of ['ground_floor.png', 'upper_floor.png']) fs.copyFileSync(path.join(__dirname, '../test/fixtures', f), this.p(hand.id, 'input', f))
    this.update(hand.id, { inputs: [{ name: 'ground_floor.png', stored: 'ground_floor.png' }, { name: 'upper_floor.png', stored: 'upper_floor.png' }], featured: true, style: 'tunisian' })
    await this.build(hand.id)
    const auto = this.create({ title: 'Maison — read by Claude', author: 'Tarek', source: 'upload',
      description: 'The same plan, read by Claude and built automatically with the default answers: furniture placed by the layout engine.' })
    fs.copyFileSync(path.join(__dirname, '../test/fixtures/extracted_maison.json'), this.p(auto.id, 'facts.json'))
    for (const f of ['ground_floor.png', 'upper_floor.png']) fs.copyFileSync(path.join(__dirname, '../test/fixtures', f), this.p(auto.id, 'input', f))
    this.update(auto.id, { inputs: [{ name: 'ground_floor.png', stored: 'ground_floor.png' }, { name: 'upper_floor.png', stored: 'upper_floor.png' }] })
    await this.makeQuestions(auto.id)
    await this.build(auto.id, {})
  }
}

module.exports = { Store, DATA, ROOT }
