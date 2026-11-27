// Claude's reading of the sample plan -> every style x scale compiles, generates, and writes a valid 1.21.4 world.
const test = require('node:test')
const assert = require('node:assert')
const fs = require('fs'); const os = require('os'); const path = require('path')
const { execFileSync } = require('child_process')
const { buildWorld } = require('../src/world')
const ROOT = path.resolve(__dirname, '../..')
const FACTS = path.join(__dirname, 'fixtures/extracted_maison.json')

for (const style of ['tunisian', 'modern', 'classic']) {
  for (const scale of ['0.25', '0.5', '1']) {
    test(`style ${style}, scale ${scale}`, async () => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bp-'))
      fs.writeFileSync(path.join(dir, 'a.json'), JSON.stringify({ 'house.style': style, 'house.scale': scale }))
      const info = JSON.parse(execFileSync('python3', [path.join(ROOT, 'compile.py'), 'plan', FACTS, path.join(dir, 'a.json'), path.join(dir, 'plan.json')]).toString().trim())
      assert.strictEqual(info.levels, 2)
      assert.ok(info.furniture >= (scale === '1' ? 8 : 25), 'furniture placed: ' + info.furniture)
      const out = execFileSync('python3', [path.join(ROOT, 'gen.py'), path.join(dir, 'plan.json'), path.join(dir, 'build')]).toString()
      assert.match(out, /unknown colours: \[\]/)
      const r = await buildWorld(path.join(dir, 'build/blocks.json'), path.join(dir, 'world/w'), '1.21.4')   // throws on any block not in 1.21.4
      assert.strictEqual(r.outside, 0)
      fs.rmSync(dir, { recursive: true, force: true })
    })
  }
}

test('questionnaire: plan facts prefilled with sources, street side inferred from the entrance', () => {
  const q = JSON.parse(execFileSync('python3', [path.join(ROOT, 'compile.py'), 'questions', FACTS]).toString())
  const fields = q.sections.flatMap(s => s.items.flatMap(i => i.fields || [i]))
  const get = k => fields.find(f => f.key === k)
  assert.strictEqual(get('space.g_salle.type').value, 'living'); assert.strictEqual(get('space.g_salle.type').source, 'plan')
  assert.strictEqual(get('space.g_courette.covered').value, 'open'); assert.strictEqual(get('space.g_courette.covered').source, 'plan')
  assert.strictEqual(get('space.g_noncouvert.type').value, 'yard'); assert.strictEqual(get('space.g_noncouvert.type').source, 'guess')
  assert.strictEqual(get('house.street_side').value, 'north')
  assert.strictEqual(get('space.u_ch2.occupants').value, 'couple')
  assert.ok(q.assumptions.length > 3)
})

test('street on another side: the plan is rotated so the street is north', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bp-'))
  fs.writeFileSync(path.join(dir, 'a.json'), JSON.stringify({ 'house.street_side': 'east' }))
  execFileSync('python3', [path.join(ROOT, 'compile.py'), 'plan', FACTS, path.join(dir, 'a.json'), path.join(dir, 'plan.json')])
  const plan = JSON.parse(fs.readFileSync(path.join(dir, 'plan.json')))
  const fp = plan.levels[0].footprint
  assert.strictEqual(fp[2] - fp[0], 13, 'width is now the 13 m side')
  assert.ok(!plan.yard, 'no yard along the new street side')
  fs.rmSync(dir, { recursive: true, force: true })
})
