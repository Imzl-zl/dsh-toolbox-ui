// Generic source contracts supersede the old audited-name/hash and known-name priority rules.
// Frozen real description fixtures supplement arbitrary-source tests; no implementation summaries are oracles.
import assert from 'node:assert/strict'
import test from 'node:test'
import { capabilityCues, descriptionParagraph } from '../lib/tool-discovery-cues.js'
import { buildCatalog, searchCatalog } from '../lib/tool-search-index.js'

const OPTIONS = { timeout: 60_000 }
const LIMIT = 800
const SHORT_PARAGRAPH_LIMIT = 160
const SENTENCE_LIMIT = 240
// Verbatim real-host description fixtures are embedded for clean-checkout portability.
// Their names and later paragraphs must not control whether the same literal source purpose is shown.
const capture = [
  {
    "name": "read",
    "description": "Read a UTF-8 text file and return line-numbered content."
  },
  {
    "name": "write",
    "description": "Create or fully replace a UTF-8 text file."
  },
  {
    "name": "edit",
    "description": "Edit an existing UTF-8 text file by replacing literal text."
  },
  {
    "name": "subagent",
    "description": "Delegate a self-contained task to a subagent (a separate agent that works in its own context) to offload focused, independent work — research, a scoped implementation, an analysis — so it does not consume this conversation's context. The subagent returns its result, not its intermediate steps. This tool starts an independently managed subagent and immediately returns its name. If you are still online when it finishes, the runtime automatically delivers its completion notice. The notice includes the final answer unless the child sent you a message just before finishing. Use `send_message` to steer it while running or continue its conversation after it finishes. Omit `provider`, `model`, and `reasoning_effort` to use child defaults, falling back to compatible parent values."
  },
  {
    "name": "subagent_fork",
    "description": "Delegate a task to a subagent that inherits this conversation: a child agent seeded with all completed turns so far (it does not see the current in-flight turn). Use this when the subtask builds on this conversation's context — a follow-up analysis, a review, a continuation — without consuming this conversation's context for the work itself. You receive its result, not its intermediate steps. This tool starts an independently managed subagent and immediately returns its name. If you are still online when it finishes, the runtime automatically delivers its completion notice. The notice includes the final answer unless the child sent you a message just before finishing. Use `send_message` to steer it while running or continue its conversation after it finishes."
  }
]
const core = capture
const normalize = text => text.replace(/\s+/g, ' ').trim()
const completeParagraph = text => text.replace(/\r\n?/g, '\n').split(/\n[ \t]*\n/).find(part => part.trim())?.replace(/\s+/g, ' ').trim() ?? ''
const row = (name, description, owner) => ({ name, description, owner, parameters: { type: 'object', properties: { input: { type: 'string' } } } })

function render(rows, instructionsOf = () => '') {
  const catalog = new Map(rows.map(definition => [definition.name, definition]))
  const groups = new Map()
  const unattributed = []
  for (const definition of rows) {
    if (definition.owner === undefined) unattributed.push(definition)
    else {
      if (!groups.has(definition.owner)) groups.set(definition.owner, [])
      groups.get(definition.owner).push({ name: definition.name })
    }
  }
  const grouped = { groups: [...groups].map(([server, names]) => ({ server, names })), unattributed }
  const before = JSON.stringify({ rows, grouped })
  const cues = capabilityCues(catalog, grouped, instructionsOf)
  assert.equal(JSON.stringify({ rows, grouped }), before, 'hints are pure metadata, not registration/discovery mutation')
  return { cues, catalog }
}
function entries(cues) {
  return cues.text.split('\n').filter(line => line.startsWith('- ')).map(line => {
    const match = /^- ("(?:\\.|[^"\\])*") — ("(?:\\.|[^"\\])*")$/.exec(line)
    assert.ok(match, 'selected hints are complete JSON-literal lines, never clipped mid-entry')
    return { name: JSON.parse(match[1]), purpose: JSON.parse(match[2]), line }
  })
}
function bounded(cues) {
  assert.ok(cues.text.length <= LIMIT, `whole cue text, including guide/headings, exceeds ${LIMIT}: ${cues.text.length}`)
  assert.equal(cues.chars, cues.text.length)
  assert.equal(cues.count, entries(cues).length)
}

// Externally given full first sentences, not purpose strings or hashes read from production.
const delegateFirstSentences = {
  subagent: "Delegate a self-contained task to a subagent (a separate agent that works in its own context) to offload focused, independent work — research, a scoped implementation, an analysis — so it does not consume this conversation's context.",
  subagent_fork: 'Delegate a task to a subagent that inherits this conversation: a child agent seeded with all completed turns so far (it does not see the current in-flight turn).',
}
for (const name of ['subagent', 'subagent_fork']) {
  test(`generic ${name}: long actual metadata quotes its complete first sentence, never a manual summary`, OPTIONS, () => {
    const definition = core.find(row => row.name === name)
    const expected = delegateFirstSentences[name]
    assert.ok(completeParagraph(definition.description).length > SHORT_PARAGRAPH_LIMIT)
    assert.ok(expected.length <= SENTENCE_LIMIT)
    assert.ok(normalize(definition.description).startsWith(expected), 'the oracle is literal external source text')
    const { cues } = render([definition])
    assert.deepEqual(entries(cues).map(entry => [entry.name, entry.purpose]), [[name, expected]])
    assert.doesNotMatch(cues.text, /automatically delivers|completion notice|Omit `provider`|send_message/i)
    bounded(cues)
  })
  test(`generic ${name}: an unrelated later paragraph does not withdraw the unchanged literal purpose`, OPTIONS, () => {
    const definition = core.find(row => row.name === name)
    const changed = { ...definition, description: definition.description + '\n\nLater-only searchable capability lateronlycapability421.' }
    assert.equal(completeParagraph(changed.description), completeParagraph(definition.description))
    const before = render([definition]).cues
    const after = render([changed]).cues
    assert.deepEqual(entries(after), entries(before), 'a later paragraph is not an identity gate')
    assert.equal(entries(after)[0].purpose, delegateFirstSentences[name])
    assert.equal(searchCatalog(buildCatalog([changed], true), 'lateronlycapability421', 10, true)[0].description, changed.description)
    bounded(before)
    bounded(after)
  })
}

test('tool identity is not a purpose gate: an arbitrary name with the same full description retains the same literal sentence', OPTIONS, () => {
  const original = core.find(row => row.name === 'subagent')
  const renamed = { ...original, name: 'opaque_reused_description' }
  const before = entries(render([original]).cues)
  const after = entries(render([renamed]).cues)
  assert.deepEqual(before.map(entry => entry.purpose), [delegateFirstSentences.subagent])
  assert.deepEqual(after.map(entry => entry.purpose), before.map(entry => entry.purpose))
  assert.equal(after[0].name, renamed.name)
})

test('equal current descriptions do not gain privileged budget selection from a familiar tool name', OPTIONS, () => {
  const actual = core.find(row => row.name === 'read')
  const earlier = Array.from({ length: 12 }, (_, n) => row(`aaa_metadata_${n}`, actual.description))
  const before = render([...earlier, actual]).cues
  const after = render([...earlier, { ...actual, name: 'rend' }]).cues
  bounded(before)
  bounded(after)
  const shown = entries(before)
  assert.ok(shown.length > 0 && shown.length < earlier.length, 'finite budget selects whole entries from the scoped order')
  assert.deepEqual(shown.map(entry => entry.name === 'read' ? 'rend' : entry.name), entries(after).map(entry => entry.name), 'removing audited-name privilege must make this equal-length rename neutral')
  for (const entry of shown) assert.equal(entry.purpose, actual.description)
})

test('any 160-character paragraph is preserved whole, while 161 without a real sentence terminator is omitted not truncated', OPTIONS, () => {
  const fitting = 'F'.repeat(SHORT_PARAGRAPH_LIMIT)
  const long = 'L'.repeat(SHORT_PARAGRAPH_LIMIT + 1)
  const { cues, catalog } = render([row('unknown_fits', fitting), row('unknown_too_long', long)])
  bounded(cues)
  assert.deepEqual(entries(cues).map(entry => [entry.name, entry.purpose]), [['unknown_fits', fitting]])
  assert.equal(catalog.get('unknown_too_long').description, long, 'hint omission must not alter the complete definition')
})

test('unknown fallback never turns a long paragraph into a short prefix', OPTIONS, () => {
  const description = 'OVERLONG_START_422 ' + 'meaningful-clause '.repeat(30) + 'OVERLONG_END_422'
  const { cues } = render([row('unknown_long', description)])
  assert.deepEqual(cues, { text: '', count: 0, chars: 0 })
  assert.doesNotMatch(cues.text, /OVERLONG_START_422|OVERLONG_END_422|…/)
})

test('changed same-name short definition uses its actual short purpose, never the captured core meaning', OPTIONS, () => {
  const description = 'CURRENT_IMAGE_PURPOSE_423: adjust one pixel in a remote image.\n\nNew image parameters.'
  const actual = row('edit', description)
  assert.notEqual(actual.description, core.find(row => row.name === 'edit').description)
  const { cues } = render([actual])
  assert.deepEqual(entries(cues).map(entry => entry.purpose), [completeParagraph(description)])
  assert.doesNotMatch(cues.text, /existing UTF-8 text file|局部替换文件/)
})

test('whole-entry budget includes escaped literal output and keeps actual short paragraphs intact', OPTIONS, () => {
  const rows = Array.from({ length: 20 }, (_, index) => row(`unknown_literal_${index}`, `Read fixture ${index} with \\ "quoted" {{literal}} $USD $$ content. ` + 'detail '.repeat(9)))
  assert.ok(rows.every(definition => completeParagraph(definition.description).length <= SHORT_PARAGRAPH_LIMIT))
  const { cues, catalog } = render(rows)
  bounded(cues)
  const shown = entries(cues)
  assert.ok(shown.length > 0 && shown.length < rows.length, 'there must be actual whole-entry selection under the finite section budget')
  for (const entry of shown) assert.equal(entry.purpose, completeParagraph(catalog.get(entry.name).description))
  assert.equal(catalog.size, rows.length)
})

test('actual nonempty MCP instructions suppress all duplicate cue entries from that owner', OPTIONS, () => {
  const rows = [row('mcp__known__q0', 'Read an actual fixture proof.', 'known'), row('mcp__known__q1', 'Inspect an actual fixture state.', 'known')]
  const instructions = ' \r\nAlready-present publisher instructions: read or inspect this fixture. {{literal}}\n '
  const seen = []
  const { cues, catalog } = render(rows, owner => { seen.push(owner); return instructions })
  assert.deepEqual(cues, { text: '', count: 0, chars: 0 })
  assert.ok(seen.includes('known'), 'the supplied instructionsOf reader, not owner-name guessing, is consulted')
  assert.equal(catalog.size, rows.length)
})

test('missing MCP instructions allow one short example per owner and at most three globally', OPTIONS, () => {
  const rows = ['north', 'south', 'east', 'west'].flatMap(owner => [row(`mcp__${owner}__q0`, `Read current ${owner} proof.`, owner), row(`mcp__${owner}__q1`, `Read current ${owner} state.`, owner)])
  const { cues } = render(rows, () => ' \r\n\t ')
  bounded(cues)
  const shown = entries(cues)
  assert.equal(shown.length, 3, 'global example allowance is three when three complete small examples fit')
  for (const owner of ['north', 'south', 'east', 'west']) assert.ok(shown.filter(entry => entry.name.startsWith(`mcp__${owner}__`)).length <= 1)
  assert.match(cues.text, /examples?|non[- ]?exhaustive|not exhaustive/i)
})

test('skipped MCP examples and overlong definitions remain discoverable by the real full-text index', OPTIONS, () => {
  const rows = Array.from({ length: 4 }, (_, index) => row(`mcp__rare__q${index}`, `Read proof ${index}.\n\nSearchable private capability rareword${index}.`, 'rare'))
  const { cues } = render(rows)
  const shown = entries(cues)
  assert.equal(shown.length, 1)
  const unshown = rows.find(definition => !shown.some(entry => entry.name === definition.name))
  assert.ok(unshown)
  const catalog = buildCatalog(rows, true)
  const result = searchCatalog(catalog, `rareword${unshown.name.slice(-1)}`, 10, true)
  assert.ok(result.some(match => match.name === unshown.name), 'search sees the original complete second paragraph, not the sparse cue')
  const overlong = row('opaque_long_searchable', 'Long setup '.repeat(30) + '\n\nFind speciallongcapability.', undefined)
  const longCue = render([overlong]).cues
  assert.equal(longCue.text, '')
  assert.ok(searchCatalog(buildCatalog([overlong], true), 'speciallongcapability', 10, true).some(match => match.name === overlong.name))
})

test('empty actual descriptions produce neither invented purposes nor an empty directive-only section', OPTIONS, () => {
  const { cues } = render([row('unknown_empty', ' \r\n\r\n\t ')])
  assert.deepEqual(cues, { text: '', count: 0, chars: 0 })
  assert.equal(descriptionParagraph(''), '')
})
