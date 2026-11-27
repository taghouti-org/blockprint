const test = require('node:test')
const assert = require('node:assert')
const fs = require('fs')
const path = require('path')
const zlib = require('zlib')
const nbt = require('prismarine-nbt')
const { Vec3 } = require('vec3')
const { buildWorld } = require('../src/world')

const { execFileSync } = require('child_process')
const OUT = path.join(__dirname, '../.tmp/world_test')
// generate the sample house (house_plan.json) once for these tests
const BUILD = path.join(__dirname, '../.tmp/sample_build')
execFileSync('python3', [path.join(__dirname, '../../gen.py'), path.join(__dirname, '../../house_plan.json'), BUILD])
const BLOCKS = path.join(BUILD, 'blocks.json')

test('every planned block is in the saved world, ground is filled, level.dat is valid', async () => {
  const r = await buildWorld(BLOCKS, OUT, '1.21.4')
  assert.strictEqual(r.outside, 0)
  const registry = require('minecraft-data')('1.21.4')
  const Anvil = require('prismarine-provider-anvil').Anvil(registry)
  const { resolve } = require('../src/blockstate')('1.21.4')
  const anvil = new Anvil(path.join(OUT, 'region'))
  const data = JSON.parse(fs.readFileSync(BLOCKS, 'utf8'))
  const cache = new Map()
  let checked = 0
  for (const [x, y, z, s] of data.blocks) {
    const key = Math.floor(x / 16) + ',' + Math.floor(z / 16)
    if (!cache.has(key)) cache.set(key, await anvil.load(Math.floor(x / 16), Math.floor(z / 16)))
    const c = cache.get(key)
    assert.ok(c, 'chunk missing ' + key)
    const got = c.getBlockStateId(new Vec3(((x % 16) + 16) % 16, y, ((z % 16) + 16) % 16))
    assert.strictEqual(got, resolve(s), `block at ${x},${y},${z} expected ${s}`)
    checked++
  }
  assert.strictEqual(checked, data.blocks.length)
  // ground far from the house: grass on top, bedrock at the bottom, air above
  const c = await anvil.load(-2, -2)
  assert.strictEqual(c.getBlock(new Vec3(5, -61, 5)).name, 'grass_block')
  assert.strictEqual(c.getBlock(new Vec3(5, -64, 5)).name, 'bedrock')
  assert.strictEqual(c.getBlock(new Vec3(5, -60, 5)).name, 'air')

  const lvl = nbt.simplify((await nbt.parse(zlib.gunzipSync(fs.readFileSync(path.join(OUT, 'level.dat'))))).parsed).Data
  assert.strictEqual(lvl.DataVersion, 4189)
  assert.strictEqual(lvl.Version.Name, '1.21.4')
  assert.strictEqual(lvl.GameType, 1)
  assert.strictEqual(lvl.GameRules.doMobSpawning, 'false')
  assert.deepStrictEqual([lvl.SpawnX, lvl.SpawnY, lvl.SpawnZ], data.spawn)
  assert.strictEqual(lvl.WorldGenSettings.dimensions['minecraft:overworld'].generator.type, 'minecraft:flat')
})

test('a stair without properties is not waterlogged and the house has real door panels', () => {
  const { resolve, Block } = require('../src/blockstate')('1.21.4')
  const p = Block.fromStateId(resolve('minecraft:oak_stairs'), 0).getProperties()
  assert.strictEqual(p.waterlogged, false)
  const data = JSON.parse(fs.readFileSync(BLOCKS, 'utf8'))
  const doors = data.blocks.filter(b => b[3].startsWith('minecraft:warped_trapdoor[open=true'))
  assert.ok(doors.length >= 40, 'door panels present: ' + doors.length)
})
