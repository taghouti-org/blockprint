// Read floor plan drawings (images / PDFs) with Claude and return structured plan facts in meters.
const fs = require('fs')
const path = require('path')
const Anthropic = require('@anthropic-ai/sdk').default

const MODEL = 'claude-opus-5-5'

const SPACE_TYPES = ['bedroom', 'living', 'dining', 'living_dining', 'kitchen', 'bathroom', 'wc', 'hallway', 'landing',
  'stairs', 'office', 'storage', 'closet', 'laundry', 'garage', 'courtyard', 'yard', 'terrace', 'light_shaft', 'other', 'unknown']
const SOURCE = { type: 'string', enum: ['plan', 'guess'] }
const RECT = { type: 'array', items: { type: 'number' }, description: '[x0, z0, x1, z1] in meters, x0<x1, z0<z1' }

const SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['lot', 'levels', 'street_side', 'assumptions', 'notes'],
  properties: {
    lot: {
      type: 'object', additionalProperties: false, required: ['width', 'depth', 'source', 'evidence'],
      properties: { width: { type: 'number' }, depth: { type: 'number' }, source: SOURCE, evidence: { type: 'string' } }
    },
    street_side: {
      type: 'object', additionalProperties: false, required: ['value', 'source', 'evidence'],
      properties: { value: { type: 'string', enum: ['north', 'south', 'east', 'west', 'unknown'] }, source: SOURCE, evidence: { type: 'string' } }
    },
    levels: {
      type: 'array',
      items: {
        type: 'object', additionalProperties: false,
        required: ['index', 'name', 'drawing', 'outline', 'spaces', 'walls', 'openings', 'stairs'],
        properties: {
          index: { type: 'integer', description: '0 = ground floor, 1 = first upper floor...' },
          name: { type: 'string' },
          drawing: { type: 'string', description: 'which input file / page this level comes from' },
          outline: { ...RECT, description: 'outer rectangle of this level (exterior walls), shared coordinates' },
          spaces: {
            type: 'array',
            items: {
              type: 'object', additionalProperties: false,
              required: ['id', 'label', 'rect', 'type', 'type_source', 'covered', 'covered_source', 'evidence'],
              properties: {
                id: { type: 'string', description: 'short unique id, e.g. g_salle, u_ch1' },
                label: { type: 'string', description: 'text written in the space, exactly as on the plan, or empty' },
                rect: RECT,
                type: { type: 'string', enum: SPACE_TYPES },
                type_source: SOURCE,
                covered: { type: 'string', enum: ['covered', 'open', 'unknown'], description: 'open = open to the sky (hatched, "non couvert", courtyard)' },
                covered_source: SOURCE,
                evidence: { type: 'string', description: 'why: label, hatching, symbols, dimensions' }
              }
            }
          },
          walls: { type: 'array', items: RECT, description: 'axis-aligned wall center lines [x0,z0,x1,z1] (x0==x1 or z0==z1)' },
          openings: {
            type: 'array',
            items: {
              type: 'object', additionalProperties: false,
              required: ['type', 'axis', 'at', 'from', 'to', 'between', 'source'],
              properties: {
                type: { type: 'string', enum: ['door', 'window', 'opening'] },
                axis: { type: 'string', enum: ['x', 'z'], description: 'x: on a wall line x=at (runs north-south); z: on a wall line z=at (runs east-west)' },
                at: { type: 'number' }, from: { type: 'number' }, to: { type: 'number' },
                between: { type: 'array', items: { type: 'string' }, description: 'the two space ids on each side, or "outside"' },
                source: SOURCE
              }
            }
          },
          stairs: {
            type: 'array',
            items: {
              type: 'object', additionalProperties: false,
              required: ['rect', 'up', 'to', 'source', 'evidence'],
              properties: {
                rect: RECT,
                up: { type: 'string', enum: ['north', 'south', 'east', 'west'], description: 'direction you walk when going up' },
                to: { type: 'string', enum: ['next_level', 'roof'] },
                source: SOURCE, evidence: { type: 'string' }
              }
            }
          }
        }
      }
    },
    assumptions: { type: 'array', items: { type: 'string' }, description: 'everything you had to guess, in plain words' },
    notes: { type: 'string' }
  }
}

const SYSTEM = `You read architectural floor plans and describe them as exact geometry so a program can rebuild the building in a game.

Coordinates: meters, one shared system for all floors. Origin = top-left outer corner of the ground floor drawing.
x grows to the right, z grows downward (the top of the drawing is "north" unless a north arrow says otherwise).
Align upper floors on the ground floor using shared features (outer walls, stair positions, courtyards, the overall
dimensions written on the sides). An upper floor that is smaller than the ground floor is offset accordingly.

Use the written dimensions (e.g. "3 x 4 m", side dimension chains) as the ground truth and compute positions from them;
snap to 0.25 m. Walls are center lines on the plan lines. Every room gets a space with its exact label text.
Hatched areas or "non couvert" / "courette" / "cour" / "patio" mean open to the sky (covered="open", source "plan").
Small cupboards marked D or "placard" are closets. "Esc." means stairs; step lines and the side of the arrival tell
the direction of climb. Door arcs and gaps are doors; thick colored segments on walls are windows; a gap with no
leaf is an "opening". For each opening give the two spaces it connects ("outside" for the exterior).

Mark source "plan" only for facts written or drawn on the plan; anything inferred is "guess", and list each guess in
plain words in "assumptions" (e.g. "the large bedroom has no door on the drawing; added one from the landing").`

function mediaBlock (file) {
  const data = fs.readFileSync(file).toString('base64')
  const ext = path.extname(file).toLowerCase()
  if (ext === '.pdf') return { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data } }
  const media = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.gif': 'image/gif' }[ext]
  if (!media) throw new Error('unsupported file type ' + ext)
  return { type: 'image', source: { type: 'base64', media_type: media, data } }
}

async function extractPlan (files, { client = new Anthropic(), onProgress = () => {} } = {}) {
  const content = []
  files.forEach((f, i) => {
    content.push({ type: 'text', text: `Input ${i + 1}: ${f.label || path.basename(f.path)}` })
    content.push(mediaBlock(f.path))
  })
  content.push({ type: 'text', text: 'Describe every floor of this building as JSON following the schema.' })
  onProgress('reading')
  const stream = client.beta.messages.stream({
    model: MODEL,
    max_tokens: 64000,
    betas: ['server-side-fallback-2026-07-01'],
    fallbacks: 'default',
    thinking: { type: 'adaptive' },
    output_config: { effort: 'high', format: { type: 'json_schema', schema: SCHEMA } },
    system: SYSTEM,
    messages: [{ role: 'user', content }]
  })
  const msg = await stream.finalMessage()
  if (msg.stop_reason === 'refusal') throw new Error('Claude declined to read this plan' + (msg.stop_details?.explanation ? ': ' + msg.stop_details.explanation : ''))
  if (msg.stop_reason === 'max_tokens') throw new Error('the plan description was cut off (too long)')
  const text = msg.content.filter(b => b.type === 'text').map(b => b.text).join('')
  let facts
  try { facts = JSON.parse(text) } catch (e) { throw new Error('Claude returned invalid JSON: ' + e.message) }
  validate(facts)
  return { facts, usage: msg.usage, model: msg.model }
}

function validate (f) {
  const problems = []
  const rectOk = r => Array.isArray(r) && r.length === 4 && r.every(Number.isFinite) && r[0] < r[2] && r[1] < r[3]
  if (!f.levels?.length) problems.push('no floors found')
  for (const l of f.levels || []) {
    if (!rectOk(l.outline)) problems.push(`level ${l.name}: bad outline`)
    const ids = new Set()
    for (const s of l.spaces) {
      if (!rectOk(s.rect)) problems.push(`space ${s.id}: bad rect`)
      if (ids.has(s.id)) problems.push(`duplicate space id ${s.id}`)
      ids.add(s.id)
    }
    for (const w of l.walls) if (!(Array.isArray(w) && w.length === 4 && (w[0] === w[2] || w[1] === w[3]))) problems.push(`level ${l.name}: wall not axis-aligned ${JSON.stringify(w)}`)
    for (const s of l.stairs) if (!rectOk(s.rect)) problems.push(`level ${l.name}: bad stair rect`)
  }
  if (problems.length) throw new Error('plan description has problems: ' + problems.join('; '))
}

module.exports = { extractPlan, SCHEMA, SPACE_TYPES, MODEL, validate }

if (require.main === module) {
  // node src/extract.js out.json file1 [file2...]
  const [out, ...inputs] = process.argv.slice(2)
  const t0 = Date.now()
  extractPlan(inputs.map(p => ({ path: p })), { onProgress: s => console.error(s) })
    .then(r => { fs.writeFileSync(out, JSON.stringify(r, null, 1)); console.log(JSON.stringify({ ms: Date.now() - t0, usage: r.usage, model: r.model })) })
    .catch(e => { console.error('FAILED', e.message); process.exit(1) })
}
