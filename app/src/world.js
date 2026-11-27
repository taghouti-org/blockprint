// blocks.json (from gen.py) -> a real Java Edition world folder + zip.
// Usage: node src/world.js <blocks.json> <out_dir> [version=1.21.4]
const fs = require('fs')
const path = require('path')
const nbt = require('prismarine-nbt')
const zlib = require('zlib')
const { Vec3 } = require('vec3')
const { execFileSync } = require('child_process')

const VERSION_INFO = { '1.21.4': { dataVersion: 4189 } }

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
  // sky light: full above the highest block of each column, so viewers that read stored light show daylight
  for (const c of chunks.values()) {
    for (let x = 0; x < 16; x++) {
      for (let z = 0; z < 16; z++) {
        let top = 319
        while (top > -64 && c.getBlockStateId(new Vec3(x, top, z)) === 0) top--
        for (let y = top + 1; y < Math.min(320, top + 48); y++) c.setSkyLight(new Vec3(x, y, z), 15)
      }
    }
  }
  for (const [x, y, z, tag] of data.entities || []) {   // block entities (sign text...)
    const c = chunks.get(Math.floor(x / 16) + ',' + Math.floor(z / 16))
    if (c) c.setBlockEntity({ x: ((x % 16) + 16) % 16, y, z: ((z % 16) + 16) % 16 }, tag)
  }
  const anvil = new Anvil(path.join(outDir, 'region'))
  for (const [key, c] of chunks) {
    const [cx, cz] = key.split(',').map(Number)
    await anvil.save(cx, cz, c)
  }
  await anvil.close?.()

  writeLevelDat(path.join(outDir, 'level.dat'), data, version, info)
  return { placed, outside, chunks: chunks.size }
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
