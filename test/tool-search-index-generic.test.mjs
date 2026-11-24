import { test } from 'node:test'
import assert from 'node:assert/strict'
import { applyStem, buildCatalog, parseQuery, searchCatalog, tokenize, toolNameVariants } from '../lib/tool-search-index.js'

const names = (matches) => matches.map(({ name }) => name)

// Deliberately invented inventory: none of these names depend on a known MCP server/domain.
test('generic tokens: retain original identifiers while splitting camel and acronym boundaries', { timeout: 60000 }, () => {
  assert.deepEqual(tokenize('QZRelayProbe'), ['qzrelayprobe', 'qz', 'relay', 'probe'])
  assert.deepEqual(tokenize('captureXQFrames'), ['capturexqframes', 'capture', 'xq', 'frames'])
  assert.deepEqual(tokenize('fluxSlot_id'), ['fluxslot', 'flux', 'slot', 'id'])
  assert.deepEqual(parseQuery('QZRelayProbe').terms, tokenize('QZRelayProbe'))
  const catalog = buildCatalog([{ name: 'mcp__vexoria__QZRelayProbe', parameters: null }])
  assert.deepEqual(names(searchCatalog(catalog, 'relay probe')), [...catalog.keys()])
  assert.equal(searchCatalog(catalog, 'QZRelayProbe')[0].score, Infinity)
  assert.deepEqual(searchCatalog(catalog, 'select:qz_relay_probe'), [{ name: 'qz_relay_probe', found: false }])
})

test('generic tokens: accented Latin, Cyrillic and Greek remain searchable without translation', { timeout: 60000 }, () => {
  assert.deepEqual(tokenize('Énergie Δοκιμή ПОИСК'), ['énergie', 'δοκιμή', 'поиск'])
  const catalog = buildCatalog([
    { name: 'mcp__veluna__a', description: 'Énergie électrique' },
    { name: 'mcp__veluna__b', description: 'Поиск записей' },
    { name: 'mcp__veluna__c', description: 'Δοκιμή σήματος' },
  ])
  for (const [query, name] of [['ÉNERGIE', 'a'], ['ПОИСК', 'b'], ['ΔΟΚΙΜΉ', 'c']]) {
    assert.deepEqual(names(searchCatalog(catalog, query)), [`mcp__veluna__${name}`])
  }
  assert.deepEqual(searchCatalog(catalog, 'search records'), [], 'no guessed translation or synonym expansion')
})

test('generic tokens: existing CJK and mixed-language bigrams remain unchanged', { timeout: 60000 }, () => {
  assert.deepEqual(tokenize('查询 データ 한글'), ['查询', 'デー', 'ータ', '한글'])
  const catalog = buildCatalog([{ name: 'mcp__veluna__d', description: '查询データ 한글' }])
  for (const query of ['查询', 'データ', '한글']) assert.equal(searchCatalog(catalog, query)[0].name, 'mcp__veluna__d')
})

// The original select resolver is deliberately not a fuzzy identifier parser.
test('generic select: preserve ambiguous real bare names, joined aliases and explicit misses', { timeout: 60000 }, () => {
  const catalog = buildCatalog([
    { name: 'mcp__veluna__QZRelayProbe' },
    { name: 'mcp__torvex__QZRelayProbe' },
  ])
  assert.deepEqual(names(searchCatalog(catalog, 'select:QZRelayProbe')), [...catalog.keys()])
  assert.deepEqual(names(searchCatalog(catalog, 'select:veluna.QZRelayProbe')), ['mcp__veluna__QZRelayProbe'])
  for (const requested of ['relayProbe', 'QZRelay', 'veluna_QZRelayProbe']) {
    assert.deepEqual(searchCatalog(catalog, `select:${requested}`), [{ name: requested, found: false }])
  }
})

test('generic schema: exclude structural plumbing but retain property names and annotations', { timeout: 60000 }, () => {
  const parameters = {
    type: 'object', additionalProperties: false, required: ['payload'],
    properties: { payload: { type: 'string', title: 'FluxVector', description: 'quartz resonance', enum: ['vexPhase'], const: 'tovexPulse' } },
  }
  const catalog = buildCatalog([{ name: 'mcp__lurevia__a', parameters }])
  for (const query of ['properties', 'string', 'object', 'additionalProperties', 'required', 'enum', 'const']) {
    assert.deepEqual(searchCatalog(catalog, query), [], `schema keyword ${query} is not tool meaning`)
  }
  for (const query of ['payload', 'flux vector', 'quartz resonance', 'vex phase', 'tovex pulse']) {
    assert.deepEqual(names(searchCatalog(catalog, query)), [...catalog.keys()])
  }
  const propertyNamedType = buildCatalog([{ name: 'mcp__lurevia__b', parameters: { properties: { type: {} } } }])
  assert.equal(searchCatalog(propertyNamedType, 'type')[0].name, 'mcp__lurevia__b', 'property spelling is meaningful even when equal to a schema keyword')
})

test('generic schema: named schema containers never interpret definition names as annotations', { timeout: 60000 }, () => {
  const catalog = buildCatalog([{ name: 'mcp__lurevia__d', parameters: {
    $defs: { const: { type: 'object', properties: { ordinal: { type: 'number', description: 'sundial' } } } },
    definitions: { title: { type: 'string', description: 'meridian' } },
    dependentSchemas: { enum: { type: 'object', properties: { declination: { type: 'string' } } } },
  } }])
  for (const query of ['type', 'object', 'string', 'number', 'properties', 'const', 'title', 'enum']) {
    assert.deepEqual(searchCatalog(catalog, query), [], query)
  }
  for (const query of ['ordinal', 'sundial', 'meridian', 'declination']) {
    assert.deepEqual(names(searchCatalog(catalog, query)), [...catalog.keys()])
  }
})

test('generic schema: nested definitions, refs, items and combinators are returned intact', { timeout: 60000 }, () => {
  const parameters = {
    $schema: 'https://json-schema.org/draft/2020-12/schema',
    $defs: { Node: { title: 'luminous', properties: { phasePort: { description: 'resonator' } } } },
    definitions: { old: { description: 'prismatic' } },
    type: 'object',
    properties: {
      bundle: { type: 'array', items: { $ref: '#/$defs/Node' }, prefixItems: [{ description: 'aperture' }] },
      dispatch: { oneOf: [{ const: 'oscillation' }, { anyOf: [{ description: 'fulcrum' }, { allOf: [{ title: 'tessellation' }] }] }] },
      mode: { enum: ['aether'], default: 'solstice', examples: ['equinox'] },
    },
    if: { properties: { enabled: { const: true } } }, then: { description: 'umbra' }, else: { description: 'penumbra' },
    not: { description: 'excludedphase' }, unevaluatedProperties: false,
  }
  const before = structuredClone(parameters)
  const catalog = buildCatalog([{ name: 'mcp__lurevia__c', parameters }])
  for (const query of ['luminous', 'phase port', 'prismatic', 'aperture', 'oscillation', 'fulcrum', 'tessellation', 'aether', 'solstice', 'equinox', 'umbra', 'penumbra', 'excludedphase']) {
    const matches = searchCatalog(catalog, query)
    assert.deepEqual(names(matches), [...catalog.keys()], query)
    assert.strictEqual(matches[0].parameters, parameters)
    assert.deepEqual(matches[0].parameters, before)
  }
  assert.strictEqual(searchCatalog(catalog, 'select:c')[0].parameters, parameters)
  assert.deepEqual(parameters, before, 'indexing and retrieval never alter schema')
})

test('generic ownership: +server uses real owners rather than tool-name tokens', { timeout: 60000 }, () => {
  const catalog = buildCatalog([
    { name: 'mcp__vexora__relay', description: 'route a signal' },
    { name: 'mcp__other__vexora_relay', description: 'route a signal' },
    { name: 'opaqueRelay', description: 'route a signal' },
    { name: 'unattributedRelay', description: 'route a signal' },
  ])
  const ownerOf = new Map([
    ['mcp__vexora__relay', 'torvex'],
    ['mcp__other__vexora_relay', 'lurevia'],
    ['opaqueRelay', 'vexora'],
  ])
  assert.deepEqual(names(searchCatalog(catalog, '+vexora signal', 10, false, { ownerOf })), ['opaqueRelay'])
  assert.deepEqual(names(searchCatalog(catalog, '+torvex', 10, false, { ownerOf })), ['mcp__vexora__relay'])
  assert.deepEqual(searchCatalog(catalog, '+missing signal', 10, false, { ownerOf }), [])
  assert.deepEqual(searchCatalog(catalog, '+torvex nonexisting', 10, false, { ownerOf }), [], 'a filtered miss never falls back to another server')
  assert.deepEqual(searchCatalog(catalog, '+vexora', 10, false, { ownerOf: new Map() }), [], 'an explicit empty map is authoritative')
  assert.deepEqual(names(searchCatalog(catalog, '+vexora signal', 10)).sort(), ['mcp__other__vexora_relay', 'mcp__vexora__relay'], 'without ownership metadata, retain the old name-token constraint')
})

test('generic ownership: exact server identity preserves punctuation, camel case and singular distinction', { timeout: 60000 }, () => {
  const catalog = buildCatalog([{ name: 'OpaqueA' }, { name: 'OpaqueB' }], true)
  const ownerOf = new Map([['OpaqueA', 'QZ-tools_x'], ['OpaqueB', 'QZ-tool_x']])
  assert.deepEqual(names(searchCatalog(catalog, '+QZ-tools_x', 5, true, { ownerOf })), ['OpaqueA'])
  assert.deepEqual(names(searchCatalog(catalog, '+QZ-tool_x', 5, true, { ownerOf })), ['OpaqueB'])
  assert.deepEqual(searchCatalog(catalog, '+qz-tools_x', 5, true, { ownerOf }), [], 'server IDs are not stemmed or guessed')
  ownerOf.set('OpaqueB', 'QZ-tools_x')
  assert.deepEqual(names(searchCatalog(catalog, '+QZ-tools_x', 5, true, { ownerOf })), ['OpaqueA', 'OpaqueB'], 'owner metadata is supplied fresh per search')
})

test('generic ownership: reject invalid ownership metadata instead of silently weakening a filter', { timeout: 60000 }, () => {
  const catalog = buildCatalog([{ name: 'mcp__vexora__relay' }])
  assert.throws(() => searchCatalog(catalog, '+vexora', 5, false, { ownerOf: {} }), TypeError)
})

test('generic empty/error: tokenless keywords and malformed filters do not enumerate inventory', { timeout: 60000 }, () => {
  const catalog = buildCatalog([{ name: 'mcp__vexora__relay' }])
  for (const query of [undefined, null, '', '   ', '!!!', '+', '+   ', '+!!!']) {
    assert.deepEqual(searchCatalog(catalog, query), [], String(query))
  }
  assert.deepEqual(searchCatalog(catalog, 'select: , '), [])
})

test('generic empty/error: select misses are explicit even when the inventory is empty', { timeout: 60000 }, () => {
  assert.deepEqual(searchCatalog(buildCatalog([]), 'select:missingQZ,anotherQZ,missingQZ'), [
    { name: 'missingQZ', found: false }, { name: 'anotherQZ', found: false },
  ])
})

// Independent, uncached copy of the pre-optimization BM25 contract. It consumes the
// production token stream, so these tests compare optimization only, not token policy.
function referenceRanking(catalog, query, stem = false, ownerOf) {
  const parsed = parseQuery(query)
  const documents = [...catalog.values()]
  const averageLength = documents.reduce((sum, doc) => sum + doc.documentTokens.length, 0) / documents.length
  const df = new Map()
  for (const doc of documents) for (const term of new Set(doc.documentTokens)) df.set(term, (df.get(term) ?? 0) + 1)
  const scores = []
  for (const doc of documents) {
    if (parsed.kind === 'filter') {
      if (ownerOf !== undefined ? ownerOf.get(doc.name) !== parsed.requiredServer
        : !applyStem(parsed.requiredTokens, stem).every((term) => doc.nameTokens.has(term))) continue
    }
    if (toolNameVariants(doc.name).some((name) => name.toLowerCase() === parsed.raw.toLowerCase())) {
      scores.push({ name: doc.name, score: Infinity })
      continue
    }
    const terms = applyStem(parsed.terms, stem)
    if (terms.length === 0) {
      scores.push({ name: doc.name, score: 0 })
      continue
    }
    const tf = new Map()
    for (const term of doc.documentTokens) tf.set(term, (tf.get(term) ?? 0) + 1)
    let score = 0
    let nameHit = false
    for (const term of terms) {
      const count = tf.get(term) ?? 0
      if (count === 0) continue
      const frequency = df.get(term) ?? 0
      const idf = Math.log(1 + (documents.length - frequency + 0.5) / (frequency + 0.5))
      const norm = count * 2.2 / (count + 1.2 * (0.25 + 0.75 * doc.documentTokens.length / averageLength))
      score += idf * norm
      if (doc.nameTokens.has(term) || toolNameVariants(doc.name).includes(term)) nameHit = true
    }
    if (nameHit) score += 12
    if (score > 0) scores.push({ name: doc.name, score })
  }
  return scores.sort((a, b) => b.score - a.score || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
}

const syntheticInventory = (size) => Array.from({ length: size }, (_, index) => ({
  name: `mcp__vex${index % 5}__probe${index}QZRelay`,
  description: `Signal ${'phase '.repeat(index % 7)}relay ${index % 2 ? 'fluxes' : 'tessellation'} 查询`,
  parameters: { properties: { portId: { title: 'ordinal', enum: [`state${index % 3}`] } } },
}))

test('generic lifecycle: repeated queries never reread document token streams', { timeout: 60000 }, () => {
  const catalog = buildCatalog(syntheticInventory(20))
  let tokenReads = 0
  for (const doc of catalog.values()) {
    const tokens = doc.documentTokens
    Object.defineProperty(doc, 'documentTokens', { get() { tokenReads++; return tokens } })
  }
  for (const query of ['relay signal', 'phase phase', '+vex2 fluxes', '+vex1', '查询']) {
    assert.ok(searchCatalog(catalog, query, 20).length > 0)
  }
  assert.equal(tokenReads, 0, 'TF/DF/length must be prepared with the catalog, not per query')
})

test('generic lifecycle: cached scores and ordering equal uncached BM25 on identical tokens', { timeout: 60000 }, () => {
  for (const stem of [false, true]) {
    const catalog = buildCatalog(syntheticInventory(35), stem)
    const ownerOf = new Map([...catalog.keys()].map((name, index) => [name, `actual${index % 3}`]))
    const queries = ['relay signal', 'phase phase fluxes', 'port id ordinal', 'state1', '查询', '+vex2 fluxes', '+vex1', 'probe7QZRelay', 'mcp__vex2__probe7QZRelay']
    for (const query of queries) {
      const actual = searchCatalog(catalog, query, 100, stem).map(({ name, score }) => ({ name, score }))
      assert.deepEqual(actual, referenceRanking(catalog, query, stem), `${stem}: ${query}`)
    }
    for (const query of ['+actual1 phase', '+actual2']) {
      const actual = searchCatalog(catalog, query, 100, stem, { ownerOf }).map(({ name, score }) => ({ name, score }))
      assert.deepEqual(actual, referenceRanking(catalog, query, stem, ownerOf), `${stem}: ${query}`)
    }
  }
})

test('generic lifecycle: rebuilding after duplicate replacement excludes old term statistics', { timeout: 60000 }, () => {
  const initial = buildCatalog([{ name: 'mcp__vexora__a', description: 'oldphase oldphase' }])
  const replacement = buildCatalog([
    { name: 'mcp__vexora__a', description: 'oldphase oldphase' },
    { name: 'mcp__vexora__a', description: 'newphase' },
    { name: 'mcp__vexora__b', description: 'newphase' },
  ])
  assert.equal(searchCatalog(initial, 'oldphase').length, 1)
  assert.deepEqual(searchCatalog(replacement, 'oldphase'), [])
  assert.deepEqual(searchCatalog(replacement, 'newphase').map(({ name, score }) => ({ name, score })), referenceRanking(replacement, 'newphase'))
})

// Existing lexical ranking rules: ambiguity is returned, never resolved by server preference.
test('generic ranking: equal descriptions retain code-unit tie-breaking', { timeout: 60000 }, () => {
  const catalog = buildCatalog([
    { name: 'mcp__tovex__b', description: 'signal relay' },
    { name: 'mcp__tovex__A', description: 'signal relay' },
  ])
  const matches = searchCatalog(catalog, 'signal')
  assert.deepEqual(names(matches), ['mcp__tovex__A', 'mcp__tovex__b'])
  assert.equal(matches[0].score, matches[1].score)
})
