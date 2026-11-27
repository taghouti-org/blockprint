// blocks.json (from gen.py) -> a real Java Edition world folder + zip.
// Usage: node src/world.js <blocks.json> <out_dir> [version=1.21.4]
const fs = require('fs')
const path = require('path')
const nbt = require('prismarine-nbt')
const zlib = require('zlib')
const { Vec3 } = require('vec3')
const { execFileSync } = require('child_process')

const VERSION_INFO = { '1.21.4': { dataVersion: 4189 } }

let lightMs = 0
async function buildWorld (blocksFile, outDir, version = '1.21.4') {
  const info = VERSION_INFO[version]
  if (!info) throw new Error('unsupported version ' + version)
  const data = JSON.parse(fs.readFileSync(blocksFile, 'utf8'))
  const { resolve, registry } = require('./blockstate')(version)
  const Chunk = require('prismarine-chunk')(registry)
  const Anvil = require('prismarine-provider-anvil').Anvil(registry)

  fs.rmSync(outDir, { recursive: true, force: true })
  fs.mkdirSync(path.join(outDir, 'region'), { recursive: true })

  // area: the world border plus one chunk of margin, all ground pre-written so nothing needs generating
  const half = data.border_size / 2 + 16
  const [bcx, bcz] = data.border_center
  const cx0 = Math.floor((bcx - half) / 16); const cx1 = Math.floor((bcx + half) / 16)
  const cz0 = Math.floor((bcz - half) / 16); const cz1 = Math.floor((bcz + half) / 16)

  const plains = registry.biomesByName.plains.id
  const ground = [[-64, 'minecraft:bedrock'], [-63, 'minecraft:dirt'], [-62, 'minecraft:dirt'], [-61, 'minecraft:grass_block[snowy=false]']]
  const chunks = new Map()
  for (let cx = cx0; cx <= cx1; cx++) {
    for (let cz = cz0; cz <= cz1; cz++) {
      const c = new Chunk({ minY: -64, worldHeight: 384 })
      for (let x = 0; x < 16; x++) {
        for (let z = 0; z < 16; z++) {
          for (const [y, b] of ground) c.setBlockStateId(new Vec3(x, y, z), resolve(b))
        }
      }
      for (let x = 0; x < 16; x += 4) for (let z = 0; z < 16; z += 4) for (let y = -64; y < 320; y += 4) c.setBiome(new Vec3(x, y, z), plains)
      chunks.set(cx + ',' + cz, c)
    }
  }
  let placed = 0; let outside = 0
  for (const [x, y, z, s] of data.blocks) {
    const c = chunks.get(Math.floor(x / 16) + ',' + Math.floor(z / 16))
    if (!c) { outside++; continue }
    c.setBlockStateId(new Vec3(((x % 16) + 16) % 16, y, ((z % 16) + 16) % 16), resolve(s))
    placed++
  }
  // lighting: real sky light and block light (lamps), so servers that send stored light show lit rooms and streets
  const t0 = Date.now()
  computeLight(data, chunks, { cx0, cx1, cz0, cz1, ground, resolve, registry })
  lightMs = Date.now() - t0
  const anvil = new Anvil(path.join(outDir, 'region'))
  for (const [key, c] of chunks) {
    const [cx, cz] = key.split(',').map(Number)
    await anvil.save(cx, cz, c)
  }
  await anvil.close?.()

  writeLevelDat(path.join(outDir, 'level.dat'), data, version, info)
  return { placed, outside, chunks: chunks.size, lightMs }
}

function computeLight (data, chunks, { cx0, cx1, cz0, cz1, ground, resolve, registry }) {
  const X0 = cx0 * 16, Z0 = cz0 * 16, NX = (cx1 - cx0 + 1) * 16, NZ = (cz1 - cz0 + 1) * 16
  let maxY = -61
  for (const b of data.blocks) if (b[1] > maxY) maxY = b[1]
  const Y0 = -64, NY = Math.min(320, maxY + 40) - Y0
  const N = NX * NY * NZ
  const idx = (x, y, z) => ((y * NZ) + z) * NX + x
  const filter = new Uint8Array(N), emit = new Uint8Array(N)
  const fCache = new Map()
  const info = st => {
    let v = fCache.get(st)
    if (!v) { const b = registry.blocksByStateId[st]; v = [b ? b.filterLight : 15, b ? b.emitLight : 0]; fCache.set(st, v) }
    return v
  }
  const setCell = (x, y, z, st) => {
    const i = idx(x - X0, y - Y0, z - Z0); const [f, e] = info(st); filter[i] = f; emit[i] = e
  }
  const groundStates = ground.map(([y, b]) => [y, resolve(b)])
  for (let x = 0; x < NX; x++) for (let z = 0; z < NZ; z++) for (const [y, st] of groundStates) setCell(x + X0, y, z + Z0, st)
  for (const [x, y, z, s] of data.blocks) {
    if (x < X0 || x >= X0 + NX || z < Z0 || z >= Z0 + NZ || y < Y0 || y >= Y0 + NY) continue
    setCell(x, y, z, resolve(s))
  }
  const DIRS = [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]]
  const flood = (light, queue, qlen) => {
    let head = 0
    while (head < qlen) {
      const i = queue[head++]; const L = light[i]; if (L <= 1) continue
      const x = i % NX, z = Math.floor(i / NX) % NZ, y = Math.floor(i / (NX * NZ))
      for (const [dx, dy, dz] of DIRS) {
        const nx = x + dx, ny = y + dy, nz = z + dz
        if (nx < 0 || ny < 0 || nz < 0 || nx >= NX || ny >= NY || nz >= NZ) continue
        const j = idx(nx, ny, nz); const f = filter[j]; if (f >= 15) continue
        const nl = L - 1 - f
        if (nl > light[j]) { light[j] = nl; queue[qlen++] = j }
      }
    }
  }
  // sky: straight down without loss until something blocks it, then spread
  const sky = new Uint8Array(N), queue = new Int32Array(N)
  let q = 0
  for (let x = 0; x < NX; x++) for (let z = 0; z < NZ; z++) {
    let cur = 15
    for (let y = NY - 1; y >= 0; y--) {
      const i = idx(x, y, z); cur -= filter[i]; if (cur <= 0) break
      sky[i] = cur; queue[q++] = i
    }
  }
  flood(sky, queue, q)
  // blocks that give light (lanterns, sea lanterns...)
  const blk = new Uint8Array(N); q = 0
  for (let i = 0; i < N; i++) if (emit[i]) { blk[i] = emit[i]; queue[q++] = i }
  flood(blk, queue, q)
  for (let x = 0; x < NX; x++) for (let z = 0; z < NZ; z++) {
    const wx = x + X0, wz = z + Z0
    const c = chunks.get(Math.floor(wx / 16) + ',' + Math.floor(wz / 16)); if (!c) continue
    const lx = ((wx % 16) + 16) % 16, lz = ((wz % 16) + 16) % 16
    for (let y = 0; y < NY; y++) {
      const i = idx(x, y, z)
      if (sky[i]) c.setSkyLight(new Vec3(lx, y + Y0, lz), sky[i])
      if (blk[i]) c.setBlockLight(new Vec3(lx, y + Y0, lz), blk[i])
    }
  }
}

function writeLevelDat (file, data, version, info) {
  const T = (type, value) => ({ type, value })
  const str = v => T('string', v); const int = v => T('int', v); const byte = v => T('byte', v)
  const long = v => T('long', [Math.floor(v / 2 ** 32), v >>> 0]); const dbl = v => T('double', v)
  const comp = v => T('compound', v)
  const list = (type, arr) => T('list', { type, value: arr })
  const [sx, sy, sz] = data.spawn
  const rules = { doMobSpawning: 'false', doDaylightCycle: 'false', doWeatherCycle: 'false', doPatrolSpawning: 'false',
    doTraderSpawning: 'false', doInsomnia: 'false', doWardenSpawning: 'false', mobGriefing: 'false', doFireTick: 'false' }
  const flatLayers = [['minecraft:bedrock', 1], ['minecraft:dirt', 2], ['minecraft:grass_block', 1]]
  const root = comp({
    Data: comp({
      DataVersion: int(info.dataVersion),
      version: int(19133),
      Version: comp({ Id: int(info.dataVersion), Name: str(version), Series: str('main'), Snapshot: byte(0) }),
      LevelName: str(data.title),
      GameType: int(1), // creative
      Difficulty: byte(0), DifficultyLocked: byte(0), hardcore: byte(0),
      allowCommands: byte(1), initialized: byte(1),
      SpawnX: int(sx), SpawnY: int(sy), SpawnZ: int(sz), SpawnAngle: T('float', 0),
      Time: long(6000), DayTime: long(6000), LastPlayed: long(Date.now()),
      raining: byte(0), rainTime: int(999999), thundering: byte(0), thunderTime: int(999999), clearWeatherTime: int(999999),
      BorderCenterX: dbl(data.border_center[0]), BorderCenterZ: dbl(data.border_center[1]),
      BorderSize: dbl(data.border_size), BorderSizeLerpTarget: dbl(data.border_size), BorderSizeLerpTime: long(0),
      BorderSafeZone: dbl(5), BorderDamagePerBlock: dbl(0.2), BorderWarningBlocks: dbl(5), BorderWarningTime: dbl(15),
      GameRules: comp(Object.fromEntries(Object.entries(rules).map(([k, v]) => [k, str(v)]))),
      WanderingTraderSpawnChance: int(25), WanderingTraderSpawnDelay: int(24000),
      WasModded: byte(0), ServerBrands: list('string', ['vanilla']),
      DataPacks: comp({ Enabled: list('string', ['vanilla']), Disabled: list('string', []) }),
      enabled_features: list('string', ['minecraft:vanilla']),
      ScheduledEvents: list('end', []), CustomBossEvents: comp({}),
      generatorName: str('flat'), // read by the web client's server
      WorldGenSettings: comp({
        seed: long(20261127), generate_features: byte(0), bonus_chest: byte(0),
        dimensions: comp({
          'minecraft:overworld': comp({
            type: str('minecraft:overworld'),
            generator: comp({
              type: str('minecraft:flat'),
              settings: comp({
                biome: str('minecraft:plains'), features: byte(0), lakes: byte(0),
                layers: list('compound', flatLayers.map(([b, h]) => ({ block: str(b), height: int(h) }))),
                structure_overrides: list('string', [])
              })
            })
          }),
          'minecraft:the_nether': comp({
            type: str('minecraft:the_nether'),
            generator: comp({ type: str('minecraft:noise'), settings: str('minecraft:nether'),
              biome_source: comp({ type: str('minecraft:multi_noise'), preset: str('minecraft:nether') }) })
          }),
          'minecraft:the_end': comp({
            type: str('minecraft:the_end'),
            generator: comp({ type: str('minecraft:noise'), settings: str('minecraft:end'),
              biome_source: comp({ type: str('minecraft:the_end') }) })
          })
        })
      })
    })
  })
  root.name = ''
  fs.writeFileSync(file, zlib.gzipSync(nbt.writeUncompressed(root)))
}

function zipDir (dir, zipFile, rootName) {
  fs.rmSync(zipFile, { force: true })
  execFileSync('zip', ['-qr', path.resolve(zipFile), rootName], { cwd: path.dirname(path.resolve(dir)) })
}

module.exports = { buildWorld, zipDir }

if (require.main === module) {
  const [blocksFile, outDir, version] = process.argv.slice(2)
  buildWorld(blocksFile, outDir, version).then(async r => {
    const zipFile = outDir.replace(/\/$/, '') + '.zip'
    await zipDir(outDir, zipFile, path.basename(outDir))
    console.log(JSON.stringify({ ...r, zip: zipFile, bytes: fs.statSync(zipFile).size }))
  }).catch(e => { console.error(e); process.exit(1) })
}
