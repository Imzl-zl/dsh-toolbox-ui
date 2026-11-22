// Black-box capability cues: real Context / Tools / executors / step toolSet.
// Only the fixture's external definitions and in-memory persistence are substituted.
// Never import a proposed cue helper or hard-code its complete rendered wording.
import assert from 'node:assert/strict'
import test from 'node:test'
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import { createScope } from '@deepseek-ai/dsh-scope'
import Tools from '@deepseek-ai/dsh-tools'
import { installToolSearchRuntime, instructionFingerprint } from '../lib/tool-search-runtime.js'
import { resolveToolLoadingPolicy } from '../lib/tool-loading-policy.js'

const require = createRequire(import.meta.url)
const toolsRequire = createRequire(require.resolve('@deepseek-ai/dsh-tools'))
const importHost = async (name) => import(pathToFileURL(require.resolve(name)).href)
const systemPromptModule = await import(pathToFileURL(toolsRequire.resolve('@deepseek-ai/dsh-system-prompt')).href)
const { default: SystemPrompt, renderPrompt } = systemPromptModule
const hasModernHost = typeof Tools.prototype.definitions === 'function' && typeof Tools.prototype.resolve === 'function'
const OPTIONS = { timeout: 60000, skip: !hasModernHost && 'requires current step-owned toolSet host' }
const CUES = 'tool-search:capabilities'
const CATALOG = 'tool-search:catalog'
const MODEL = { provider: 'fixture', model: 'no-model-call' }
const signal = () => AbortSignal.timeout(60000)
const normal = (text) => String(text).replace(/\s+/g, ' ').trim()
const paragraph = (text) => String(text).trim().split(/\r?\n\s*\r?\n/)[0]
const parameters = {
  type: 'object',
  properties: { SCHEMA_ONLY_CUES_311: { type: 'string', description: 'PARAMETER_ONLY_NOT_A_CAPABILITY_311' } },
  additionalProperties: false,
}
const definition = (name, description) => ({ name, description, parameters })
const BASE = [
  definition('edit', 'GLOBAL_FILE_PURPOSE_311: rewrite a local text file.\n\nGLOBAL_SECOND_PARAGRAPH_311.'),
  definition('opaque_handle', 'OPAQUE_ACTUAL_PURPOSE_311: reconcile invoice totals by account.\n\nOPAQUE_SECOND_PARAGRAPH_311.'),
  definition('mcp__cue__probe', 'MCP_ACTUAL_PURPOSE_311: inspect a browser response header.\n\nMCP_SECOND_PARAGRAPH_311.'),
]
const OWN = 'OWN_IMAGE_PURPOSE_311: adjust remote image colors without editing a local file.\n\nOWN_SECOND_PARAGRAPH_311.'

async function createHost(t, { presentation = 'native', rows = BASE, own = [{ ...BASE[0], description: OWN }], serverNames = ['cue'] } = {}) {
  const executor = await importHost(presentation === 'ptc' ? '@deepseek-ai/dsh-tool-executor-ptc' : '@deepseek-ai/dsh-tool-executor-native')
  assert.equal(typeof executor.apply, 'function', 'the real executor must be installed')
  const ctx = new Context()
  const persisted = new Map()
  const projectionHandles = new Set()
  // The host persistence boundary stores actual v2 metadata produced by execute below.
  // It supplies no pre-selected discovery names and does not render capabilities.
  ctx.provide('sessionProjections', {
    async register() {
      const handle = {
        stateOf: (session) => persisted.get(session),
        async dispose() { projectionHandles.delete(handle) },
      }
      projectionHandles.add(handle)
      return handle
    },
    stateOf: (session) => persisted.get(session),
  })
  ctx.provide('loader', { import: importHost })
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(Tools)
  if (presentation === 'ptc') ctx.provide('ptcRuntime', { language: 'typescript', programFormat: 'typescript' })
  await ctx.plugin(executor, {})
  const tools = ctx.get('tools')
  const systemPrompt = ctx.get('systemPrompt')
  const calls = []
  const actualDefinition = (row) => ({
    name: row.name, description: row.description, parameters: row.parameters ?? parameters,
    output: {
      schema: { type: 'object', properties: { executedTool: { type: 'string' } }, required: ['executedTool'] },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
    },
    async execute() { calls.push(row.name); return { executedTool: row.name } },
  })
  for (const row of rows) tools.register(actualDefinition(row), row.when ? { when: row.when } : {})
  const scopes = []
  const agents = []
  const addAgent = async (overrides = []) => {
    const agent = { id: `cue-${agents.length}`, session: { id: `cue-session-${agents.length}`, header: { cwd: '/fixture' }, deriveMessages: () => [] } }
    await new Promise((resolve) => ctx.inject(['tools'], (toolCtx) => {
      const scope = createScope(toolCtx, agent)
      agent.ctx = scope.ctx
      agent.scope = scope
      scopes.push(scope)
      resolve()
    }))
    for (const row of overrides) agent.ctx.tools.register(actualDefinition(row))
    agents.push(agent)
    return agent
  }
  const agent = await addAgent(own)
  const deferredNames = new Set(rows.map((row) => row.name))
  let enabled = true
  const config = {
    serverNames,
    policyFor: (_agent, schemas) => resolveToolLoadingPolicy({
      tools: schemas,
      policy: { tools: Object.fromEntries([...deferredNames].map((name) => [name, 'deferred'])) },
      protectedNames: ['tool_search', 'run_code'],
      masterSwitch: enabled ? 'on' : 'off',
    }),
  }
  let dispose = installToolSearchRuntime(ctx, config)
  const admissions = []
  const admit = async (target = agent) => {
    const toolSet = await tools.resolve({ agent: target, modelSelection: MODEL, signal: signal() })
    admissions.push(toolSet)
    return toolSet
  }
  const assemble = (target, toolSet) => systemPrompt.assemble({ agent: target, scope: target, toolSet, signal: signal(), modelSelection: MODEL })
  const search = async (target, toolSet, query) => {
    const searchTool = tools.get('tool_search', target, toolSet)
    assert.ok(searchTool, 'the existing production search entry must be registered')
    const value = await searchTool.execute({ query }, { agent: target, toolSet })
    const meta = searchTool.output.presentationMeta({ query }, value)
    assert.equal(meta.protocol, value.protocol)
    persisted.set(target.session, { protocol: meta.protocol, discovered: [...meta.discoverySnapshot.orderedNames] })
    return value
  }
  t.after(async () => {
    for (const admission of admissions.reverse()) await admission.dispose()
    await dispose()
    for (const scope of scopes.reverse()) await scope.dispose()
    await ctx.fiber.dispose()
    assert.equal(projectionHandles.size, 0, 'projection handles must be released')
  })
  return {
    ctx, tools, systemPrompt, agent, calls, addAgent, admit, assemble, search,
    enable(value) { enabled = value },
    async reinstall() { await dispose(); dispose = installToolSearchRuntime(ctx, config); await new Promise((resolve) => setImmediate(resolve)) },
    guard: (target, toolSet, name) => tools.checkGuards({ name, agent: target, toolSet })?.reason,
  }
}

function cueOf(assembly) {
  const entries = assembly.sections.filter((section) => section.name === CUES)
  assert.equal(entries.length, 1, 'unloaded actual capabilities need one independent cue section')
  assert.equal(entries[0].interpolate, false, 'actual descriptions are data, never prompt interpolation')
  assert.ok(entries[0].text.trim(), 'a title without actual capability content is insufficient')
  return entries[0]
}
const catalogOf = (assembly) => {
  const catalog = assembly.sections.find((section) => section.name === CATALOG)
  assert.ok(catalog, 'the existing names-only catalog must remain')
  return catalog
}
const noCue = (assembly) => assert.ok(!assembly.sections.some((section) => section.name === CUES && section.text.trim()), 'no eligible current short-hint source means no capability cue; full definitions may remain deferred')

for (const presentation of ['native', 'ptc']) {
  test(`real-host control ${presentation}: existing assembly, discovery and rendering are healthy`, OPTIONS, async (t) => {
    const host = await createHost(t, { presentation })
    const admission = await host.admit()
    const before = await host.assemble(host.agent, admission)
    assert.match(catalogOf(before).text, /^- edit$/m)
    assert.match(host.guard(host.agent, admission, 'edit') ?? '', /deferred/)
    assert.equal(typeof renderPrompt(before), 'string', 'real prompt rendering must be usable before the new feature')
    const value = await host.search(host.agent, admission, 'select:edit')
    assert.equal(value.matches[0].description, OWN)
    assert.deepEqual(value.matches[0].parameters, parameters)
    assert.equal(host.guard(host.agent, admission, 'edit'), undefined)
    const after = await host.assemble(host.agent, admission)
    if (presentation === 'native') assert.ok(after.tools.some((tool) => tool.name === 'edit'))
    else assert.ok(after.sections.find((section) => section.name === 'tools:sdk').text.includes('edit'))
  })
}

for (const presentation of ['native', 'ptc']) {
  test(`capability cues ${presentation}: actual scoped descriptions precede names-only catalog without loading schemas`, OPTIONS, async (t) => {
    const host = await createHost(t, { presentation })
    const admission = await host.admit()
    const assembly = await host.assemble(host.agent, admission)
    const catalog = catalogOf(assembly)
    // These controls establish a valid production fixture even before cues exist.
    assert.match(catalog.text, /^- edit$/m)
    assert.match(catalog.text, /^- opaque_handle$/m)
    assert.match(host.guard(host.agent, admission, 'edit') ?? '', /deferred/)
    const cue = cueOf(assembly)
    assert.ok(assembly.sections.indexOf(cue) < assembly.sections.indexOf(catalog))
    const current = host.tools.get('edit', host.agent, admission)
    assert.equal(current.description, OWN, 'real own-scope override must win')
    assert.ok(cue.text.includes(normal(paragraph(current.description))), 'cue must preserve the complete actual first paragraph')
    assert.ok(cue.text.includes(normal(paragraph(BASE[1].description))), 'unknown non-MCP names also have actual purposes')
    assert.doesNotMatch(cue.text, /GLOBAL_FILE_PURPOSE_311|SECOND_PARAGRAPH_311|SCHEMA_ONLY_CUES_311|PARAMETER_ONLY_NOT_A_CAPABILITY_311/)
    assert.doesNotMatch(catalog.text, /OWN_IMAGE_PURPOSE_311|OPAQUE_ACTUAL_PURPOSE_311/, 'do not turn catalog rows into purpose rows')
    await host.assemble(host.agent, admission)
    assert.equal(host.calls.length, 0, 'building cues must not execute a tool')
    assert.match(host.guard(host.agent, admission, 'edit') ?? '', /deferred/, 'reading cues must not discover a tool')
    if (presentation === 'native') assert.equal(assembly.tools.some((tool) => tool.name === 'edit'), false)
    else {
      assert.deepEqual(assembly.tools.map((tool) => tool.name), ['run_code'])
      const sdk = assembly.sections.find((section) => section.name === 'tools:sdk')
      assert.ok(sdk && !sdk.text.includes('opaque_handle'), 'PTC signatures remain deferred too')
    }
    const value = await host.search(host.agent, admission, 'select:edit')
    assert.deepEqual(value.discoveredTools, ['edit'], 'cue rendering must not pre-populate discovery')
    assert.equal(value.discoveredCount, 1)
    assert.equal(value.matches[0].description, current.description, 'search still returns the full original description')
    assert.deepEqual(value.matches[0].parameters, current.parameters)
    const after = await host.assemble(host.agent, admission)
    assert.doesNotMatch(cueOf(after).text, /OWN_IMAGE_PURPOSE_311/, 'loaded tool purpose must leave the deferred cue set')
    assert.match(host.guard(host.agent, admission, 'edit') ?? '', /^$/)
    const bound = host.tools.executable('edit', host.agent, admission)
    assert.ok(bound, 'original native/PTC binding must remain usable after load')
    assert.deepEqual(await bound.execute({ SCHEMA_ONLY_CUES_311: 'verify' }, { agent: host.agent, toolSet: admission }), { executedTool: 'edit' })
  })
}

test('non-MCP-only capabilities use an all-deferred-tools guide, never builtin-name guesses', OPTIONS, async (t) => {
  const rows = [definition('edit', 'ACTUAL_REMOTE_IMAGE_312: adjust remote image pixels.'), definition('read', ''), definition('ghost_empty_definition', ' \t\n ')]
  const host = await createHost(t, { rows, own: [], serverNames: [] })
  const admission = await host.admit()
  const assembly = await host.assemble(host.agent, admission)
  const cue = cueOf(assembly)
  assert.ok(cue.text.includes(rows[0].description))
  assert.doesNotMatch(cue.text, /ghost_empty_definition/, 'empty actual descriptions must be omitted, not invented')
  assert.doesNotMatch(cue.text, /编辑文件|读取文件/, 'UI aliases must not be promoted to actual capability facts')
  const searchTool = host.tools.get('tool_search', host.agent, admission)
  assert.doesNotMatch(searchTool.description, /deferred MCP tools/i, 'discovery guidance must include non-MCP tools')
  assert.match(cue.text, /schema/i)
  const guidance = assembly.sections.find(section => section.name === 'tool-search:guidance')
  assert.ok(guidance?.text.trim(), 'complete discovery guidance remains a runtime section, not repeated cue metadata')
  assert.match(guidance.text, /search/i)
  assert.match(guidance.text, /(?:action|verb)/i, 'guide needs action-oriented query formation')
  assert.match(guidance.text, /(?:object|target)/i, 'guide needs object-oriented query formation')
  assert.match(guidance.text, /skill/i, 'activation entry descriptions must not be mistaken for registered tools')
})

test('all-empty descriptions add no empty capability section but remain in the names catalog', OPTIONS, async (t) => {
  const rows = [definition('no_description_one', ''), definition('no_description_two', ' \t\r\n\r\n ')]
  const host = await createHost(t, { rows, own: [], serverNames: [] })
  const admission = await host.admit()
  const assembly = await host.assemble(host.agent, admission)
  assert.equal(assembly.sections.some((section) => section.name === CUES), false, 'do not add a title/directive-only cue with no actual purpose')
  assert.match(catalogOf(assembly).text, /^- no_description_one$/m)
  assert.match(catalogOf(assembly).text, /^- no_description_two$/m)
  const value = await host.search(host.agent, admission, 'select:no_description_one')
  assert.equal(value.matches[0].name, rows[0].name)
  assert.equal(value.matches[0].description, rows[0].description)
})

// Generic replacement contract: omit a long paragraph only when no qualifying complete first sentence exists.
test('overlong paragraphs without a qualifying first sentence are omitted but original schemas remain discoverable', OPTIONS, async (t) => {
  const first = 'LONG_FIRST_START_313 ' + 'semantic-clause '.repeat(90) + 'LONG_FIRST_END_313 {{unbound_cue}} ${USD} $$ 中文🚀.'
  const raw = '\n\n' + first.replace('semantic-clause semantic-clause', 'semantic-clause\n  semantic-clause') + '\n\nLATER_PARAGRAPH_MUST_NOT_APPEAR_313.'
  const row = definition('long_actual_tool', raw)
  assert.ok(normal(first).length > 240, 'external precondition: the first complete sentence itself is too long')
  const host = await createHost(t, { rows: [row], own: [], serverNames: [] })
  const admission = await host.admit()
  const assembly = await host.assemble(host.agent, admission)
  noCue(assembly)
  assert.match(catalogOf(assembly).text, /^- long_actual_tool$/m)
  assert.doesNotMatch(renderPrompt(assembly), /LONG_FIRST_START_313|LONG_FIRST_END_313|LATER_PARAGRAPH_MUST_NOT_APPEAR_313/)
  assert.match(host.guard(host.agent, admission, row.name) ?? '', /deferred/)
  assert.equal(host.calls.length, 0)
  const value = await host.search(host.agent, admission, 'select:long_actual_tool')
  assert.equal(value.matches[0].description, raw, 'only the hint is omitted; full calling definition remains intact')
  assert.deepEqual(value.matches[0].parameters, parameters)
  assert.equal(host.guard(host.agent, admission, row.name), undefined)
})

for (const presentation of ['native', 'ptc']) {
  test(`generic long literal metadata ${presentation}: complete first sentence survives rendering and full schema loading`, OPTIONS, async (t) => {
    const first = 'Read demo {{unbound_cue}} ${USD} $$ 中文🚀\r\n  and keep the (literal) record.'
    const lifecycle = ' Later execution lifecycle metadata remains in the full searchable definition.'
    const raw = '\r\n\r\n' + first + lifecycle.repeat(12) + '\r\n\r\nGENERIC_LONG_SECOND_PARAGRAPH_320.'
    assert.ok(normal(first).length <= 240)
    assert.ok(normal(first + lifecycle.repeat(12)).length > 160)
    const row = definition('opaque_long_sentence_fixture', raw)
    const host = await createHost(t, { presentation, rows: [row], own: [], serverNames: [] })
    const admission = await host.admit()
    const assembly = await host.assemble(host.agent, admission)
    const cue = cueOf(assembly)
    assert.ok(cue.text.includes(normal(first)), 'quote the complete first sentence, not a name-derived summary or cropped prefix')
    assert.doesNotMatch(cue.text, /Later execution lifecycle|GENERIC_LONG_SECOND_PARAGRAPH_320/)
    assert.ok(cue.text.length <= 800)
    assert.ok(renderPrompt(assembly).includes(normal(first)), 'literal {{}} and dollar content survive real prompt rendering')
    assert.match(host.guard(host.agent, admission, row.name) ?? '', /deferred/)
    assert.equal(host.calls.length, 0)
    if (presentation === 'native') assert.ok(!assembly.tools.some(tool => tool.name === row.name))
    else assert.ok(!assembly.sections.find(section => section.name === 'tools:sdk').text.includes(row.name))
    const found = await host.search(host.agent, admission, 'GENERIC_LONG_SECOND_PARAGRAPH_320')
    assert.deepEqual(found.discoveredTools, [row.name])
    assert.equal(found.matches[0].description, raw)
    assert.deepEqual(found.matches[0].parameters, parameters)
    assert.equal(host.guard(host.agent, admission, row.name), undefined)
    noCue(await host.assemble(host.agent, admission))
    const executable = host.tools.executable(row.name, host.agent, admission)
    assert.ok(executable, 'the original native/PTC binding remains callable after discovery')
    assert.deepEqual(await executable.execute({ SCHEMA_ONLY_CUES_311: 'verify' }, { agent: host.agent, toolSet: admission }), { executedTool: row.name })
  })
}

for (const presentation of ['native', 'ptc']) {
  test(`short literal metadata ${presentation}: complete paragraph survives CRLF, template braces, dollar text and rendering`, OPTIONS, async (t) => {
    const first = 'Read demo {{unbound_cue}} ${USD} $$ 中文🚀.\r\n  Preserve all short literal content.'
    const raw = '\r\n\r\n' + first + '\r\n\r\nLATER_PARAGRAPH_MUST_NOT_APPEAR_313.'
    assert.ok(normal(first).length <= 160, 'precondition: whole paragraph fits the fallback contract')
    const host = await createHost(t, { presentation, rows: [definition('literal_actual_tool', raw)], own: [], serverNames: [] })
    const admission = await host.admit()
    const assembly = await host.assemble(host.agent, admission)
    const cue = cueOf(assembly)
    assert.ok(cue.text.includes(normal(first)), 'preserve the whole short paragraph, not a cropped prefix')
    assert.doesNotMatch(cue.text, /LATER_PARAGRAPH_MUST_NOT_APPEAR_313/)
    const rendered = renderPrompt(assembly)
    assert.ok(rendered.includes(normal(first)), 'real rendering preserves literal {{}} and $ content')
    assert.ok(rendered.indexOf(cue.text) < rendered.indexOf(catalogOf(assembly).text))
    assert.match(host.guard(host.agent, admission, 'literal_actual_tool') ?? '', /deferred/)
    assert.equal(host.calls.length, 0)
  })
}

// User-approved replacement contract: existing instructions suppress duplicates; one short example per missing owner.
test('MCP instructions suppress redundant cues, one short example remains and unshown definitions stay searchable', OPTIONS, async (t) => {
  const rows = ['north', 'south'].flatMap((owner) => Array.from({ length: 4 }, (_, index) => {
    const word = `${owner}rareword${index}`
    return { ...definition(`mcp__${owner}__op_${index}`, `${owner.toUpperCase()}_EXAMPLE_${index}_314: inspect an actual resource.\n\nSearch-only capability word ${word}.`), word }
  }))
  const host = await createHost(t, { rows, own: [], serverNames: ['north', 'south'] })
  const instructions = 'WHOLE_SERVER_CLAIM_NOT_EXAMPLES_314: includes unadmitted operations.'
  host.systemPrompt.section({ name: 'mcp:north', order: 3100, interpolate: false, text: instructions })
  const admission = await host.admit()
  const assembly = await host.assemble(host.agent, admission)
  const cue = cueOf(assembly)
  assert.match(cue.text, /examples?|samples?|illustrative/i)
  assert.match(normal(cue.text), /(?:non[- ]?exhaustive|not (?:an? |the )?(?:complete|exhaustive|full)|not all)/i)
  assert.doesNotMatch(cue.text, /NORTH_EXAMPLE_|WHOLE_SERVER_CLAIM_NOT_EXAMPLES_314|Search-only capability word|SCHEMA_ONLY_CUES_311/)
  assert.equal(assembly.sections.find((section) => section.name === 'mcp:north').text, instructions, 'existing publisher instructions are never removed')
  const south = rows.filter((row) => row.name.startsWith('mcp__south__'))
  const shown = south.filter((row) => cue.text.includes(normal(paragraph(row.description))))
  assert.equal(shown.length, 1, 'missing instructions permit exactly one eligible example for this owner')
  assert.ok(cue.text.length <= 800, 'the complete cue section is within the new total budget')
  for (const owner of ['north', 'south']) {
    const omitted = rows.find((row) => row.name === `mcp__${owner}__op_3`)
    assert.ok(!cue.text.includes(normal(paragraph(omitted.description))))
    assert.ok(catalogOf(assembly).text.includes('- op_3'), 'hint limits must not truncate the actual names directory')
    const result = await host.search(host.agent, admission, omitted.word)
    const match = result.matches.find((entry) => entry.name === omitted.name)
    assert.ok(match, 'an omitted purpose remains discoverable through the full current definition')
    assert.equal(match.description, omitted.description)
    assert.deepEqual(match.parameters, host.tools.get(omitted.name, host.agent, admission).parameters)
  }
})

for (const presentation of ['native', 'ptc']) {
  test(`MCP existing instructions ${presentation}: no duplicate cue, current original schema still loads`, OPTIONS, async (t) => {
    const row = definition('mcp__cue__only', 'INSTRUCTIONS_OWNED_PURPOSE_318: read a known fixture.\n\nFull second paragraph retained.')
    const host = await createHost(t, { presentation, rows: [row], own: [] })
    const instructions = 'ACTUAL_PUBLISHER_INSTRUCTIONS_318: use the current fixture read operation.'
    host.systemPrompt.section({ name: 'mcp:cue', order: 3100, interpolate: false, text: instructions })
    const admission = await host.admit()
    const assembly = await host.assemble(host.agent, admission)
    noCue(assembly)
    assert.equal(assembly.sections.find((section) => section.name === 'mcp:cue').text, instructions)
    assert.match(catalogOf(assembly).text, /^- only$/m)
    assert.match(host.guard(host.agent, admission, row.name) ?? '', /deferred/)
    const found = await host.search(host.agent, admission, 'select:mcp__cue__only')
    assert.equal(found.matches[0].description, row.description)
    assert.deepEqual(found.matches[0].parameters, parameters)
    assert.equal(host.guard(host.agent, admission, row.name), undefined)
  })
}

test('MCP instruction changes switch duplicate suppression without discovering or changing current definitions', OPTIONS, async (t) => {
  const row = definition('mcp__cue__instruction_switch', 'INSTRUCTION_SWITCH_PURPOSE_319: read a current fixture.')
  const host = await createHost(t, { rows: [row], own: [] })
  let instructions = 'ACTUAL_EXISTING_INSTRUCTIONS_319.'
  host.systemPrompt.section({ name: 'mcp:cue', order: 3100, interpolate: false, text: () => instructions })
  const admission = await host.admit()
  noCue(await host.assemble(host.agent, admission))
  instructions = ' \t\r\n '
  const after = await host.assemble(host.agent, admission)
  assert.ok(cueOf(after).text.includes(row.description), 'actual empty instructions permit a short fallback example')
  assert.match(host.guard(host.agent, admission, row.name) ?? '', /deferred/)
  assert.equal(host.calls.length, 0)
  instructions = 'ACTUAL_EXISTING_INSTRUCTIONS_319.'
  noCue(await host.assemble(host.agent, admission))
})

test('cues are agent-scoped: a peer own-definition must not leak into another agent', OPTIONS, async (t) => {
  const host = await createHost(t)
  const peerDescription = 'PEER_PURPOSE_315: read an archive index rather than edit an image.\n\nPEER_SECOND_PARAGRAPH_315.'
  const peer = await host.addAgent([{ ...BASE[0], description: peerDescription }])
  const first = await host.admit()
  const second = await host.admit(peer)
  const firstCue = cueOf(await host.assemble(host.agent, first)).text
  const peerCue = cueOf(await host.assemble(peer, second)).text
  assert.ok(firstCue.includes(normal(paragraph(OWN))))
  assert.doesNotMatch(firstCue, /PEER_PURPOSE_315|GLOBAL_FILE_PURPOSE_311/)
  assert.ok(peerCue.includes(normal(paragraph(peerDescription))))
  assert.doesNotMatch(peerCue, /OWN_IMAGE_PURPOSE_311|GLOBAL_FILE_PURPOSE_311/)
  await host.search(host.agent, first, 'select:edit')
  assert.doesNotMatch(cueOf(await host.assemble(host.agent, first)).text, /OWN_IMAGE_PURPOSE_311/)
  assert.ok(cueOf(await host.assemble(peer, second)).text.includes(normal(paragraph(peerDescription))), 'one agent loading a name must not load it for its peer')
})

test('the step-owned toolSet, not a fresh management union, determines conditional cue visibility', OPTIONS, async (t) => {
  let allowed = false
  const name = 'mcp__cue__conditional'
  const description = 'STEP_ONLY_PURPOSE_316: inspect a conditional resource.'
  const host = await createHost(t, { rows: [...BASE.filter((row) => !row.name.startsWith('mcp__')), { ...definition(name, description), when: () => allowed }] })
  const deniedStep = await host.admit()
  allowed = true
  const denied = await host.assemble(host.agent, deniedStep)
  assert.doesNotMatch(cueOf(denied).text, /STEP_ONLY_PURPOSE_316|conditional/)
  assert.doesNotMatch(catalogOf(denied).text, /conditional/)
  const admittedStep = await host.admit()
  allowed = false
  const admitted = await host.assemble(host.agent, admittedStep)
  assert.ok(cueOf(admitted).text.includes(description), 'the already admitted step must retain its own definition snapshot')
  const next = await host.admit()
  assert.doesNotMatch(cueOf(await host.assemble(host.agent, next)).text, /STEP_ONLY_PURPOSE_316/)
})

for (const presentation of ['native', 'ptc']) {
  test(`capability cues ${presentation}: all loaded and disabled states suppress cues`, OPTIONS, async (t) => {
    const host = await createHost(t, { presentation })
    const admission = await host.admit()
    cueOf(await host.assemble(host.agent, admission))
    const names = BASE.map((row) => row.name)
    await host.search(host.agent, admission, `select:${names.join(',')}`)
    const loaded = await host.assemble(host.agent, admission)
    noCue(loaded)
    host.enable(false)
    const next = await host.admit()
    const disabled = await host.assemble(host.agent, next)
    noCue(disabled)
    assert.equal(disabled.sections.some((section) => section.name === CATALOG), false)
  })
  test(`capability cues ${presentation}: restored v2 discovery metadata suppresses only previously loaded purposes`, OPTIONS, async (t) => {
    const host = await createHost(t, { presentation })
    const admission = await host.admit()
    const value = await host.search(host.agent, admission, 'select:edit')
    assert.deepEqual(value.discoveredTools, ['edit'])
    await host.reinstall()
    const next = await host.admit()
    const restored = await host.assemble(host.agent, next)
    const cue = cueOf(restored)
    assert.doesNotMatch(cue.text, /OWN_IMAGE_PURPOSE_311/)
    assert.ok(cue.text.includes(normal(paragraph(BASE[1].description))))
    assert.equal(host.guard(host.agent, next, 'edit'), undefined, 'restored loading still obeys the original discovery contract')
    if (presentation === 'native') assert.ok(restored.tools.some((tool) => tool.name === 'edit'))
    else assert.ok(restored.sections.find((section) => section.name === 'tools:sdk').text.includes('edit'))
  })
}

test('equal-length instruction changes have distinct production fingerprints and no stale catalog claim', OPTIONS, async (t) => {
  const host = await createHost(t)
  let instructions = 'Read metadata safely.'
  host.systemPrompt.section({ name: 'mcp:cue', order: 3100, interpolate: false, text: () => instructions })
  const admission = await host.admit()
  const before = await host.assemble(host.agent, admission)
  const beforeFingerprint = instructionFingerprint(before.sections)
  const oldText = instructions
  instructions = 'Send metadata safely.'
  assert.equal(instructions.length, oldText.length, 'only content, not length, changes')
  const after = await host.assemble(host.agent, admission)
  assert.equal(after.sections.find((section) => section.name === 'mcp:cue').text, instructions)
  assert.notEqual(instructionFingerprint(after.sections), beforeFingerprint, 'same-length instruction edits must invalidate content identity')
  assert.doesNotMatch(catalogOf(after).text, /Read metadata safely\./)
})
