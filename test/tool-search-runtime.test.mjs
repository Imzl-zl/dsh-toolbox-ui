import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import * as dshTools from '@deepseek-ai/dsh-tools'
import {
  DEFAULTS,
  activeMaskedServers,
  buildToolSearchView,
  catalogSectionText,
  deferredTools,
  discoveredFromMessages,
  filterCatalog,
  filterManagedTools,
  guardDecision,
  installToolSearchRuntime,
  maskGuidanceSection,
  maskInstructionSections,
  parseDiscoveredMeta,
  partitionSchemas,
  resolveRuntimeConfig,
  uniqueOwner,
  viewRevision,
} from '../lib/tool-search-runtime.js'

// ── 纯决策函数 ──

const runtimeSource = await readFile(new URL('../lib/tool-search-runtime.js', import.meta.url), 'utf8')

test('uniqueOwner: 唯一前缀才算归属', () => {
  assert.equal(uniqueOwner('mcp__jshook__browser_launch', new Set(['jshook', 'firecrawl'])), 'jshook')
  assert.equal(uniqueOwner('Read', new Set(['jshook'])), null)
  // serverName 含 __ 时的歧义：mcp__a__b__x 同时像 a 与 a__b 的工具——不断言归属（稳定侧）。
  assert.equal(uniqueOwner('mcp__a__b__x', new Set(['a', 'a__b'])), null)
})

test('partitionSchemas: 只管理列入 defer 的服务器，搜索工具自身永稳定', () => {
  const sets = { toolName: 'tool_search', serverNames: new Set(['jshook', 'firecrawl']), deferServers: new Set(['jshook']) }
  const { managed, stable, ownerOf } = partitionSchemas([
    { name: 'mcp__jshook__browser_launch', description: 'launch', parameters: null },
    { name: 'mcp__firecrawl__scrape', description: 'scrape', parameters: null },
    { name: 'tool_search', description: 'search', parameters: null },
    { name: 'Read', description: 'read', parameters: null },
    { name: 'mcp__a__b__x', description: 'ambiguous', parameters: null },
  ], sets)
  assert.deepEqual([...managed.keys()], ['mcp__jshook__browser_launch'])
  assert.ok(stable.has('mcp__firecrawl__scrape'))
  assert.ok(stable.has('tool_search'))
  assert.ok(stable.has('Read'))
  assert.ok(stable.has('mcp__a__b__x'), '归属歧义的工具落稳定侧，不延迟')
  // ownerOf 让 per-server 计数不必再跑一遍 uniqueOwner。
  assert.equal(ownerOf.get('mcp__jshook__browser_launch'), 'jshook')
  assert.equal(ownerOf.get('Read'), undefined)
})

test('per-server 门槛不存在：3 工具服务器也启用（旧 applyServerFloor 已删）', () => {
  // 这条替换掉原来的 `applyServerFloor` 用例（F11 那条 `>` 变异用例一并作废）。
  // 官方没有 per-server 工具数门槛（F8），而那道门槛制造了"勾了没生效"的断层——
  // 所以判据只剩一个：**这台服务器被列入 defer 了吗**。
  const schemas = Array.from({ length: 3 }, (_, i) => ({ name: `mcp__tiny__t${i}`, description: 'd', parameters: null }))
  const view = buildToolSearchView(schemas, resolveRuntimeConfig({ deferServers: ['tiny'], serverNames: ['tiny'] }))
  assert.equal(view.managed.size, 3, '3 个工具也必须启用')
  assert.equal(runtimeSource.includes('applyServerFloor'), false, '门槛函数必须彻底消失（留着会被当"还在生效"）')
})

test('filterManagedTools: 只摘被管理未发现的，外来工具原样保留', () => {
  const tools = [
    { name: 'Read' },
    { name: 'mcp__a__x' },
    { name: 'mcp__a__y' },
    { name: 'mcp__other__z' },
    { name: 'tool_search' },
  ]
  const managed = new Set(['mcp__a__x', 'mcp__a__y'])
  const discovered = new Set(['mcp__a__x'])
  assert.deepEqual(filterManagedTools(tools, managed, discovered).map((tool) => tool.name), ['Read', 'mcp__a__x', 'mcp__other__z', 'tool_search'])
  // 未知来源的工具（不在注册表视图里）绝不被误删——这是黑名单而非白名单的原因。
  assert.deepEqual(filterManagedTools([{ name: 'plugin_x__custom' }], managed, discovered).map((tool) => tool.name), ['plugin_x__custom'])
})

test('guardDecision: 只管未发现的被管理工具', () => {
  const config = resolveRuntimeConfig({ deferServers: ['a'], serverNames: ['a'] })
  const state = { managed: new Set(['mcp__a__x']), discovered: new Set() }
  assert.equal(guardDecision('mcp__a__x', state, config).includes('is deferred'), true)
  assert.equal(guardDecision('mcp__a__x', { managed: state.managed, discovered: new Set(['mcp__a__x']) }, config), undefined)
  assert.equal(guardDecision('Read', state, config), undefined)
  assert.equal(guardDecision('tool_search', state, config), undefined)
  const off = resolveRuntimeConfig({ requireDiscovery: false, deferServers: ['a'], serverNames: ['a'] })
  assert.equal(guardDecision('mcp__a__x', state, off), undefined)
})

test('clampDiscovered: 迁到 tool-search-state（LRU）——淘汰不再按插入序', () => {
  // 旧实现在这里：`Set` 的迭代序当插入序，无条件淘汰。第十轮换成 `Map<name, tick>` +
  // 「最多踢一半」，公式与收敛表在 test/tool-search-state.test.mjs 里逐行钉住。
  // 这条只留一句提示：**别再往 runtime 里加一份淘汰实现**（第二真相源）。
  assert.equal(runtimeSource.includes('clampDiscovered'), false, 'runtime 不得再有自己的淘汰实现')
})

test('parseDiscoveredMeta: 协议不符不认，累积列表与 matches 兜底', () => {
  assert.deepEqual(parseDiscoveredMeta({ protocol: 'dsh-tool-search/v1', allDiscoveredTools: ['x', 'y'] }), ['x', 'y'])
  assert.deepEqual(parseDiscoveredMeta({ protocol: 'dsh-tool-search/v1', discoveredTools: ['z'] }), ['z'])
  assert.deepEqual(parseDiscoveredMeta({ protocol: 'dsh-tool-search/v1', matches: [{ name: 'm' }, { name: 'bad', found: false }] }), ['m'])
  assert.deepEqual(parseDiscoveredMeta({ protocol: 'dsh-tool-search/v1' }), [])
  assert.equal(parseDiscoveredMeta({ protocol: 'someone-else/v1', allDiscoveredTools: ['x'] }), undefined)
  assert.equal(parseDiscoveredMeta(null), undefined)
  assert.equal(parseDiscoveredMeta('text'), undefined)
})

test('discoveredFromMessages: 从派生消息还原发现集，非本工具/错误结果不认', () => {
  const toolMsg = (id, value, isError = false) => ({
    role: 'tool',
    toolCallId: id,
    isError,
    source: { kind: 'tool', callId: id },
    content: [{ type: 'text', text: JSON.stringify(value) }],
  })
  const messages = [
    { role: 'user', content: [{ type: 'text', text: 'hi' }] },
    toolMsg('c1', { protocol: 'dsh-tool-search/v1', discoveredTools: ['mcp__a__x', 'mcp__a__y'] }),
    toolMsg('c2', { protocol: 'dsh-tool-search/v1', discoveredTools: ['mcp__a__nope'] }, true),
    toolMsg('c3', { protocol: 'someone-else/v1', discoveredTools: ['mcp__a__ghost'] }),
    toolMsg('c4', 'not json at all'),
    toolMsg('c5', { protocol: 'dsh-tool-search/v1', matches: [{ name: 'mcp__a__m' }, { name: 'mcp__a__bad', found: false }] }),
    { role: 'assistant', content: [] },
  ]
  const discovered = discoveredFromMessages(messages)
  assert.deepEqual([...discovered].sort(), ['mcp__a__m', 'mcp__a__x', 'mcp__a__y'])
})

test('viewRevision: 内容不变 revision 不变，内容或配置变则变', () => {
  const config = resolveRuntimeConfig({ deferServers: ['jshook'], serverNames: ['jshook'] })
  const schemas = [{ name: 'mcp__jshook__a', description: 'a', parameters: { type: 'object' } }]
  const again = [{ name: 'mcp__jshook__a', description: 'a', parameters: { type: 'object' } }]
  const edited = [{ name: 'mcp__jshook__a', description: 'a2', parameters: { type: 'object' } }]
  assert.equal(viewRevision(schemas, config), viewRevision(again, config), '等价输入必须同 revision')
  assert.notEqual(viewRevision(schemas, config), viewRevision(edited, config), '描述变了必须换 revision')
  const otherConfig = resolveRuntimeConfig({ deferServers: ['jshook', 'firecrawl'], serverNames: ['jshook', 'firecrawl'] })
  assert.notEqual(viewRevision(schemas, config), viewRevision(schemas, otherConfig), 'defer 集变了必须换 revision')
  // serverNames 是**活输入**：项目 MCP 连接晚连时会多出名字，归属判定（uniqueOwner）随之改变，
  // 所以它必须进 revision。defer 集把 serverNames 一起改了会掩盖这一点，单独变一次才测得准。
  const moreServers = resolveRuntimeConfig({ deferServers: ['jshook'], serverNames: ['jshook', 'firecrawl'] })
  assert.notEqual(viewRevision(schemas, config), viewRevision(schemas, moreServers), 'serverNames 变了必须换 revision')
})

test('buildToolSearchView: 纯函数；per-server 与聚合门槛都不存在（3 工具服务器也启用）', () => {
  // B1/C3：两道门槛整个删掉了。视图里的 `managed` 就是"列入 defer 的服务器全部工具"，
  // 不再有"低于阈值时清空"这一步——用户勾了就生效。
  const many = Array.from({ length: 16 }, (_, i) => ({ name: `mcp__jshook__t${i}`, description: 'd', parameters: null }))
  const config = resolveRuntimeConfig({ deferServers: ['jshook'], serverNames: ['jshook'] })
  const view = buildToolSearchView(many, config)
  assert.equal(view.managed.size, 16)
  assert.deepEqual([...activeMaskedServers(view, new Set())], ['mcp:jshook'], '被延迟的服务器指令段要一并遮掉')

  // 小服务器也照常启用：这是去门槛的核心可观测点（原来 ≤10 工具整台不延迟）。
  const tiny = Array.from({ length: 3 }, (_, i) => ({ name: `mcp__tiny__t${i}`, description: 'd', parameters: null }))
  const tinyView = buildToolSearchView(tiny, resolveRuntimeConfig({ deferServers: ['tiny'], serverNames: ['tiny'] }))
  assert.equal(tinyView.managed.size, 3, '3 工具服务器也必须启用（旧行为是 ≤10 整台不参与）')
  assert.deepEqual([...activeMaskedServers(tinyView, new Set())], ['mcp:tiny'])

  // 混合：大服务器与小服务器都启用，且各自的指令段都遮。
  const mixed = [
    ...many,
    ...Array.from({ length: 8 }, (_, i) => ({ name: `mcp__tiny__t${i}`, description: 'd', parameters: null })),
  ]
  const mixedView = buildToolSearchView(mixed, resolveRuntimeConfig({ deferServers: ['jshook', 'tiny'], serverNames: ['jshook', 'tiny'] }))
  assert.equal(mixedView.managed.size, 24, '两台服务器的工具都受管')
  assert.deepEqual([...activeMaskedServers(mixedView, new Set())].sort(), ['mcp:jshook', 'mcp:tiny'])

  // 不以 defer 的服务器照旧不受管（那是本机制唯一的"不介入"判据）。
  const off = buildToolSearchView(many, resolveRuntimeConfig({ deferServers: [], serverNames: ['jshook'] }))
  assert.equal(off.managed.size, 0)
})

test('deferredTools: D = managed − discovered，未被发现的才算"还有活要干"', () => {
  const managed = new Map(['a', 'b', 'c'].map((name) => [name, { name }]))
  assert.deepEqual([...deferredTools(managed, new Set())], ['a', 'b', 'c'])
  assert.deepEqual([...deferredTools(managed, new Set(['b']))], ['a', 'c'])
  assert.deepEqual([...deferredTools(managed, new Set(['a', 'b', 'c']))], [], '全部发现后 D = ∅')
  // 发现集是 LRU Map（不是 Set）时同样能吃——两处共用同一个定义。
  assert.deepEqual([...deferredTools(managed, new Map([['a', 1]]))], ['b', 'c'])
})

test('filterCatalog + catalogSectionText: 目录只列还没被发现的工具', () => {
  const schemas = Array.from({ length: 16 }, (_, i) => ({ name: `mcp__jshook__t${i}`, description: `tool ${i}`, parameters: null }))
  const view = buildToolSearchView(schemas, resolveRuntimeConfig({ deferServers: ['jshook'], serverNames: ['jshook'] }))
  const discovered = new Set(['mcp__jshook__t0', 'mcp__jshook__t5'])
  const deferred = deferredTools(view.managed, discovered)
  const text = catalogSectionText(filterCatalog(view.catalog, deferred), resolveRuntimeConfig()).text
  assert.equal(text.includes('mcp__jshook__t0'), false, '已发现的工具不该还在"延迟目录"里（F15 的假话）')
  assert.equal(text.includes('mcp__jshook__t5'), false)
  assert.ok(text.includes('mcp__jshook__t1'), '未发现的必须还在目录里')
  assert.ok(text.includes('mcp__jshook__t15'))
})

test('activeMaskedServers: 全部发现后指令段恢复', () => {
  const schemas = Array.from({ length: 16 }, (_, i) => ({ name: `mcp__jshook__t${i}`, description: 'd', parameters: null }))
  const view = buildToolSearchView(schemas, resolveRuntimeConfig({ deferServers: ['jshook'], serverNames: ['jshook'] }))
  const all = new Set(view.managed.keys())
  assert.deepEqual([...activeMaskedServers(view, all)], [], '服务器工具全部被发现后，它的指令段不再占上下文')
})

test('catalogSectionText: 按 code-unit 名序、截断、体积上限带"另有 N 个"', () => {
  const config = resolveRuntimeConfig({ descriptionChars: 10, maxCatalogLines: 3 })
  const catalog = new Map(
    ['b', 'a', 'C', 'd', 'e'].map((k) => [`mcp__${k}__x`, { name: `mcp__${k}__x`, description: 'a very long description here' }]),
  )
  const { text, truncated } = catalogSectionText(catalog, config)
  const lines = text.split('\n')
  assert.equal(lines[0], '## Deferred tool catalog')
  assert.equal(truncated, 2)
  const toolLines = lines.filter((line) => line.startsWith('- '))
  assert.deepEqual(toolLines, ['- mcp__C__x — a very lo…', '- mcp__a__x — a very lo…', '- mcp__b__x — a very lo…'], '超出上限的名字被截掉')
  assert.ok(text.includes('2 more deferred tools are not listed here'), '截断必须提示还有多少，模型才知道要改用关键词查询')
  // code-unit 序：大写 C 在小写字母之前。
  assert.ok(lines.indexOf('- mcp__C__x — a very lo…') < lines.indexOf('- mcp__a__x — a very lo…'))
})

test('maskInstructionSections: 只清空被延迟服务器的指令段，且不改原对象', () => {
  const sections = [
    { name: 'harness:identity', text: 'identity' },
    { name: 'mcp:jshook', text: 'JSHOOK INSTRUCTIONS' },
    { name: 'mcp:firecrawl', text: 'FIRECRAWL INSTRUCTIONS' },
    { name: 'tool-search:catalog', text: 'CATALOG' },
  ]
  const masked = maskInstructionSections(sections, new Set(['mcp:jshook']))
  assert.equal(masked[0], sections[0], '无关段原对象复用')
  assert.equal(masked[1].text, '', '被延迟服务器的指令段清空')
  assert.notEqual(masked[1], sections[1], '必须是新对象——assembly 的段对象可能被别处共享')
  assert.equal(sections[1].text, 'JSHOOK INSTRUCTIONS', '原对象绝不被 mutate')
  assert.equal(masked[2].text, 'FIRECRAWL INSTRUCTIONS')
  assert.equal(masked[3].text, 'CATALOG')
})

test('maskGuidanceSection: 只清空引导段，段里没有它时原样返回', () => {
  // "没事情可做就不碰 assembly"这条惯例的可测形式：没有引导段时必须返回**同一个**
  // 数组，调用方才谈得上零干预（低于阈值的组装本来就不该被本功能改一个字节）。
  const sections = [
    { name: 'harness:identity', text: 'identity' },
    { name: 'tool-search:guidance', text: 'Some tools are deferred…' },
    { name: 'tool-search:catalog', text: 'CATALOG' },
  ]
  const masked = maskGuidanceSection(sections)
  assert.equal(masked[0], sections[0], '无关段原对象复用')
  assert.equal(masked[1].text, '', '引导段清空')
  assert.notEqual(masked[1], sections[1], '必须是新对象——段对象可能被别处共享')
  assert.equal(sections[1].text, 'Some tools are deferred…', '原对象绝不被 mutate')
  assert.equal(masked[2], sections[2], '目录段不受影响')

  const without = [{ name: 'harness:identity', text: 'identity' }]
  assert.equal(maskGuidanceSection(without), without, '没有引导段时原样返回（零干预）')
  const empty = []
  assert.equal(maskGuidanceSection(empty), empty, '空列表同理')
})

test('resolveRuntimeConfig: 缺省、maxDiscovered 下限抬到 maxResults、非法值抛错', () => {
  const config = resolveRuntimeConfig()
  assert.equal(config.toolName, DEFAULTS.toolName)
  assert.equal(config.maxCatalogLines, DEFAULTS.maxCatalogLines)
  // 这两个也对齐 DEFAULTS 而不是复述字面量：字面量一改就红，却证明不了"缺省取自 DEFAULTS"
  // 这件本用例唯一想守的事（同 L207-210 的模式）。
  assert.equal(config.maxResults, DEFAULTS.maxResults)
  assert.equal(config.maxDiscovered, DEFAULTS.maxDiscovered)
  assert.equal(resolveRuntimeConfig({ maxResults: 5, maxDiscovered: 2 }).maxDiscovered, 5)
  // 门槛两键已删除：不再有缺省值，写进来必须**显式报错**（C3：静默忽略会让后人以为它还在生效）。
  assert.equal('threshold' in DEFAULTS, false, 'DEFAULTS 里不得再有 threshold')
  assert.equal('minServerTools' in DEFAULTS, false, 'DEFAULTS 里不得再有 minServerTools')
  assert.throws(() => resolveRuntimeConfig({ threshold: 15 }), /threshold 已废弃/)
  assert.throws(() => resolveRuntimeConfig({ minServerTools: 10 }), /minServerTools 已废弃/)
  assert.throws(() => resolveRuntimeConfig({ maxResults: 1.5 }), /maxResults/)
})

// ── 装配集成（高保真夹具：契约如实，ctx 与 agent 分离）──

function createFixture({ schemas = [], events = [], messages = [], config = {}, throwOnSchemas = false, toolsMode, ptcRuntime } = {}) {
  const handlers = new Map()
  const guards = []
  const sections = []
  const registered = new Map()
  let currentSchemas = schemas.map(stripOutput)
  let schemasCalls = 0
  let getCalls = 0

  // 真宿主的语义：注册之后它才出现在 `schemas(scope)` 里。夹具必须照做——否则
  // "搜索工具自己必须留在手册里"这条断言会因为没有对手而假绿。
  const registerTool = (definition) => {
    registered.set(definition.name, definition)
    currentSchemas = [...currentSchemas, {
      name: definition.name,
      description: definition.description,
      parameters: definition.parameters,
      output: definition.output?.schema,
    }]
    return () => {
      registered.delete(definition.name)
      currentSchemas = currentSchemas.filter((entry) => entry.name !== definition.name)
    }
  }
  // 公开取数路径（F22）：`schemas()` 给 name/description/parameters，逐工具 `get()` 补
  // output.schema。SDK 裁剪走这条路重建宿主的渲染输入。
  const getTool = (name) => {
    getCalls++
    const found = currentSchemas.find((entry) => entry.name === name)
    return found === undefined ? undefined : { name, output: { schema: found.output } }
  }
  const guardTool = (fn) => {
    guards.push(fn)
    return () => {
      const index = guards.indexOf(fn)
      if (index >= 0) guards.splice(index, 1)
    }
  }

  const agent = {
    session: {
      snapshotEvents: () => events,
      deriveMessages: () => messages,
    },
    ctx: {
      tools: {
        schemas: () => {
          schemasCalls++
          if (throwOnSchemas) throw new Error('宿主工具视图不可用')
          return currentSchemas
        },
        get: getTool,
        ...(toolsMode === undefined ? {} : { modeFor: () => toolsMode }),
        register: registerTool,
        guard: guardTool,
      },
    },
  }
  const ctx = {
    // 服务访问走 ctx.get（cordis 对未注入服务的属性访问直接抛错；生产里 system-prompt
    // 恒在，但取用方式必须安全）。shape 同 skillsHost 夹具。
    get: (name) => {
      if (name === 'systemPrompt') return ctx.systemPrompt
      if (name === 'ptcRuntime') return ptcRuntime
      return undefined
    },
    on: (name, handler) => {
      handlers.set(name, handler)
      return () => handlers.delete(name)
    },
    tools: {
      schemas: () => currentSchemas,
      get: getTool,
      ...(toolsMode === undefined ? {} : { modeFor: () => toolsMode }),
      register: registerTool,
      guard: guardTool,
    },
    systemPrompt: {
      section: (section) => {
        sections.push(section)
        return () => sections.splice(sections.indexOf(section), 1)
      },
    },
    logger: { warn: () => {}, error: () => {} },
  }
  return {
    ctx, agent, handlers, guards, sections, registered,
    /** 宿主此刻会渲染出的 `tools:sdk` 原文（可见工具去掉 run_code，每条带 output）。 */
    hostSdkText: () => dshTools.renderToolsSdk(currentSchemas.filter((entry) => entry.name !== 'run_code').map(stripOutput)),
    visibleSchemas: () => currentSchemas,
    setSchemas: (next) => { currentSchemas = next },
    schemasCalls: () => schemasCalls,
    getCalls: () => getCalls,
    cleanup: installToolSearchRuntime(ctx, config),
  }
}

const BIG_SCHEMAS = Array.from({ length: 20 }, (_, index) => ({
  name: `mcp__jshook__tool_${index}`,
  description: `tool number ${index} for browser work`,
  parameters: { type: 'object', properties: { arg: { type: 'string' } } },
  output: { type: 'object', properties: { value: { type: 'number' } } },
}))

/** 宿主渲染 `tools:sdk` 的投影：可见工具去掉 run_code，每条带 output。
 *  测试侧独立拼（不复用生产代码的 readSdkSchemas），前提自检才有意义。 */
const stripOutput = ({ name, description, parameters, output }) => ({ name, description, parameters, output })

const DEFER_CONFIG = { deferServers: ['jshook'], serverNames: ['jshook'] }

const assemble = (fixture, assembly, agent = fixture.agent) =>
  fixture.handlers.get('system-prompt/assemble')(assembly, { agent }, async () => assembly)

test('install: 注册搜索工具、守卫、引导 section，且只订阅 assemble', () => {
  const fixture = createFixture({ schemas: BIG_SCHEMAS, config: DEFER_CONFIG })
  assert.ok(fixture.registered.has('tool_search'))
  assert.equal(fixture.guards.length, 1)
  assert.ok(fixture.sections.some((section) => section.name === 'tool-search:guidance'))
  // agent/created、tools/change、agent/disposed 三个订阅都已移除：视图按 revision 自愈，
  // 预热与脏标记都是冗余门。留着就是"要人记得置"的失配源。
  assert.deepEqual([...fixture.handlers.keys()], ['system-prompt/assemble'])
  fixture.cleanup()
  assert.equal(fixture.registered.size, 0)
  assert.equal(fixture.guards.length, 0)
  assert.equal(fixture.handlers.size, 0)
})

test('assembly 过滤：被管理工具移出，目录 section 追加且不插值，已发现工具保留', async () => {
  const fixture = createFixture({ schemas: BIG_SCHEMAS, config: DEFER_CONFIG })
  const assembly = {
    tools: [{ name: 'Read' }, ...BIG_SCHEMAS.map((schema) => ({ name: schema.name })), { name: 'tool_search' }],
    sections: [{ name: 'persona', text: 'x' }],
  }
  const result = await assemble(fixture, assembly)
  const names = result.tools.map((tool) => tool.name)
  assert.deepEqual(names, ['Read', 'tool_search'])
  const catalog = result.sections.find((section) => section.name === 'tool-search:catalog')
  assert.ok(catalog)
  // 目录正文嵌第三方 MCP 描述：必须 interpolate:false，否则描述里一个 {{var}} 就让
  // 每步 renderPrompt 抛错（宿主给 mcp:<server> 指令段设的就是这个）。
  assert.equal(catalog.interpolate, false)
  assert.equal(result.sections[0].name, 'persona', '原有 section 保持在前')

  // 搜索命中后，同一 agent 的下次组装放行该工具。
  await fixture.registered.get('tool_search').execute({ query: 'tool number 3' }, { agent: fixture.agent })
  const after = await assemble(fixture, assembly)
  assert.ok(after.tools.some((tool) => tool.name === 'mcp__jshook__tool_3'))
  fixture.cleanup()
})

test('assembly 过滤：每次组装只读一次工具视图，且清空被延迟服务器的指令段', async () => {
  const fixture = createFixture({ schemas: BIG_SCHEMAS, config: DEFER_CONFIG })
  const assembly = {
    tools: [{ name: 'Read' }, ...BIG_SCHEMAS.map((schema) => ({ name: schema.name }))],
    sections: [{ name: 'mcp:jshook', text: 'JSHOOK INSTRUCTIONS (up to 32KB)' }, { name: 'mcp:other', text: 'OTHER' }],
  }
  const result = await assemble(fixture, assembly)
  assert.equal(fixture.schemasCalls(), 1, '一次组装只向宿主读一次视图（revision 也靠它算）')
  assert.equal(result.sections.find((s) => s.name === 'mcp:jshook').text, '')
  assert.equal(result.sections.find((s) => s.name === 'mcp:other').text, 'OTHER')
  fixture.cleanup()
})

test('只有 1 个工具的服务器也照常启用（去门槛之后"勾了就生效"）', async () => {
  // 这条替换掉原来的「阈值以下不激活」：旧的聚合阈值 15 与 per-server 下限 10 都已删除（B1/C3）。
  // 现在唯一的判据是"这台服务器被列入 defer 了吗"——极端情形正是原来被门槛挡住的那些：
  // 只有 1 个工具的服务器，用户勾了就必须真的延迟。
  const fixture = createFixture({
    schemas: [{ name: 'mcp__jshook__only', description: 'only one', parameters: null }],
    config: DEFER_CONFIG,
  })
  const assembly = {
    tools: [{ name: 'Read' }, { name: 'mcp__jshook__only' }],
    sections: [{ name: 'tool-search:guidance', text: 'GUIDANCE' }, { name: 'persona', text: 'x' }],
  }
  const result = await assemble(fixture, assembly)
  assert.deepEqual(result.tools.map((tool) => tool.name), ['Read'], '唯一的延迟工具也必须被遮')
  assert.equal(result.sections.some((section) => section.name === 'tool-search:catalog'), true, '目录段要出现（否则模型不知道有这个工具）')
  assert.equal(result.sections.find((section) => section.name === 'tool-search:guidance').text, 'GUIDANCE', '有活要干，引导段保留')
  assert.equal(result.sections.find((section) => section.name === 'persona').text, 'x', '别人的段不受影响')
  assert.equal(typeof fixture.guards[0]({ name: 'mcp__jshook__only', agent: fixture.agent }), 'string', '守卫也必须生效')
  fixture.cleanup()
})

test('引导段跟着活状态显隐：同一进程里翻 defer，不用重装', async () => {
  // P2 的核心：条件判断必须在**组装层**。section() 是启动时一次性注册，而 defer 是活
  // 状态（面板开关、服务器晚连都会改）。这里用同一个 fixture、同一个 agent，只翻活配置，
  // 证明引导段跟着走——注册时判一次的话，这里第二次断言必然还是旧值。
  let defer = true
  const fixture = createFixture({ schemas: BIG_SCHEMAS, config: { deferServers: () => (defer ? ['jshook'] : []), serverNames: ['jshook'] } })
  try {
    const assembly = { tools: [], sections: [{ name: 'tool-search:guidance', text: 'GUIDANCE' }] }
    const on = await assemble(fixture, assembly)
    assert.equal(on.sections.find((section) => section.name === 'tool-search:guidance').text, 'GUIDANCE', '有东西被延迟时引导段保留')
    assert.ok(on.sections.some((section) => section.name === 'tool-search:catalog'), '同时追加活库存目录')

    defer = false
    const off = await assemble(fixture, assembly)
    assert.equal(off.sections.find((section) => section.name === 'tool-search:guidance').text, '', '一个都不延迟时引导段必须摘掉')
    assert.equal(off.sections.some((section) => section.name === 'tool-search:catalog'), false, '目录段同步消失')

    defer = true
    const back = await assemble(fixture, assembly)
    assert.equal(back.sections.find((section) => section.name === 'tool-search:guidance').text, 'GUIDANCE', '再打开必须回来（不能只摘不补）')
  } finally {
    fixture.cleanup()
  }
})

test('D = ∅（全部发现）：目录段、引导段、指令段遮罩一起消失', async () => {
  // B11/B14 的验收，也是 F15 的复发闸门：修复前目录列的是 `managed` 全集、引导看的是
  // `deferring`，所以"全部发现"之后模型仍会读到「The tools below stay deferred」与
  // 「Some tools are deferred」——两句话都是假的。
  const fixture = createFixture({ schemas: BIG_SCHEMAS, config: DEFER_CONFIG })
  try {
    const assembly = {
      tools: BIG_SCHEMAS.map((schema) => ({ name: schema.name })),
      sections: [
        { name: 'tool-search:guidance', text: 'GUIDANCE' },
        { name: 'mcp:jshook', text: 'JSHOOK INSTRUCTIONS' },
      ],
    }
    const before = await assemble(fixture, assembly)
    assert.ok(before.sections.some((section) => section.name === 'tool-search:catalog'), '有未发现的工具时目录在')
    assert.equal(before.sections.find((section) => section.name === 'mcp:jshook').text, '')

    // 全部发现。
    const tool = fixture.registered.get('tool_search')
    await tool.execute({ query: `select:${BIG_SCHEMAS.map((schema) => schema.name).join(',')}` }, { agent: fixture.agent })

    const after = await assemble(fixture, assembly)
    assert.equal(after.sections.some((section) => section.name === 'tool-search:catalog'), false, 'D = ∅ 时不得再注入目录段')
    assert.equal(after.sections.find((section) => section.name === 'tool-search:guidance').text, '', 'D = ∅ 时引导段也必须摘掉')
    assert.equal(after.sections.find((section) => section.name === 'mcp:jshook').text, 'JSHOOK INSTRUCTIONS', '全部发现后指令段恢复')
    assert.deepEqual(after.tools.map((entry) => entry.name), assembly.tools.map((entry) => entry.name), '工具全部回到清单')
  } finally {
    fixture.cleanup()
  }
})

test('目录只列还没被发现的工具，且按 (revision, discoveredVersion) 缓存', async () => {
  const fixture = createFixture({ schemas: BIG_SCHEMAS, config: DEFER_CONFIG })
  try {
    const assembly = { tools: [], sections: [] }
    const first = (await assemble(fixture, assembly)).sections.find((section) => section.name === 'tool-search:catalog').text
    const again = (await assemble(fixture, assembly)).sections.find((section) => section.name === 'tool-search:catalog').text
    assert.equal(first, again, '同一状态下目录必须是同一份字节（缓存命中，前缀稳定）')

    const tool = fixture.registered.get('tool_search')
    await tool.execute({ query: 'select:mcp__jshook__tool_0' }, { agent: fixture.agent })
    const afterDiscover = (await assemble(fixture, assembly)).sections.find((section) => section.name === 'tool-search:catalog').text
    assert.equal(afterDiscover.includes('mcp__jshook__tool_0'), false, '已发现的工具必须离开目录（D 过滤）')
    assert.ok(afterDiscover.includes('mcp__jshook__tool_1'))

    // LRU 刷新（touch）不改成员 ⇒ 目录文本不该失效（versionOf 不动），字节必须完全一致。
    fixture.guards[0]({ name: 'mcp__jshook__tool_0', agent: fixture.agent })
    const afterTouch = (await assemble(fixture, assembly)).sections.find((section) => section.name === 'tool-search:catalog').text
    assert.equal(afterTouch, afterDiscover, 'touch 不该让目录文本缓存失效')
  } finally {
    fixture.cleanup()
  }
})

// ── S5：装配时裁 SDK 手册（PTC 下唯一真正省字的地方）──

const PTC_RUNTIME = { language: 'typescript' }

/** PTC 形状的组装：函数清单只剩 run_code（wireSchemas 的 collapse），手册段才是工具面。 */
const ptcAssembly = (fixture) => ({
  tools: [{ name: 'run_code' }],
  sections: [{ name: 'tools:sdk', text: fixture.hostSdkText(), interpolate: false }, { name: 'persona', text: 'x' }],
})

const sdkTextOf = (result) => result.sections.find((section) => section.name === 'tools:sdk').text

test('裁手册：PTC agent 的 tools:sdk 不含未发现的延迟工具，kept 的还在', async () => {
  const fixture = createFixture({ schemas: BIG_SCHEMAS, config: DEFER_CONFIG, ptcRuntime: PTC_RUNTIME })
  try {
    const hostText = fixture.hostSdkText()
    const result = await assemble(fixture, ptcAssembly(fixture))
    const text = sdkTextOf(result)
    assert.notEqual(text, hostText, '必须真的裁过（前提自检通过才会走到这里）')
    assert.equal(text.includes('mcp__jshook__tool_0'), false, '未发现的延迟工具不得出现在手册里')
    assert.ok(text.includes('tool_search'), '搜索工具自己必须留在手册里（B6：它是模型唯一的入口）')
    // 裁剪结果必须**正是宿主渲染器对"保留项"的输出**，而不是别处拼出来的文本：
    // 测试侧独立拼一份期望值（去掉 20 个延迟工具，保留 tool_search），逐字节比。
    const expected = dshTools.renderToolsSdk(
      fixture.visibleSchemas()
        .filter((entry) => !entry.name.startsWith('mcp__jshook__'))
        .map(stripOutput),
    )
    assert.equal(text, expected, '裁剪结果必须是宿主渲染器对保留项的输出（逐字节）')
    assert.ok(text.length < hostText.length, '裁完必须更短，否则这个功能没有意义')
  } finally {
    fixture.cleanup()
  }
})

test('裁手册：同进程的 native agent 一个字节都不动（模式判据是 per-agent 的）', async () => {
  const fixture = createFixture({ schemas: BIG_SCHEMAS, config: DEFER_CONFIG, ptcRuntime: PTC_RUNTIME })
  try {
    // native 形状：清单里有真实工具（不是 run_code），且手册段仍给了文本——
    // 这是最严格的对造：段文本并非空，只能靠**模式**判据区分。
    const hostText = fixture.hostSdkText()
    const native = await assemble(fixture, {
      tools: [{ name: 'Read' }, ...BIG_SCHEMAS.map((entry) => ({ name: entry.name }))],
      sections: [{ name: 'tools:sdk', text: hostText, interpolate: false }],
    })
    assert.equal(sdkTextOf(native), hostText, 'native 会话的手册必须原样放行')
    // 遮罩照旧（native 的有效面是函数清单）。
    assert.equal(native.tools.some((tool) => tool.name === 'mcp__jshook__tool_0'), false, 'native 下遮罩必须照旧')
  } finally {
    fixture.cleanup()
  }
})

test('裁手册：requireDiscovery: false 时不裁（B12）', async () => {
  // 守卫在 requireDiscovery:false 时直接放行，若再把签名裁掉就是"藏了签名却允许盲调"——
  // 正是本项目定性为不可接受的半失效。
  const fixture = createFixture({
    schemas: BIG_SCHEMAS,
    config: { ...DEFER_CONFIG, requireDiscovery: false },
    ptcRuntime: PTC_RUNTIME,
  })
  try {
    const hostText = fixture.hostSdkText()
    const result = await assemble(fixture, ptcAssembly(fixture))
    assert.equal(sdkTextOf(result), hostText, '允许盲调时手册必须保持完整')
  } finally {
    fixture.cleanup()
  }
})

test('裁手册：前提自检失败就退回原文（别处改写过段文本）', async () => {
  const fixture = createFixture({ schemas: BIG_SCHEMAS, config: DEFER_CONFIG, ptcRuntime: PTC_RUNTIME })
  try {
    const tampered = fixture.hostSdkText().replace('tool number 0', 'tool number zero')
    const result = await assemble(fixture, { tools: [{ name: 'run_code' }], sections: [{ name: 'tools:sdk', text: tampered }] })
    assert.equal(sdkTextOf(result), tampered, '自检失败必须原样放行——不猜、不发坏文本')
  } finally {
    fixture.cleanup()
  }
})

test('裁手册：段文本为空时短路，不白跑一次全集重渲染', async () => {
  // PTC 部署下的 native agent 就是这样：段存在但 `sdkSection` 对 native 返回 ''。
  // 此时 render(全集) !== '' 会命中 premise-mismatch —— 白跑一趟（701 工具 15ms）。
  const fixture = createFixture({ schemas: BIG_SCHEMAS, config: DEFER_CONFIG, ptcRuntime: PTC_RUNTIME })
  try {
    const before = fixture.getCalls()
    await assemble(fixture, { tools: [{ name: 'run_code' }], sections: [{ name: 'tools:sdk', text: '' }] })
    assert.equal(fixture.getCalls(), before, '空文本必须在取数之前短路（否则每次装配都付一次 O(n²)）')
  } finally {
    fixture.cleanup()
  }
})

test('both 模式：全 inert——不遮罩、不加目录、不摘引导、不裁手册', async () => {
  // B4/§11.4：`both` 是**唯一** inert 的取值。技术上皮革在这里完全能生效（遮罩有效、手册可裁），
  // 不做的理由只有一条：0.2.1 已删除该模式（V1），为将死的功能写行为不划算。
  const fixture = createFixture({ schemas: BIG_SCHEMAS, config: DEFER_CONFIG, toolsMode: 'both', ptcRuntime: PTC_RUNTIME })
  try {
    const hostText = fixture.hostSdkText()
    const assembly = {
      tools: [{ name: 'run_code' }, ...BIG_SCHEMAS.map((entry) => ({ name: entry.name }))],
      sections: [{ name: 'tools:sdk', text: hostText }, { name: 'tool-search:guidance', text: 'GUIDANCE' }],
    }
    const result = await assemble(fixture, assembly)
    assert.equal(result, assembly, 'both 下必须**原样返回同一个对象**（一处都不碰）')
    assert.equal(sdkTextOf(result), hostText, '手册不得被裁')
    assert.equal(result.tools.length, assembly.tools.length, '工具不得被遮')
    assert.equal(fixture.guards[0]({ name: 'mcp__jshook__tool_0', agent: fixture.agent }), undefined, '守卫必须放行')
  } finally {
    fixture.cleanup()
  }
})

test('ptc 模式：必须启用（把 inert 判据写成"非 native"会在这里红）', async () => {
  // 这条是 S6 的护栏：正确判据是"只有 both 才 inert"。写成 `mode !== 'native'` 会让 PTC
  // 会话连目录/引导/守卫都没有——那等于把这个功能最大的受益面关掉。
  const fixture = createFixture({ schemas: BIG_SCHEMAS, config: DEFER_CONFIG, toolsMode: 'ptc', ptcRuntime: PTC_RUNTIME })
  try {
    const assembly = {
      tools: [{ name: 'run_code' }],
      sections: [{ name: 'tools:sdk', text: fixture.hostSdkText() }, { name: 'tool-search:guidance', text: 'GUIDANCE' }],
    }
    const result = await assemble(fixture, assembly)
    assert.ok(result.sections.some((section) => section.name === 'tool-search:catalog'), 'ptc 下必须追加目录段')
    assert.equal(result.sections.find((section) => section.name === 'tool-search:guidance').text, 'GUIDANCE', 'ptc 下有活要干，引导段保留')
    assert.notEqual(sdkTextOf(result), fixture.hostSdkText(), 'ptc 下必须裁手册')
    assert.equal(typeof fixture.guards[0]({ name: 'mcp__jshook__tool_0', agent: fixture.agent }), 'string', 'ptc 下守卫必须生效')
  } finally {
    fixture.cleanup()
  }
})

test('裁手册：已发现的工具必须留在手册里', async () => {
  const fixture = createFixture({ schemas: BIG_SCHEMAS, config: DEFER_CONFIG, ptcRuntime: PTC_RUNTIME })
  try {
    await fixture.registered.get('tool_search').execute({ query: 'select:mcp__jshook__tool_3' }, { agent: fixture.agent })
    const text = sdkTextOf(await assemble(fixture, ptcAssembly(fixture)))
    assert.ok(text.includes('mcp__jshook__tool_3'), '发现的工具必须回到手册（模型要能写程序调它）')
    assert.equal(text.includes('mcp__jshook__tool_4'), false)
  } finally {
    fixture.cleanup()
  }
})

test('fail-open：宿主视图抛错时退回全量可见，不炸会话', async () => {
  // ToolSearch 是优化不是正确性机制。算不出视图就回到 feature 前的行为并记账，
  // 而不是让 assemble/guard 抛错——那会否决建会话或让 agent loop 每步失败。
  const fixture = createFixture({ schemas: BIG_SCHEMAS, config: DEFER_CONFIG, throwOnSchemas: true })
  const assembly = {
    tools: [{ name: 'Read' }, { name: 'mcp__jshook__tool_0' }],
    sections: [{ name: 'tool-search:guidance', text: 'GUIDANCE' }],
  }
  const result = await assemble(fixture, assembly)
  assert.deepEqual(result.tools.map((tool) => tool.name), ['Read', 'mcp__jshook__tool_0'], '视图不可用时工具一个都不遮')
  assert.equal(result.sections.some((section) => section.name === 'tool-search:catalog'), false)
  // fail-open 视图的 deferring 是 false，所以引导段同样摘掉——此时确实没有任何工具被延迟。
  assert.equal(result.sections.find((section) => section.name === 'tool-search:guidance').text, '')
  assert.equal(fixture.guards[0]({ name: 'mcp__jshook__tool_0', agent: fixture.agent }), undefined)
  const value = await fixture.registered.get('tool_search').execute({ query: 'browser' }, { agent: fixture.agent })
  assert.deepEqual(value.matches, [])
  assert.ok(value.instruction.includes('No tool matched'))
  fixture.cleanup()
})

test('搜索工具：命中即激活，返回完整 schema 与 meta 协议', async () => {
  const fixture = createFixture({ schemas: BIG_SCHEMAS, config: DEFER_CONFIG })
  const definition = fixture.registered.get('tool_search')
  const value = await definition.execute({ query: 'select:mcp__jshook__tool_7' }, { agent: fixture.agent })
  assert.equal(value.protocol, 'dsh-tool-search/v1')
  assert.equal(value.matches.length, 1)
  assert.equal(value.matches[0].name, 'mcp__jshook__tool_7')
  assert.deepEqual(value.matches[0].parameters, { type: 'object', properties: { arg: { type: 'string' } } })
  assert.deepEqual(value.discoveredTools, ['mcp__jshook__tool_7'])
  assert.deepEqual(value.allDiscoveredTools, ['mcp__jshook__tool_7'])
  // meta 带累积列表，render 剥掉（不泄回提示词）。
  const meta = definition.output.presentationMeta({}, value)
  assert.deepEqual(meta.allDiscoveredTools, ['mcp__jshook__tool_7'])
  const rendered = definition.output.render({}, value)
  assert.equal(JSON.parse(rendered[0].text).allDiscoveredTools, undefined)
  assert.equal(JSON.parse(rendered[0].text).matches.length, 1)
  fixture.cleanup()
})

test('搜索工具：select 不存在时报 found:false 且不激活', async () => {
  const fixture = createFixture({ schemas: BIG_SCHEMAS, config: DEFER_CONFIG })
  const value = await fixture.registered.get('tool_search').execute({ query: 'select:mcp__jshook__ghost' }, { agent: fixture.agent })
  assert.equal(value.matches[0].found, false)
  assert.deepEqual(value.discoveredTools, [])
  assert.equal(value.discoveredCount, 0)
  fixture.cleanup()
})

test('守卫：未发现拒绝并附指引，搜索后放行', async () => {
  const fixture = createFixture({ schemas: BIG_SCHEMAS, config: DEFER_CONFIG })
  const guard = fixture.guards[0]
  const denial = guard({ name: 'mcp__jshook__tool_2', agent: fixture.agent })
  assert.equal(typeof denial, 'string')
  assert.ok(denial.includes('tool_search'))
  await fixture.registered.get('tool_search').execute({ query: 'tool number 2' }, { agent: fixture.agent })
  assert.equal(guard({ name: 'mcp__jshook__tool_2', agent: fixture.agent }), undefined)
  // 不是本机制管理的工具守卫不置词。
  assert.equal(guard({ name: 'Read', agent: fixture.agent }), undefined)
  // 无 agent 的执行不拦截（分类不了就不管）。
  assert.equal(guard({ name: 'mcp__jshook__tool_2' }), undefined)
  fixture.cleanup()
})

test('maxDiscovered 上限：无界发现被最旧淘汰', async () => {
  const fixture = createFixture({
    schemas: BIG_SCHEMAS,
    // maxResults 2 时 maxDiscovered 下限被抬到 2；配 3 得到上限 3。
    config: { ...DEFER_CONFIG, maxResults: 2, maxDiscovered: 3 },
  })
  const tool = fixture.registered.get('tool_search')
  let value
  for (let index = 0; index < 5; index++) {
    value = await tool.execute({ query: `select:mcp__jshook__tool_${index}` }, { agent: fixture.agent })
  }
  assert.equal(value.discoveredCount, 3)
  assert.deepEqual(value.allDiscoveredTools, ['mcp__jshook__tool_2', 'mcp__jshook__tool_3', 'mcp__jshook__tool_4'])
  fixture.cleanup()
})

test('maxDiscovered 上限：单批 select 超过上限时不得淘汰本批', async () => {
  // 与上一条互补：上一条一次加一个名字（cap 正常生效），这条一次加 5 个（> cap=3）。
  // 淘汰下限必须抬到本批长度，否则本批靠前的名字在**同一条结果里**就被淘汰，
  // discoveredCount 会小于 discoveredTools.length，模型按 instruction 直调必被守卫拒。
  const fixture = createFixture({
    schemas: BIG_SCHEMAS,
    config: { ...DEFER_CONFIG, maxResults: 2, maxDiscovered: 3 },
  })
  const tool = fixture.registered.get('tool_search')
  const batch = [0, 1, 2, 3, 4].map((index) => `mcp__jshook__tool_${index}`)
  const value = await tool.execute({ query: `select:${batch.join(',')}` }, { agent: fixture.agent })
  assert.equal(value.discoveredTools.length, batch.length)
  assert.equal(value.discoveredCount, batch.length, '本批不得被自己的上限淘汰')
  // 下一次搜索按正常上限回落（淘汰最旧），上限仍然是"长期常驻"的护栏。
  // 6 个名字、cap 3 → 淘汰 3 个最旧的（tool_0..tool_2），剩下的照常存活。
  const after = await tool.execute({ query: 'select:mcp__jshook__tool_9' }, { agent: fixture.agent })
  assert.equal(after.discoveredCount, 3, '下一批按 cap 回落')
  assert.deepEqual(after.allDiscoveredTools, ['mcp__jshook__tool_3', 'mcp__jshook__tool_4', 'mcp__jshook__tool_9'])
  fixture.cleanup()
})

test('晚连服务器：工具后出现，同一次组装里就被滤掉（无窗口）', async () => {
  const fixture = createFixture({ schemas: BIG_SCHEMAS, config: DEFER_CONFIG })
  fixture.setSchemas([...BIG_SCHEMAS, { name: 'mcp__jshook__late', description: 'late arrival', parameters: null }])
  const assembly = { tools: [{ name: 'Read' }, { name: 'mcp__jshook__late' }], sections: [] }
  const result = await assemble(fixture, assembly)
  assert.deepEqual(result.tools.map((tool) => tool.name), ['Read'])
  fixture.cleanup()
})

test('resume：从会话派生消息恢复发现集，恢复的工具直接可见', async () => {
  const messages = [
    { role: 'user', content: [{ type: 'text', text: 'go' }] },
    {
      role: 'tool',
      toolCallId: 'c1',
      isError: false,
      source: { kind: 'tool', callId: 'c1' },
      content: [{ type: 'text', text: JSON.stringify({ protocol: 'dsh-tool-search/v1', discoveredTools: ['mcp__jshook__tool_5'] }) }],
    },
  ]
  const fixture = createFixture({ schemas: BIG_SCHEMAS, messages, config: DEFER_CONFIG })
  const assembly = { tools: [{ name: 'Read' }, ...BIG_SCHEMAS.map((schema) => ({ name: schema.name }))], sections: [] }
  const result = await assemble(fixture, assembly)
  assert.ok(result.tools.some((tool) => tool.name === 'mcp__jshook__tool_5'), 'resume 后恢复的发现应直接可见')
  fixture.cleanup()
})

test('agent-less 执行：显式失败，不静默', async () => {
  const fixture = createFixture({ schemas: BIG_SCHEMAS, config: DEFER_CONFIG })
  await assert.rejects(
    fixture.registered.get('tool_search').execute({ query: 'browser' }, {}),
    /agent-scoped/,
  )
  fixture.cleanup()
})

test('活配置：deferServers 函数形态，开关变化即生效（不重装）', async () => {
  let deferred = ['jshook']
  const fixture = createFixture({
    schemas: BIG_SCHEMAS,
    config: { deferServers: () => deferred, serverNames: () => ['jshook'] },
  })
  const assembly = { tools: [{ name: 'Read' }, { name: 'mcp__jshook__tool_0' }], sections: [] }
  // 开着：tool_0 被滤掉。
  const filtered = await assemble(fixture, assembly)
  assert.deepEqual(filtered.tools.map((tool) => tool.name), ['Read'])
  // 用户关掉开关：下一次组装读到新配置，零干预（同一个对象）。
  deferred = []
  const passthrough = await assemble(fixture, assembly)
  assert.equal(passthrough, assembly)
  // 再打开：重新过滤。
  deferred = ['jshook']
  const refiltered = await assemble(fixture, assembly)
  assert.deepEqual(refiltered.tools.map((tool) => tool.name), ['Read'])
  fixture.cleanup()
})

test('viewRevision: stem 开关必须进 revision，否则翻转开关视图不重建', () => {
  // stem 改变的是 documentTokens/nameTokens 的切分结果，直接影响目录与排序。
  // 若它不进 revision，viewCache 会认为"没变化"而继续用旧视图——开关翻转静默失效。
  const schemas = [{ name: 'mcp__jshook__tool_0', description: 'a tool', parameters: null }]
  const base = resolveRuntimeConfig({ deferServers: ['jshook'], serverNames: ['jshook'] })
  const on = { ...base, stem: true }
  const off = { ...base, stem: false }
  assert.notEqual(viewRevision(schemas, on), viewRevision(schemas, off), 'stem 不同 → revision 必须不同')
  assert.equal(viewRevision(schemas, on), viewRevision(schemas, { ...base, stem: true }), '同开关 → revision 仍须相同（缓存有效）')
})

test('resolveRuntimeConfig: stem 缺省开、显式 false 能关掉', () => {
  assert.equal(resolveRuntimeConfig().stem, true, '缺省开：两个真实工具集实测零误伤')
  assert.equal(resolveRuntimeConfig({ stem: false }).stem, false, '显式 false 必须能关（Harman 1991 证明某些语料无收益）')
  assert.equal(resolveRuntimeConfig({ stem: true }).stem, true)
})

test('视图按 revision 缓存：配置与工具都不变时不重建，描述变了才重建', async () => {
  const fixture = createFixture({ schemas: BIG_SCHEMAS, config: DEFER_CONFIG })
  const assembly = { tools: [{ name: 'Read' }, { name: 'mcp__jshook__tool_0' }], sections: [] }
  const first = await assemble(fixture, assembly)
  const second = await assemble(fixture, assembly)
  assert.equal(first.sections.at(-1).text, second.sections.at(-1).text, '库存不变则目录字节稳定')
  // 描述变了（同名、内容不同）→ revision 变 → 目录跟着变。
  fixture.setSchemas(BIG_SCHEMAS.map((s) => (s.name === 'mcp__jshook__tool_0' ? { ...s, description: 'EDITED' } : s)))
  const third = await assemble(fixture, assembly)
  assert.ok(third.sections.at(-1).text.includes('EDITED'), '内容变化必须被 revision 捕捉')
  fixture.cleanup()
})
