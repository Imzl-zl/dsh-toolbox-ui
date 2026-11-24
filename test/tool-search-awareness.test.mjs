// Discovery is driven through real host registrations and step admissions, not a second search implementation.
import assert from 'node:assert/strict'
import test from 'node:test'
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import { createScope } from '@deepseek-ai/dsh-scope'
import Tools from '@deepseek-ai/dsh-tools'
import { installToolSearchRuntime } from '../lib/tool-search-runtime.js'
import { capabilityCues } from '../lib/tool-discovery-cues.js'

const require = createRequire(import.meta.url)
const fromTools = createRequire(require.resolve('@deepseek-ai/dsh-tools'))
const { default: SystemPrompt, renderPrompt } = await import(pathToFileURL(fromTools.resolve('@deepseek-ai/dsh-system-prompt')).href)
const modern = typeof Tools.prototype.definitions === 'function'
const OPTIONS = { timeout: 60000, skip: !modern && 'requires a step-owned host admission' }
const MODEL = { provider: 'local-fixture', model: 'no-model-request' }
const definition = (name, description, over = {}) => ({
  name, description,
  parameters: { type: 'object', properties: { packetId: { type: 'string' } }, required: ['packetId'] },
  ...over,
})
const rows = [
  definition('host_entry', 'Read one current local resource.'),
  ...['tenant_ax', 'tenant_by', 'tenant_cz', 'tenant_dw', 'tenant_ev'].map((owner, i) =>
    definition(`mcp__${owner}__opaque_${i}`, `Inspect current source ${i} and return its record.`)),
]

async function fixture(t, { presentation = 'native', definitions = rows } = {}) {
  const ctx = new Context()
  const importer = (name) => import(pathToFileURL(require.resolve(name)).href)
  const executor = await importer(presentation === 'ptc' ? '@deepseek-ai/dsh-tool-executor-ptc' : '@deepseek-ai/dsh-tool-executor-native')
  const persisted = new Map()
  ctx.provide('loader', { import: importer })
  ctx.provide('sessionProjections', {
    async register() {
      return { stateOf: (session) => persisted.get(session), async dispose() {} }
    },
  })
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(Tools)
  if (presentation === 'ptc') ctx.provide('ptcRuntime', { language: 'typescript', programFormat: 'typescript' })
  await ctx.plugin(executor, {})
  const tools = ctx.get('tools')
  const systemPrompt = ctx.get('systemPrompt')
  const executed = []
  const asTool = (row) => ({
    name: row.name, description: row.description, parameters: row.parameters,
    output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
    async execute(args) { executed.push(row.name); return `${row.name}:${args.packetId}` },
  })
  for (const row of definitions) tools.register(asTool(row), row.when ? { when: row.when } : {})
  const scopes = []
  const agents = []
  const addAgent = async (overrides = []) => {
    const agent = { id: `aware-${agents.length}`, session: { id: `aware-session-${agents.length}`, header: { cwd: `/fixture/${agents.length}` }, deriveMessages: () => [] } }
    await new Promise((resolve) => ctx.inject(['tools'], (bound) => {
      const scope = createScope(bound, agent)
      scopes.push(scope)
      agent.ctx = scope.ctx
      resolve()
    }))
    for (const row of overrides) agent.ctx.tools.register(asTool(row))
    agents.push(agent)
    return agent
  }
  const agent = await addAgent()
  const serverNames = [...new Set(definitions.map(({ name }) => /^mcp__(.*?)__/.exec(name)?.[1]).filter(Boolean))]
  const config = {
    serverNames,
    policyFor: (_agent, schemas) => ({ entries: new Map(schemas.filter(({ name }) => name !== 'tool_search' && name !== 'run_code').map(({ name }) => [name, { effective: 'deferred' }])) }),
    deferServers: serverNames,
  }
  // All fixture definitions are deferred explicitly, including the opaque host capability.
  config.policyFor = (_agent, schemas) => ({ entries: new Map(schemas.filter(({ name }) => name !== 'tool_search' && name !== 'run_code').map(({ name }) => [name, { policy: 'deferred', effective: 'deferred' }])) })
  let dispose = installToolSearchRuntime(ctx, config)
  const admissions = []
  const admit = async (target = agent) => {
    const toolSet = await tools.resolve({ agent: target, modelSelection: MODEL, signal: AbortSignal.timeout(60000) })
    admissions.push(toolSet)
    return toolSet
  }
  const invoke = async (args, target = agent, toolSet = undefined) => {
    toolSet ??= await admit(target)
    const tool = tools.get('tool_search', target, toolSet)
    assert.ok(tool)
    const value = await tool.execute(args, { agent: target, toolSet })
    const meta = tool.output.presentationMeta(args, value)
    // Same persistence contract as the production projection: only discovery records update it.
    if (meta?.protocol === 'dsh-tool-search/v2') {
      persisted.set(target.session, { protocol: meta.protocol, discovered: [...meta.discoverySnapshot.orderedNames] })
    }
    return { value, meta, rendered: tool.output.render(args, value), toolSet }
  }
  t.after(async () => {
    for (const admitted of admissions.reverse()) admitted.dispose()
    await dispose()
    for (const scope of scopes.reverse()) await scope.dispose()
    await ctx.fiber.dispose()
  })
  return {
    agent, tools, systemPrompt, executed, addAgent, admit, invoke, persisted,
    async reinstall() { await dispose(); dispose = installToolSearchRuntime(ctx, config); await dispose.ready },
    async assemble(target = agent, toolSet = undefined) {
      toolSet ??= await admit(target)
      return systemPrompt.assemble({ agent: target, scope: target, toolSet, signal: AbortSignal.timeout(60000), modelSelection: MODEL })
    },
    guard(target, toolSet, name) { return tools.checkGuards({ agent: target, toolSet, name })?.reason },
  }
}

for (const presentation of ['native', 'ptc']) {
  test(`browse ${presentation}: capabilities are metadata, never loading or execution`, OPTIONS, async (t) => {
    const host = await fixture(t, { presentation })
    const first = await host.admit()
    const tool = host.tools.get('tool_search', host.agent, first)
    assert.ok(tool.parameters.properties.mode?.enum.includes('browse'), 'the model must be able to discover the browse operation')
    let inspected
    await assert.doesNotReject(async () => { inspected = await host.invoke({ mode: 'browse', max_results: 2 }, host.agent, first) })
    const { value, meta } = inspected
    assert.equal(value.mode, 'browse')
    assert.equal(value.entries.length, 2)
    assert.ok(value.entries.every((entry) => !Object.hasOwn(entry, 'parameters') && !Object.hasOwn(entry, 'signature')))
    assert.notEqual(meta?.protocol, 'dsh-tool-search/v2', 'browse must not create an explicit empty discovery snapshot')
    assert.equal(Object.hasOwn(meta ?? {}, 'discoverySnapshot'), false)
    assert.equal(host.executed.length, 0)
    for (const entry of value.entries) {
      assert.match(host.guard(host.agent, first, entry.name) ?? '', /deferred/)
      assert.ok(rows.some((row) => row.name === entry.name))
    }
    assert.match(value.instruction, /not.*(?:loaded|schemas)|unloaded/i)
    assert.match(value.instruction, /select:/)
    const prompt = renderPrompt(await host.assemble(host.agent, first))
    assert.match(prompt, /browse/i, 'the purpose hint is not sufficient if the discovery action is never introduced')
  })

  test(`browse ${presentation}: a fifth unfamiliar owner can be inspected then really called`, OPTIONS, async (t) => {
    const host = await fixture(t, { presentation })
    const intended = rows.at(-1)
    const step = await host.admit()
    const { value } = await host.invoke({ mode: 'browse', server: 'tenant_ev' }, host.agent, step)
    assert.equal(value.entries.length, 1)
    assert.equal(value.entries[0].name, intended.name)
    assert.equal(value.entries[0].purpose, intended.description)
    assert.deepEqual(value.entries[0].argumentNames, Object.keys(intended.parameters.properties))
    assert.match(host.guard(host.agent, step, intended.name) ?? '', /deferred/)
    const loaded = await host.invoke({ query: `select:${intended.name}` }, host.agent, step)
    assert.deepEqual(loaded.value.matches[0].parameters, intended.parameters)
    assert.equal(host.guard(host.agent, step, intended.name), undefined)
    const executable = host.tools.executable(intended.name, host.agent, step)
    assert.equal(await executable.execute({ packetId: 'real-fixture-value' }, { agent: host.agent, toolSet: step }), `${intended.name}:real-fixture-value`)
    assert.deepEqual(host.executed, [intended.name])
  })

  test(`browse ${presentation}: pagination and an empty filter preserve existing restored discoveries`, OPTIONS, async (t) => {
    const host = await fixture(t, { presentation })
    const intended = rows[1]
    await host.invoke({ query: `select:${intended.name}` })
    const before = structuredClone(host.persisted.get(host.agent.session))
    const seen = []
    let cursor
    do {
      const { value } = await host.invoke({ mode: 'browse', max_results: 2, ...(cursor ? { cursor } : {}) })
      assert.equal(value.total, rows.length)
      assert.ok(value.entries.length > 0)
      seen.push(...value.entries.map(({ name }) => name))
      cursor = value.nextCursor
      assert.ok(seen.length <= rows.length, 'paging makes monotonic progress')
    } while (cursor)
    assert.deepEqual(new Set(seen), new Set(rows.map(({ name }) => name)))
    assert.equal(seen.length, rows.length)
    const empty = await host.invoke({ mode: 'browse', server: 'not-an-installed-owner' })
    assert.deepEqual(empty.value.entries, [])
    assert.equal(empty.value.nextCursor, null)
    assert.deepEqual(host.persisted.get(host.agent.session), before)
    await host.reinstall()
    const step = await host.admit()
    await host.assemble(host.agent, step)
    assert.equal(host.guard(host.agent, step, intended.name), undefined)
    assert.equal(host.executed.length, 0)
  })
}

test('browse cursors are bound to the requesting agent, filter and current admitted catalog', OPTIONS, async (t) => {
  let available = false
  const conditional = definition('mcp__tenant_ev__optional', 'Read conditional source state.', { when: () => available })
  const host = await fixture(t, { definitions: [...rows, conditional] })
  const step = await host.admit()
  const first = await host.invoke({ mode: 'browse', max_results: 1 }, host.agent, step)
  assert.ok(first.value.nextCursor)
  const peer = await host.addAgent()
  await assert.rejects(host.invoke({ mode: 'browse', cursor: first.value.nextCursor }, peer), /cursor|catalog.*changed|restart/i)
  await assert.rejects(host.invoke({ mode: 'browse', server: 'tenant_ev', cursor: first.value.nextCursor }, host.agent, step), /cursor|restart/i)
  available = true
  // A new admission may add the conditional tool; the original step remains authoritative for its own pages.
  await assert.rejects(host.invoke({ mode: 'browse', cursor: first.value.nextCursor }), /cursor|catalog.*changed|restart/i)
  const old = await host.invoke({ mode: 'browse', cursor: first.value.nextCursor }, host.agent, step)
  assert.ok(old.value.entries.every(({ name }) => name !== conditional.name))
})

test('weak publisher instructions do not hide browse metadata; empty and overlong purposes retain real identities', OPTIONS, async (t) => {
  const empty = definition('mcp__unknown_publisher__empty', ' \t ')
  const long = definition('mcp__unknown_publisher__late_purpose', 'Long initial clause ' + 'continuation '.repeat(30) + '\n\nReturn the requested private packet.')
  const literal = definition('mcp__unknown_publisher__literal', '读取当前「记录」。 {{literal}} \\ "quoted"')
  const host = await fixture(t, { definitions: [empty, long, literal] })
  host.systemPrompt.section({ name: 'mcp:unknown_publisher', order: 3100, interpolate: false, text: 'ok' })
  const step = await host.admit()
  const { value } = await host.invoke({ mode: 'browse' }, host.agent, step)
  assert.equal(value.total, 3)
  for (const source of [empty, long, literal]) {
    const found = value.entries.find(({ name }) => name === source.name)
    assert.ok(found)
    assert.deepEqual(found.argumentNames, Object.keys(source.parameters.properties))
    assert.match(host.guard(host.agent, step, source.name) ?? '', /deferred/)
    const loaded = await host.invoke({ query: `select:${source.name}` }, host.agent, step)
    assert.equal(loaded.value.matches[0].description, source.description)
  }
  assert.equal(value.entries.find(({ name }) => name === long.name).purpose, null, 'not a name-derived or clipped semantic summary')
  assert.equal(host.executed.length, 0)
})

test('discovery guidance scopes proactive search to missing capabilities, with a direct-answer and stopping path', OPTIONS, async (t) => {
  const host = await fixture(t)
  const step = await host.admit()
  const assembly = await host.assemble(host.agent, step)
  const guide = assembly.sections.find(({ name }) => name === 'tool-search:guidance').text
  assert.match(guide, /(?:directly|answer).*?(?:without|no|unnecessary).*?tool|(?:without|no).*?tool.*?answer/i)
  assert.match(guide, /browse/i)
  assert.match(guide, /(?:enough|sufficient|stop)/i)
  assert.match(guide, /(?:needs|requires|needed)/i)
  assert.equal(host.executed.length, 0)
})

function purposeMap(definitions) {
  const catalog = new Map(definitions.map((row) => [row.name, row]))
  const groups = new Map()
  const unattributed = []
  for (const row of definitions) {
    if (row.owner === undefined) unattributed.push(row)
    else {
      if (!groups.has(row.owner)) groups.set(row.owner, [])
      groups.get(row.owner).push({ name: row.name })
    }
  }
  return capabilityCues(catalog, { groups: [...groups].map(([server, names]) => ({ server, names })), unattributed })
}

test('purpose budget reserves source breadth before taking more host examples', () => {
  const hostPurpose = 'Read a current local record. ' + 'Local metadata stays read-only. '.repeat(4)
  assert.ok(hostPurpose.trim().length <= 160)
  const hostRows = Array.from({ length: 12 }, (_, i) => ({ name: `unfamiliar_host_${i}`, description: hostPurpose.trim() }))
  const mcp = { name: 'mcp__unknown_source__p0', owner: 'unknown_source', description: 'Read an external record.' }
  const cues = purposeMap([...hostRows, mcp])
  assert.ok(cues.text.length <= 800)
  assert.ok(cues.text.includes(JSON.stringify(mcp.description)), 'a fitting missing-source example cannot be crowded out by repeated host entries')
  assert.ok(cues.text.includes(JSON.stringify(hostPurpose.trim())))
})

test('a source can use a later whole short example when its first valid quotation cannot fit', () => {
  const owners = ['budget_a', 'budget_b', 'budget_c']
  const rows = [
    ...owners.slice(0, 2).map((owner) => ({ name: `mcp__${owner}__r`, owner, description: 'Read this current metadata record without modifying it. ' + 'Its values come from the current source. '.repeat(2) })),
    { name: 'mcp__budget_c__a', owner: 'budget_c', description: 'Inspect ' + 'the extended record with complete context '.repeat(5) + 'now.' },
    { name: 'mcp__budget_c__b', owner: 'budget_c', description: 'Read short state.' },
  ]
  const cues = purposeMap(rows)
  assert.ok(cues.text.length <= 800)
  assert.ok(cues.text.includes(JSON.stringify(rows.at(-1).name)))
  assert.ok(cues.text.includes(JSON.stringify(rows.at(-1).description)))
})

test('browse exposes declared argument names from object branches without changing the calling schema', OPTIONS, async (t) => {
  const row = definition('mcp__branch_source__r', 'Inspect the specified record.', {
    parameters: { type: 'object', allOf: [{ $ref: '#/$defs/identity' }, { properties: { revision: { type: 'integer' } } }], $defs: { identity: { properties: { packetId: { type: 'string' } }, required: ['packetId'] } } },
  })
  const host = await fixture(t, { definitions: [row] })
  const step = await host.admit()
  const { value } = await host.invoke({ mode: 'browse' }, host.agent, step)
  assert.deepEqual(new Set(value.entries[0].argumentNames), new Set(['packetId', 'revision']))
  assert.equal(value.entries[0].argumentCount, 2)
  assert.match(host.guard(host.agent, step, row.name) ?? '', /deferred/)
  const loaded = await host.invoke({ query: `select:${row.name}` }, host.agent, step)
  assert.deepEqual(loaded.value.matches[0].parameters, row.parameters)
})

test('small unfamiliar source groups are limited by the common budget, not a hard-coded three-owner ceiling', () => {
  const owners = ['opaque_a', 'opaque_b', 'opaque_c', 'opaque_d']
  const definitions = owners.map((owner) => ({ name: `mcp__${owner}__r`, owner, description: 'Read the current record.' }))
  const cues = purposeMap(definitions)
  assert.ok(cues.text.length <= 800)
  for (const { name } of definitions) assert.ok(cues.text.includes(JSON.stringify(name)), 'every complete source example that fits the small inventory can be shown')
})
