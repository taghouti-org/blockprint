// The city server: one multiplayer world (space-squid / @zardoy/flying-squid, MIT) for every visitor, localhost only.
// Forked by src/worlds.js and driven over IPC. Standalone: node src/worldserver.js <world_dir> <port>
const fs = require('fs')
const os = require('os')
const path = require('path')
const { Vec3 } = require('vec3')
const { createMCServer } = require('@zardoy/flying-squid')

function startWorldServer ({ worldDir, port, title = 'Blockprint City', maxPlayers = 100 }) {
  // run on a throwaway copy, never save: a restart always starts from the published city
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'city-'))
  fs.cpSync(worldDir, tmp, { recursive: true })
  const serv = createMCServer({
    port, host: '127.0.0.1', 'online-mode': false, version: '1.21.4', motd: title, 'max-players': maxPlayers,
    logging: false, gameMode: 1, difficulty: 0, worldFolder: tmp, savingInterval: false,
    generation: { name: 'superflat', options: { worldHeight: 384, minY: -64 } },
    kickTimeout: 30000, plugins: {}, modpe: false, 'view-distance': 8,
    'player-list-text': { header: { text: title }, footer: { text: 'Every house was built from a floor plan' } },
    'everybody-op': false, 'max-entities': 100
  })
  serv.tmpDir = tmp
  serv.setMaxListeners(100)
  serv.editRegions = []      // [{x0,z0,x1,z1}] plots where visitors may build
  serv.pendingArrivals = new Map()

  const registry = require('minecraft-data')('1.21.4')
  const playerType = registry.entitiesByName.player.id
  const needsSpawnFix = !registry.protocol.play.toClient.types.packet_named_entity_spawn
  // every connection: readable disconnect reasons (the library passes raw Error objects, which cannot be encoded)
  // and the 1.21.2+ entity_teleport format (relative flags, velocity, angles in degrees)
  serv._server.on('connection', client => {
    const end = client.end.bind(client)
    client.end = (reason, ...rest) => {
      if (reason instanceof Error || (reason && typeof reason === 'object' && !reason.type)) {
        if (!/EPIPE|ECONNRESET|socket hang up|ended|closed/i.test(reason.message || '')) console.error(`disconnect error for ${client.username || client.socket?.remoteAddress}: ${reason.message || JSON.stringify(reason)}`)
        reason = 'Disconnected: ' + (reason.message || 'connection error')
      }
      return end(reason, ...rest)
    }
    const write = client.write.bind(client)
    client.write = (name, data) => {
      if (name === 'entity_teleport' && data && data.dx === undefined) {
        const deg = v => (Number.isInteger(v) && v >= -128 && v <= 127) ? v * 360 / 256 : v
        data = { entityId: data.entityId, x: data.x, y: data.y, z: data.z, dx: 0, dy: 0, dz: 0,
          yaw: deg(data.yaw || 0), pitch: deg(data.pitch || 0), flags: { _value: 0 }, onGround: !!data.onGround }
      }
      return write(name, data)
    }
  })
  // same name joining again (second tab, reload before the old connection timed out): the newest one wins
  serv.customGetUsername = async (packet) => {
    const username = packet.username.toLowerCase()
    const old = Object.values(serv._server.clients).find(c => c.username?.toLowerCase?.() === username)
    if (old) {
      try { old.end('You joined from another tab or window') } catch {}
      for (let i = 0; i < 30 && Object.values(serv._server.clients).includes(old); i++) await new Promise(r => setTimeout(r, 100))
      if (Object.values(serv._server.clients).includes(old)) delete serv._server.clients[old.id]
    }
    return username
  }
  const canEdit = (x, z) => serv.editRegions.some(r => x >= r.x0 && x <= r.x1 && z >= r.z0 && z <= r.z1)

  serv.on('newPlayer', player => {
    // Fix: since 1.20.2 players spawn with spawn_entity (type = player) and velocity is one {x,y,z} field;
    // the server still used the removed named_entity_spawn, so visitors could not see each other.
    if (needsSpawnFix) {
      player.spawnPacketName = 'spawn_entity'; player.entityType = playerType; player.data = 0
      const orig = player.getSpawnPacket
      player.getSpawnPacket = () => { const p = orig(); p.velocity = { x: p.velocityX || 0, y: p.velocityY || 0, z: p.velocityZ || 0 }; return p }
    }
    // the server sends the bodies of players already inside before their names (player list) to a newcomer,
    // so the newcomer's client cannot attach names to them: hold those spawns until the player list has arrived
    const joinedAt = Date.now(), origSpawn = player.spawnEntity
    player.spawnEntity = e => {
      const wait = 2500 - (Date.now() - joinedAt)
      if (e.type === 'player' && wait > 0) setTimeout(() => { if (serv.players.includes(e) && !player._client.ended) origSpawn(e) }, wait)
      else origSpawn(e)
    }
    // building is allowed only inside plots marked editable: drop other dig / place packets and undo the client's prediction
    const client = player._client
    const emit = client.emit.bind(client)
    client.emit = (name, data, ...rest) => {
      if ((name === 'block_dig' && data && (data.status === 0 || data.status === 2)) || name === 'block_place') {
        const l = data.location
        if (l && !canEdit(l.x, l.z)) {
          for (const [dx, dy, dz] of [[0, 0, 0], [0, 1, 0], [0, -1, 0], [1, 0, 0], [-1, 0, 0], [0, 0, 1], [0, 0, -1]]) {
            const pos = new Vec3(l.x + dx, l.y + dy, l.z + dz)
            player.world.getBlock(pos).then(b => { try { client.write('block_change', { location: pos, type: b.stateId }) } catch {} }).catch(() => {})
          }
          if (data.sequence !== undefined) { try { client.write('acknowledge_player_digging', { sequenceId: data.sequence }) } catch {} }
          return false
        }
      }
      return emit(name, data, ...rest)
    }
    // arrive with a building palette (the full item list is in the inventory too)
    setTimeout(() => givePalette(player), 2500)
    // land in front of the house the visitor chose on the website (or the plaza)
    player.once('spawned', () => arrive(player))
    setTimeout(() => arrive(player), 1500)
    serv.online = (serv.online || 0) + 1
    setTimeout(report, 2000)
    client.once('end', () => { serv.online--; setTimeout(report, 500) })
  })

  const Item = require('prismarine-item')('1.21.4')
  const PALETTE = [
    // hotbar (slots 36-44)
    'white_concrete', 'smooth_sandstone', 'oak_planks', 'glass_pane', 'oak_door', 'oak_stairs', 'sea_lantern', 'light_blue_glazed_terracotta', 'bricks',
    // inventory (slots 9-35)
    'stone_bricks', 'polished_andesite', 'smooth_quartz', 'terracotta', 'white_terracotta', 'cut_sandstone', 'birch_planks', 'spruce_planks', 'dark_oak_planks',
    'smooth_stone_slab', 'oak_slab', 'quartz_stairs', 'spruce_trapdoor', 'warped_trapdoor', 'iron_door', 'oak_fence', 'glass', 'lantern',
    'blue_concrete', 'light_blue_concrete', 'red_concrete', 'yellow_concrete', 'green_concrete', 'white_wool', 'blue_carpet', 'flower_pot', 'oak_leaves'
  ]
  function givePalette (player) {
    try {
      if (player.gameMode !== 1 || player.inventory.slots.some(Boolean)) return
      PALETTE.forEach((name, i) => {
        const it = registry.itemsByName[name]; if (!it) return
        const slot = i < 9 ? 36 + i : 9 + (i - 9)
        player.inventory.updateSlot(slot, new Item(it.id, it.stackSize || 64))
      })
    } catch (e) { console.error('palette error', e.message) }
  }

  function arrive (player) {
    if (player._arrived) return
    const key = player.username.toLowerCase()
    const target = serv.pendingArrivals.get(key)
    player._arrived = true
    if (!target) return
    serv.pendingArrivals.delete(key)
    try { player.teleport(new Vec3(...target.pos)) } catch {}
  }

  // live edits from the website: paste a house, clear a plot, reset a plot
  serv.applyBlocks = async (blocks) => {
    for (const [x, y, z, stateId] of blocks) await serv.setBlock(serv.overworld, new Vec3(x, y, z), stateId)
  }
  serv.clearBox = async (box, keepY = -62) => {
    const ops = []
    for (let x = box.x0; x <= box.x1; x++) {
      for (let z = box.z0; z <= box.z1; z++) {
        for (let y = keepY + 1; y <= box.y1; y++) {
          const b = await serv.overworld.getBlock(new Vec3(x, y, z))
          const want = y === box.groundY ? box.groundState : 0
          if (b.stateId !== want) ops.push([x, y, z, want])
        }
      }
    }
    await serv.applyBlocks(ops)
    return ops.length
  }

  function report () {
    if (!process.send) return
    process.send({ type: 'players', online: serv.online || 0,
      players: serv.players.map(p => ({ name: p.username, pos: [Math.round(p.position.x), Math.round(p.position.y), Math.round(p.position.z)] })) })
  }
  serv.report = report
  setInterval(report, 3000).unref()
  return serv
}

module.exports = { startWorldServer }

if (require.main === module) {
  const [worldDir, port] = process.argv.slice(2)
  const serv = startWorldServer({ worldDir, port: Number(port) })
  const cleanup = () => { try { fs.rmSync(serv.tmpDir, { recursive: true, force: true }) } catch {} process.exit(0) }
  serv.on('listening', () => { console.log('listening', port); if (process.send) process.send({ type: 'ready', port: Number(port) }) })
  serv.on('error', e => { if (!/toPlayerPacket|behavior/.test(String(e && e.message))) console.error('server error', e && e.message) })
  process.on('message', async m => {
    try {
      if (m.type === 'regions') serv.editRegions = m.regions
      if (m.type === 'arrival') serv.pendingArrivals.set(m.username.toLowerCase(), { pos: m.pos, at: Date.now() })
      if (m.type === 'status') serv.report()
      if (m.type === 'paste') { const n = m.box ? await serv.clearBox(m.box) : 0; await serv.applyBlocks(m.blocks); process.send({ type: 'done', id: m.reqId, cleared: n, placed: m.blocks.length }) }
      if (m.type === 'clear') { const n = await serv.clearBox(m.box); process.send({ type: 'done', id: m.reqId, cleared: n }) }
      if (m.type === 'stop') cleanup()
    } catch (e) { if (m.reqId) process.send({ type: 'done', id: m.reqId, error: e.message }) }
  })
  process.on('SIGTERM', cleanup); process.on('SIGINT', cleanup); process.on('disconnect', cleanup)
}
