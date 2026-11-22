// User's generic contract: only current source text decides a purpose, never names, owners or reviewed hashes.
// Sentence fixtures below are externally given complete source sentences, not implementation-produced summaries.
import assert from 'node:assert/strict'
import test from 'node:test'
import { capabilityCues } from '../lib/tool-discovery-cues.js'
import { buildCatalog, searchCatalog } from '../lib/tool-search-index.js'
import { groupCatalogByOwner } from '../lib/tool-search-runtime.js'

const OPTIONS = { timeout: 60_000 }
const TAIL = ' Additional execution lifecycle information remains available in the full calling definition.'
const normalize = value => value.replace(/\s+/g, ' ').trim()
const row = (name, description, owner) => ({
  name, description, owner,
  parameters: {
    type: 'object',
    properties: { fixture_value: { type: 'string', description: `Full input contract for ${name}.` } },
    required: ['fixture_value'], additionalProperties: false,
  },
})
const longDescription = first => first + TAIL.repeat(8) + '\n\nLater-only searchable metadata genericsecondparagraph.'

function decode(cues) {
  return cues.text.split('\n').filter(line => line.startsWith('- ')).map(line => {
    const match = /^- ("(?:\\.|[^"\\])*") — ("(?:\\.|[^"\\])*")$/.exec(line)
    assert.ok(match, '800-character selection must preserve whole escaped name/purpose entries')
    return { name: JSON.parse(match[1]), purpose: JSON.parse(match[2]) }
  })
}
function render(rows, instructionsOf = () => '') {
  const catalog = buildCatalog(rows, true)
  const ownerOf = new Map(rows.filter(definition => definition.owner !== undefined).map(definition => [definition.name, definition.owner]))
  const grouped = groupCatalogByOwner(catalog, ownerOf)
  const before = JSON.stringify({ rows, catalog: [...catalog], grouped })
  const cues = capabilityCues(catalog, grouped, instructionsOf)
  const shown = decode(cues)
  assert.ok(cues.text.length <= 800, 'the whole cue, including headers and escaping, must fit 800 characters')
  assert.equal(cues.chars, cues.text.length)
  assert.equal(cues.count, shown.length)
  assert.equal(JSON.stringify({ rows, catalog: [...catalog], grouped }), before, 'rendering is not registration, loading or index mutation')
  for (const entry of shown) assert.ok(catalog.has(entry.name), 'no name-derived or invented capability may be introduced')
  return { cues, shown, catalog }
}

const SENTENCES = [
  { label: 'English period', first: 'Inspect the current ledger.' },
  { label: 'English question', first: 'Can the source return the current receipt?' },
  { label: 'English exclamation', first: 'Read the current ledger!' },
  { label: 'Chinese full stop', first: '读取当前账目。' },
  { label: 'Japanese full stop', first: '現在の台帳を読み取ります。' },
  { label: 'English abbreviations', first: 'Transfer U.S. dollar entries (e.g. pending items) to the queue.' },
  { label: 'decimal and parenthetical abbreviation', first: 'Read entries (e.g. queued entries) for v1.2.' },
  { label: 'closing ASCII quote', first: '"Read the current ledger."' },
  { label: 'closing Chinese quote', first: '「读取当前账目。」' },
  { label: 'closing Japanese quote', first: '「現在の台帳を読み取ります。」' },
  { label: 'full-width terminal mark', first: '現在の明細を確認します！' },
]
for (const [index, fixture] of SENTENCES.entries()) {
  test(`generic long source ${fixture.label}: quote the complete first sentence for an unseen name`, OPTIONS, () => {
    const description = longDescription(fixture.first)
    assert.ok(description.split('\n\n')[0].length > 160)
    assert.ok(fixture.first.length <= 240)
    // Standard-library fixture grammar check only; the oracle remains the explicit literal above.
    assert.equal([...new Intl.Segmenter('und', { granularity: 'sentence' }).segment(description)][0].segment.trim(), fixture.first)
    const { shown, catalog } = render([row(`unseen_literal_${index}`, description)])
    assert.deepEqual(shown, [{ name: `unseen_literal_${index}`, purpose: fixture.first }])
    assert.equal(catalog.get(`unseen_literal_${index}`).description, description)
  })
}

test('short first paragraphs are quoted whole even when they contain several complete sentences', OPTIONS, () => {
  const first = 'Inspect the ledger. Return the current receipt.'
  const { shown } = render([row('opaque_multiple_short_sentences', first + '\n\n' + TAIL.repeat(8))])
  assert.ok(first.length <= 160)
  assert.deepEqual(shown.map(entry => entry.purpose), [first], 'the short-paragraph rule precedes sentence fallback')
})

test('an arbitrary tool rename with the same long description retains the same actual purpose in a small inventory', OPTIONS, () => {
  const first = 'Inspect the current external receipt.'
  const description = longDescription(first)
  for (const name of ['read', 'subagent', 'edit', 'opaque_task', 'prefix__unknown__op', '任意工具']) {
    const { shown } = render([row(name, description)])
    assert.deepEqual(shown, [{ name, purpose: first }], 'neither a familiar name nor an unknown alias changes source quotation')
  }
})

test('whole owner and tool renaming preserves the source purposes without binding a service inventory', OPTIONS, () => {
  const first = 'Read the current external receipt.'
  const description = longDescription(first)
  const old = ['opaque_ax', 'source_by'].map(owner => row(`mcp__${owner}__packet`, description, owner))
  const renamed = ['tenant_z0', 'tenant_z1'].map(owner => row(`mcp__${owner}__action`, description, owner))
  const before = render(old).shown
  const after = render(renamed).shown
  assert.equal(before.length, 2, 'both small source entries fit before the rename')
  assert.equal(after.length, 2, 'both small source entries fit after the rename')
  assert.deepEqual(before.map(entry => entry.purpose), [first, first])
  assert.deepEqual(after.map(entry => entry.purpose), before.map(entry => entry.purpose))
  assert.deepEqual(after.map(entry => entry.name).sort(), renamed.map(definition => definition.name).sort())
})

test('a different inventory order does not change any literal purpose when all small entries fit', OPTIONS, () => {
  const rows = ['gamma', 'alpha', 'beta'].map((name, index) => row(name, longDescription(`Inspect external source number ${index}.`)))
  const before = render(rows).shown
  const after = render([...rows].reverse()).shown
  assert.equal(before.length, rows.length)
  assert.equal(after.length, rows.length)
  assert.deepEqual(new Map(before.map(entry => [entry.name, entry.purpose])), new Map(after.map(entry => [entry.name, entry.purpose])))
})

test('appending or rewriting an unrelated later paragraph does not withdraw the unchanged source sentence', OPTIONS, () => {
  const first = 'Inspect current source metadata.'
  const actual = row('opaque_later_update', longDescription(first))
  const changed = { ...actual, description: actual.description + '\n\nCompletely new indexed capability changedparagraphword.' }
  const before = render([actual]).shown
  const after = render([changed]).shown
  assert.deepEqual(before, [{ name: actual.name, purpose: first }])
  assert.deepEqual(after, before)
  assert.equal(searchCatalog(buildCatalog([changed], true), 'changedparagraphword', 10, true)[0].description, changed.description)
})

test('changing the current first sentence updates the actual purpose rather than preserving an old meaning', OPTIONS, () => {
  const beforeFirst = 'Read the current external receipt.'
  const afterFirst = 'Send the current external receipt.'
  const name = 'same_actual_name'
  const before = render([row(name, longDescription(beforeFirst))]).shown
  const after = render([row(name, longDescription(afterFirst))]).shown
  assert.deepEqual(before, [{ name, purpose: beforeFirst }])
  assert.deepEqual(after, [{ name, purpose: afterFirst }])
  assert.equal(beforeFirst.length, afterFirst.length, 'equal-length meaning changes must still take effect')
})

for (const length of [161, 240, 241]) {
  test(`first complete sentence of ${length} characters: the 240 limit selects or omits the entire sentence`, OPTIONS, () => {
    const first = 'S'.repeat(length - 1) + '.'
    const description = longDescription(first)
    const actual = row(`opaque_sentence_${length}`, description)
    const { shown, catalog } = render([actual])
    assert.deepEqual(shown, length <= 240 ? [{ name: actual.name, purpose: first }] : [])
    assert.equal(catalog.get(actual.name).description, description)
    assert.ok(searchCatalog(catalog, 'genericsecondparagraph', 10, true).some(match => match.name === actual.name))
  })
}

test('a 160-character short paragraph needs no sentence marker and is never shortened to a prefix', OPTIONS, () => {
  const first = 'P'.repeat(160)
  const { shown } = render([row('opaque_short_160', first)])
  assert.deepEqual(shown, [{ name: 'opaque_short_160', purpose: first }])
})

test('a long unfinished first paragraph is not promoted to a complete sentence just because input ended', OPTIONS, () => {
  const unfinished = 'Read current metadata ' + 'detail '.repeat(24) + 'without a terminator'
  assert.ok(unfinished.length > 160 && unfinished.length <= 240)
  const { shown } = render([row('opaque_incomplete', unfinished)])
  assert.deepEqual(shown, [], 'Intl end-of-input alone is not a real sentence terminator')
})

test('an overlong first sentence cannot be replaced by a later short sentence or a character prefix', OPTIONS, () => {
  const first = 'Inspect ' + 'complete-details '.repeat(20) + 'before proceeding.'
  assert.ok(first.length > 240)
  const actual = row('opaque_no_later_pick', first + ' Read a concise second sentence.\n\nFull indexed capability nofirstsentenceword.')
  const { cues, shown, catalog } = render([actual])
  assert.deepEqual(shown, [])
  assert.equal(cues.text, '')
  assert.ok(searchCatalog(catalog, 'nofirstsentenceword', 10, true).some(match => match.name === actual.name))
})

test('decimal points and abbreviation punctuation do not invent a terminal boundary in unfinished metadata', OPTIONS, () => {
  const first = 'Read v1.2 resources, e.g. current entries ' + 'detail '.repeat(20) + 'without a final marker'
  assert.ok(first.length > 160 && first.length <= 240)
  assert.deepEqual(render([row('opaque_decimal_fragment', first)]).shown, [])
})

test('the first nonempty paragraph is selected before CRLF and display-whitespace normalization', OPTIONS, () => {
  const rawFirst = 'Read current\r\n  receipt metadata. Preserve every short clause.'
  const description = '\r\n\r\n \t\r\n\r\n' + rawFirst + '\r\n\r\n' + TAIL.repeat(8)
  assert.ok(normalize(rawFirst).length <= 160)
  assert.deepEqual(render([row('opaque_leading_blank', description)]).shown, [{ name: 'opaque_leading_blank', purpose: normalize(rawFirst) }])
})

test('arbitrary MCP owners retain presence-based instruction deduplication and owner/global example limits for long sources', OPTIONS, () => {
  const first = 'Read current external metadata.'
  const owners = ['publisher_0', 'publisher_1', 'publisher_2', 'publisher_3']
  const rows = owners.flatMap(owner => Array.from({ length: 4 }, (_, index) => row(`mcp__${owner}__p${index}`, longDescription(first), owner)))
  const seen = []
  const { shown, catalog } = render(rows, owner => {
    seen.push(owner)
    return owner === owners[0] ? ' \r\nActual publisher instructions already present. ' : ' \r\n\t '
  })
  assert.ok(seen.includes(owners[0]))
  assert.equal(shown.length, 3, 'three complete examples fit after the already-described owner is suppressed')
  assert.ok(shown.every(entry => entry.purpose === first))
  assert.ok(!shown.some(entry => entry.name.startsWith(`mcp__${owners[0]}__`)))
  for (const owner of owners) assert.ok(shown.filter(entry => entry.name.startsWith(`mcp__${owner}__`)).length <= 1)
  assert.equal(catalog.size, rows.length)
})

for (const size of [1, 30, 300]) {
  test(`generic inventory scale ${size}: bounded cues do not delete any current catalog, full-text index or parameter schema`, OPTIONS, () => {
    const first = 'Inspect the current resource.'
    const rows = Array.from({ length: size }, (_, index) => {
      const name = `opaque_resource_${String(index).padStart(3, '0')}`
      const word = `indexedcapability${String(index).padStart(6, '0')}`
      return { ...row(name, first + TAIL.repeat(8) + `\n\nFull private indexed capability ${word}.`), word }
    })
    const { shown, catalog } = render(rows)
    assert.equal(catalog.size, size)
    assert.ok(shown.length > 0)
    if (size === 1) assert.equal(shown.length, 1)
    else assert.ok(shown.length < size, 'finite cue budget must omit whole examples, not definitions')
    assert.ok(shown.every(entry => entry.purpose === first))
    for (const actual of rows) {
      const indexed = catalog.get(actual.name)
      assert.equal(indexed.description, actual.description)
      assert.deepEqual(indexed.parameters, actual.parameters)
      const found = searchCatalog(catalog, actual.word, 10, true).find(match => match.name === actual.name)
      assert.ok(found, 'every original second-paragraph capability remains discoverable even when its cue was omitted')
      assert.equal(found.description, actual.description)
      assert.deepEqual(found.parameters, actual.parameters)
    }
  })
}

test('a same-name image override and an unknown alias both quote the actual current long image description', OPTIONS, () => {
  const first = 'Replace one pixel in the current demonstration image.'
  const description = longDescription(first)
  for (const name of ['edit', 'unknown_image_action']) {
    const { cues, shown } = render([row(name, description)])
    assert.deepEqual(shown, [{ name, purpose: first }])
    assert.doesNotMatch(cues.text, /existing UTF-8 text file|literal text|source-bound purpose/i)
  }
})

test('whole-entry budget counts escaped long-sentence output while preserving all literal source characters', OPTIONS, () => {
  const first = 'Inspect a \\ "quoted" record with {{unbound}} ${USD} $$ 中文🚀.'
  const rows = Array.from({ length: 30 }, (_, index) => row(`opaque_literal_${index}`, longDescription(first)))
  const { shown, catalog } = render(rows)
  assert.ok(shown.length > 0 && shown.length < rows.length)
  assert.ok(shown.every(entry => entry.purpose === first))
  assert.equal(catalog.size, rows.length)
})

test('missing source text does not gain a purpose from a suggestive tool or owner name', OPTIONS, () => {
  const rows = [row('read', ''), row('send_file', ' \r\n\t '), row('mcp__image_editor__edit', '', 'image_editor')]
  const { cues, shown, catalog } = render(rows)
  assert.deepEqual(cues, { text: '', count: 0, chars: 0 })
  assert.deepEqual(shown, [])
  assert.equal(catalog.size, rows.length)
})
