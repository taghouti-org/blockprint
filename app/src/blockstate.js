// "minecraft:oak_stairs[facing=east]" -> protocol state id for a given version, with unspecified properties at their defaults.
module.exports = function makeResolver (version) {
  const registry = require('minecraft-data')(version)
  const Block = require('prismarine-block')(registry)
  const cache = new Map()
  function parse (s) {
    const m = /^(?:minecraft:)?([a-z0-9_]+)(?:\[(.*)\])?$/.exec(s)
    if (!m) throw new Error('bad block string ' + s)
    const props = {}
    if (m[2]) for (const kv of m[2].split(',')) { const [k, v] = kv.split('='); props[k] = v }
    return { name: m[1], props }
  }
  function resolve (s) {
    if (cache.has(s)) return cache.get(s)
    const { name, props } = parse(s)
    const def = registry.blocksByName[name]
    if (!def) throw new Error(`block ${name} does not exist in ${version}`)
    const defaults = Block.fromStateId(def.defaultState, 0).getProperties()
    for (const k of Object.keys(props)) {
      if (!(k in defaults)) throw new Error(`block ${name} has no property ${k} in ${version}`)
    }
    const merged = {}
    for (const [k, v] of Object.entries({ ...defaults, ...props })) merged[k] = String(v)
    const id = Block.fromProperties(name, merged, 0).stateId
    // round-trip check
    const back = Block.fromStateId(id, 0)
    if (back.name !== name) throw new Error(`round trip name ${s} -> ${back.name}`)
    const bp = back.getProperties()
    for (const [k, v] of Object.entries(merged)) {
      if (String(bp[k]) !== v) throw new Error(`round trip ${s}: ${k}=${bp[k]} expected ${v}`)
    }
    cache.set(s, id)
    return id
  }
  return { resolve, registry, Block }
}
