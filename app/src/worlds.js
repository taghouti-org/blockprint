// Runs the single city server process and talks to it over IPC.
const path = require('path')
const { fork } = require('child_process')

const PORT = Number(process.env.CITY_PORT || 25700)

class CityServer {
  constructor ({ city, resolveState, log = console.log }) {
    this.city = city; this.resolveState = resolveState; this.log = log
    this.child = null; this.ready = null; this.players = []; this.online = 0; this.reqs = new Map(); this.seq = 0
    this.worldDir = path.join(city.dir, 'world', 'city')
    this.dirty = false   // houses changed live: rebuild (lighting, signs) as soon as the city is empty
    setInterval(() => {
      if (this.dirty && this.child && this.online === 0) { this.dirty = false; this.log('[city] empty: rebuilding to refresh lighting and signs'); this.restart().catch(e => this.log('[city] rebuild failed ' + e.message)) }
    }, 60000).unref()
  }

  async start ({ rebuild = true } = {}) {
    if (rebuild) await this.city.build(this.worldDir)
    const child = fork(path.join(__dirname, 'worldserver.js'), [this.worldDir, String(PORT)], { stdio: ['ignore', 'ignore', 'pipe', 'ipc'] })
    this.child = child
    child.stderr.on('data', d => { const s = d.toString(); if (/error/i.test(s) && !/Warning|DEP0/.test(s)) this.log('[city] ' + s.trim().split('\n')[0].slice(0, 400)) })
    this.ready = new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error('city server did not start')), 90000)
      child.on('message', m => {
        if (m.type === 'ready') { clearTimeout(t); resolve(PORT); this.sendRegions() }
        if (m.type === 'players') { this.online = m.online; this.players = m.players }
        if (m.type === 'done' && this.reqs.has(m.id)) { this.reqs.get(m.id)(m); this.reqs.delete(m.id) }
      })
      child.on('exit', code => { clearTimeout(t); reject(new Error('city server exited ' + code)) })
    })
    child.on('exit', code => {
      if (this.child !== child) return
      this.log(`[city] server exited (${code}), restarting in 3 s`); this.child = null; this.players = []; this.online = 0
      setTimeout(() => this.start({ rebuild: false }).catch(e => this.log('[city] restart failed ' + e.message)), 3000)
    })
    this.ready.catch(() => {})
    this.log(`[city] starting on ${PORT}`)
    return this.ready
  }

  async restart () {   // rebuild from every published house; everyone is disconnected
    const old = this.child; this.child = null
    if (old) { try { old.send({ type: 'stop' }) } catch {} setTimeout(() => { try { old.kill('SIGKILL') } catch {} }, 4000) }
    await new Promise(r => setTimeout(r, 1500))
    return this.start({ rebuild: true })
  }

  stop () { const c = this.child; this.child = null; if (c) { try { c.send({ type: 'stop' }) } catch {} setTimeout(() => { try { c.kill('SIGKILL') } catch {} }, 3000) } }

  async port () { if (!this.ready) throw new Error('the city is not running'); return this.ready }

  call (msg, timeout = 120000) {
    if (!this.child) return Promise.reject(new Error('the city is not running'))
    const id = ++this.seq
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => { this.reqs.delete(id); reject(new Error('city server timeout')) }, timeout)
      this.reqs.set(id, m => { clearTimeout(t); m.error ? reject(new Error(m.error)) : resolve(m) })
      this.child.send({ ...msg, reqId: id })
    })
  }

  send (msg) { if (this.child) try { this.child.send(msg) } catch {} }

  sendRegions () {
    const regions = this.city.store.list().filter(m => m.enabled && m.editable && this.city.state.plots[m.id])
      .map(m => { const p = this.city.state.plots[m.id]; return { x0: p.x, z0: p.z, x1: p.x + p.w - 1, z1: p.z + p.d - 1 } })
    this.send({ type: 'regions', regions })
  }

  arrival (username, id) {
    const a = id ? this.city.arrival(id) : null
    this.send({ type: 'arrival', username, pos: a ? a.pos : this.city.spawnPoint() })
  }

  plotClearBox (p) { return { x0: p.x, z0: p.z, x1: p.x + p.w - 1, z1: p.z + p.d - 1, y1: -61 + 60, groundY: -61, groundState: this.resolveState('minecraft:grass_block[snowy=false]') } }

  // put a (new or rebuilt) house on its plot while people are inside
  async paste (id) {
    await this.port()
    const old = this.city.state.plots[id] && { ...this.city.state.plots[id] }
    const c = await this.city.plotContent(id)
    if (old && (old.x !== c.plot.x || old.z !== c.plot.z)) await this.call({ type: 'clear', box: this.plotClearBox(old) })   // moved to a bigger plot
    const blocks = c.blocks.map(([x, y, z, b]) => [x, y, z, this.resolveState(b)])
    const r = await this.call({ type: 'paste', box: this.plotClearBox(c.plot), blocks })
    this.sendRegions(); this.dirty = true
    return r
  }

  async clear (id) {
    const p = this.city.state.plots[id]; if (!p) return
    await this.port()
    await this.call({ type: 'clear', box: this.plotClearBox(p) })
    await this.call({ type: 'paste', blocks: [[p.x + 1, -59, p.z - 1, 0]] })   // its name sign
    this.sendRegions(); this.dirty = true
  }

  status () { return { running: !!this.child, online: this.online, players: this.players } }

  near (id) {   // explorers standing on or in front of a plot
    const p = this.city.state.plots[id]; if (!p) return []
    return this.players.filter(pl => pl.pos[0] >= p.x - 2 && pl.pos[0] <= p.x + p.w + 1 && pl.pos[2] >= p.z - 20 && pl.pos[2] <= p.z + p.d + 1).map(pl => pl.name)
  }
}

module.exports = { CityServer }
