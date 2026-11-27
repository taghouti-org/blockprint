// The shared city: every published house gets a permanent plot along a street.
// Layout: a plaza at the west end, an avenue running south from it, and rows of plots east of the avenue,
// each row facing its own street to the north (houses are generated with their street side north).
const fs = require('fs')
const path = require('path')
const { execFile } = require('child_process')
const { promisify } = require('util')
const execFileP = promisify(execFile)
const ROOT = path.resolve(__dirname, '../..')

const GY = -61                       // ground level (grass top) of the superflat
const SIDEWALK = 3, ROAD = 12        // blocks
const STREET = 2 * SIDEWALK + ROAD   // 18
const ROW_LEN = 170                  // blocks of houses per row
const ROW_DEPTH = 80                 // lot depth reserved per row
const GAP = 2                        // between neighbours
const AVENUE_X0 = -SIDEWALK * 2 - ROAD - 4, AVENUE_X1 = -4   // avenue (north-south) west of the plots
const PLAZA = { x0: -46, z0: -STREET - 30, x1: AVENUE_X1, z1: -STREET - 1 }

function rowZ (r) { return r * (ROW_DEPTH + STREET + 4) }   // z of the lot line of row r (street is just north of it)

class City {
  constructor ({ dir, store, log = console.log }) {
    this.dir = dir; this.store = store; this.log = log
    fs.mkdirSync(dir, { recursive: true })
    this.file = path.join(dir, 'city.json')
    this.state = fs.existsSync(this.file) ? JSON.parse(fs.readFileSync(this.file, 'utf8')) : { rows: [], plots: {} }
  }
  save () { fs.writeFileSync(this.file, JSON.stringify(this.state, null, 1)) }

  // blocks of one house (no street), relative to its lot corner; cached per build
  async houseBlocks (id) {
    const planFile = this.store.p(id, 'plan.json')
    const out = this.store.p(id, 'city')
    const cached = path.join(out, 'blocks.json')
    if (!fs.existsSync(cached) || fs.statSync(cached).mtimeMs < fs.statSync(planFile).mtimeMs) {
      await execFileP('python3', [path.join(ROOT, 'gen.py'), planFile, out, '--blocks-only'], { maxBuffer: 50e6 })
    }
    const d = JSON.parse(fs.readFileSync(cached, 'utf8'))
    let x1 = 0, z1 = 0
    for (const [x, , z] of d.blocks) { if (x > x1) x1 = x; if (z > z1) z1 = z }
    return { blocks: d.blocks, w: x1 + 1, d: z1 + 1 }
  }

  // give a plot to a house (keeps the existing one if the house still fits)
  allocate (id, w, d) {
    const p = this.state.plots[id]
    if (p && p.w >= w && p.d >= d) return p
    if (p && p.free !== false) { /* outgrew its plot: leave the old one empty */ }
    let r = this.state.rows.findIndex(row => row.next + w <= ROW_LEN && d <= ROW_DEPTH)
    if (r < 0) { this.state.rows.push({ next: 0 }); r = this.state.rows.length - 1 }
    const row = this.state.rows[r]
    const plot = { row: r, x: row.next, z: rowZ(r), w, d }
    row.next += w + GAP
    this.state.plots[id] = plot
    this.save()
    return plot
  }

  // streets, avenue, plaza, lamps
  streetBlocks () {
    const B = []
    const put = (x, y, z, b) => B.push([x, y, z, b])
    const rows = Math.max(1, this.state.rows.length)
    const xEnd = ROW_LEN + 12
    const street = (x0, x1, zN) => {     // an east-west street whose south sidewalk ends at zN + STREET - 1
      for (let x = x0; x <= x1; x++) {
        for (let k = 0; k < STREET; k++) {
          const z = zN + k
          const side = k < SIDEWALK || k >= SIDEWALK + ROAD
          put(x, GY, z, side ? 'minecraft:stone' : 'minecraft:gray_concrete')
          if (side) put(x, GY + 1, z, (k === SIDEWALK - 1 || k === SIDEWALK + ROAD) ? 'minecraft:stone' : 'minecraft:smooth_stone')
        }
        if ((x - x0) % 6 < 3) put(x, GY, zN + SIDEWALK + ROAD / 2, 'minecraft:white_concrete')
        if ((x - x0) % 16 === 8) {   // lamps on both sides
          for (const z of [zN + 1, zN + STREET - 2]) { for (let y = GY + 2; y <= GY + 8; y++) put(x, y, z, 'minecraft:andesite_wall'); put(x, GY + 9, z, 'minecraft:sea_lantern') }
        }
      }
    }
    for (let r = 0; r < rows; r++) street(AVENUE_X0, xEnd, rowZ(r) - STREET)
    // avenue north-south joining the rows
    const zA = PLAZA.z1 + 1, zB = rowZ(rows - 1) + 4
    for (let z = zA; z <= zB; z++) {
      for (let x = AVENUE_X0; x <= AVENUE_X1; x++) {
        const k = x - AVENUE_X0
        const side = k < SIDEWALK || k >= SIDEWALK + ROAD
        put(x, GY, z, side ? 'minecraft:stone' : 'minecraft:gray_concrete')
        if (side) put(x, GY + 1, z, 'minecraft:smooth_stone')
      }
    }
    // plaza: sandstone square with a fountain-like basin, benches and lamps
    for (let x = PLAZA.x0; x <= PLAZA.x1; x++) {
      for (let z = PLAZA.z0; z <= PLAZA.z1; z++) {
        const edge = x === PLAZA.x0 || x === PLAZA.x1 || z === PLAZA.z0
        put(x, GY, z, 'minecraft:stone'); put(x, GY + 1, z, edge ? 'minecraft:chiseled_sandstone' : ((x + z) % 2 ? 'minecraft:smooth_sandstone' : 'minecraft:cut_sandstone'))
      }
    }
    const cx = Math.round((PLAZA.x0 + PLAZA.x1) / 2), cz = Math.round((PLAZA.z0 + PLAZA.z1) / 2)
    for (let x = cx - 3; x <= cx + 3; x++) {
      for (let z = cz - 3; z <= cz + 3; z++) {
        const ring = Math.max(Math.abs(x - cx), Math.abs(z - cz)) === 3
        put(x, GY + 2, z, ring ? 'minecraft:white_concrete' : 'minecraft:water')
        if (!ring) put(x, GY + 1, z, 'minecraft:light_blue_glazed_terracotta[facing=north]')
      }
    }
    for (let y = GY + 2; y <= GY + 5; y++) put(cx, y, cz, 'minecraft:white_concrete')
    put(cx, GY + 6, cz, 'minecraft:sea_lantern')
    for (const [x, z] of [[PLAZA.x0 + 2, PLAZA.z0 + 2], [PLAZA.x1 - 2, PLAZA.z0 + 2], [PLAZA.x0 + 2, PLAZA.z1 - 2], [PLAZA.x1 - 2, PLAZA.z1 - 2]]) {
      for (let y = GY + 2; y <= GY + 8; y++) put(x, y, z, 'minecraft:andesite_wall'); put(x, GY + 9, z, 'minecraft:sea_lantern')
    }
    return B
  }

  sign (x, z, lines, facing = 8) {   // standing sign, rotation 8 = text faces north (the street)
    const T = (t, v) => ({ type: t, value: v })
    const msg = l => JSON.stringify({ text: l || '' })
    const text = arr => T('compound', { messages: T('list', { type: 'string', value: [0, 1, 2, 3].map(i => msg(arr[i])) }), color: T('string', 'black'), has_glowing_text: T('byte', 1) })
    return {
      block: [x, GY + 2, z, `minecraft:oak_sign[rotation=${facing}]`],
      entity: [x, GY + 2, z, { id: T('string', 'minecraft:sign'), x: T('int', x), y: T('int', GY + 2), z: T('int', z),
        front_text: text(lines), back_text: text(lines), is_waxed: T('byte', 1) }]
    }
  }

  // everything that belongs to one plot, in world coordinates (for building the world or pasting live)
  async plotContent (id) {
    const m = this.store.get(id)
    const h = await this.houseBlocks(id)
    const p = this.allocate(id, h.w, h.d)
    const blocks = h.blocks.map(([x, y, z, b]) => [x + p.x, y, z + p.z, b])
    const s = this.sign(p.x + 1, p.z - 1, [m.title.slice(0, 15), m.title.slice(15, 30), 'by ' + (m.author || '').slice(0, 12), ''])
    blocks.push(s.block)
    return { plot: p, blocks, entities: [s.entity] }
  }

  plotBox (p) { return { x0: p.x, z0: p.z - 1, x1: p.x + p.w - 1, z1: p.z + p.d - 1 } }

  published () { return this.store.list().filter(m => m.enabled && m.status === 'ready').map(m => m.id) }

  // build the whole city world from every published house
  async build (worldDir) {
    const all = { blocks: this.streetBlocks(), entities: [] }
    const ids = this.published()
    for (const id of ids) {
      try { const c = await this.plotContent(id); all.blocks.push(...c.blocks); all.entities.push(...c.entities) } catch (e) { this.log(`[city] ${id} skipped: ${e.message}`) }
    }
    const rows = Math.max(1, this.state.rows.length)
    const xMin = PLAZA.x0 - 8, xMax = ROW_LEN + 16, zMin = PLAZA.z0 - 8, zMax = rowZ(rows - 1) + ROW_DEPTH + 8
    const size = Math.max(xMax - xMin, zMax - zMin)
    const spawn = this.spawnPoint()
    const out = { ground_y: GY, spawn, border_center: [Math.round((xMin + xMax) / 2), Math.round((zMin + zMax) / 2)], border_size: size,
      title: 'Blockprint City', blocks: all.blocks, entities: all.entities }
    const f = path.join(this.dir, 'city_blocks.json')
    fs.writeFileSync(f, JSON.stringify(out))
    const { buildWorld } = require('./world')
    const r = await buildWorld(f, worldDir, '1.21.4')
    this.log(`[city] built ${ids.length} houses, ${r.placed} blocks, ${r.chunks} chunks`)
    return { ...r, houses: ids.length }
  }

  spawnPoint () { return [Math.round((PLAZA.x0 + PLAZA.x1) / 2) + 6, GY + 2, Math.round((PLAZA.z0 + PLAZA.z1) / 2)] }
  arrival (id) {           // on the sidewalk in front of a house, facing it
    const p = this.state.plots[id]
    if (!p) return null
    return { pos: [p.x + Math.min(4, p.w / 2), GY + 2, p.z - 2], yaw: 0 }
  }

  map () {
    const plots = Object.entries(this.state.plots).filter(([id]) => this.store.get(id)?.enabled && this.store.get(id)?.status === 'ready')
      .map(([id, p]) => ({ id, ...p, title: this.store.get(id).title, author: this.store.get(id).author, editable: !!this.store.get(id).editable }))
    const rows = Math.max(1, this.state.rows.length)
    return { plots, rows: Array.from({ length: rows }, (_, r) => ({ z: rowZ(r), street: [rowZ(r) - STREET, rowZ(r) - 1] })),
      plaza: PLAZA, avenue: [AVENUE_X0, AVENUE_X1], rowLen: ROW_LEN, rowDepth: ROW_DEPTH, spawn: this.spawnPoint(), groundY: GY }
  }
}

module.exports = { City, GY }
