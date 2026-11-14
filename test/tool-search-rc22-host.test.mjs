import assert from 'node:assert/strict'
import test from 'node:test'
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import { createScope } from '@deepseek-ai/dsh-scope'
import Tools from '@deepseek-ai/dsh-tools'
import { installToolSearchRuntime } from '../lib/tool-search-runtime.js'
import { probeHost } from '../lib/tool-search-host.js'
import { detectToolsGeneration } from '../lib/tool-search-adapter.js'

const TEST_TIMEOUT_MS = 60_000
const require = createRequire(import.meta.url)
const toolsRequire = createRequire(require.resolve('@deepseek-ai/dsh-tools'))
const hasNewHost = typeof Tools.prototype.definitions === 'function'
  && typeof Tools.prototype.resolve === 'function'
const importHost = async (name) => import(pathToFileURL(require.resolve(name)).href)

// A missing package in a modern fixture is an installation failure, never a reason to skip.
// Old hosts do not resolve either executor (or the CLI metapackage) at module load time.
if (process.env.DSH_EXPECT_STEP_TOOLSET === '1') {
  assert.equal(hasNewHost, true, 'this fixture must exercise the step-owned toolSet host')
}
const MODERN = { timeout: TEST_TIMEOUT_MS, skip: !hasNewHost && 'legacy host has no step-owned toolSet' }

const output = {
  schema: { type: 'object', additionalProperties: true },
  render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
}
const MODEL = { provider: 'fixture', model: 'no-model-call' }
const signal = () => AbortSignal.timeout(TEST_TIMEOUT_MS)

const definitionOf = (name, description) => ({
  name,
  description,
  parameters: { type: 'object', properties: { text: { type: 'string' } } },
  output,
  async execute() { return { tool: name } },
})

/**
 * 给一个 agent 建作用域 ctx。必须从**已注入 tools 的 ctx** 上建：cordis 对未注入服务的
 * 属性访问直接抛错（`agent.ctx.tools` 在真实宿主里恒可用，因为 loop 的 ctx 带 tools）。
 */
async function scopeAgent(ctx, agent) {
  await new Promise((resolve) => {
    ctx.inject(['tools'], (toolCtx) => {
      const scope = createScope(toolCtx, agent)
      agent.ctx = scope.ctx
      agent.scope = scope
      resolve()
    })
  })
  return agent.scope
}

/**
 * 现代（0.2.2-rc.1）真实宿主夹具：真 Context / SystemPrompt / Tools / executor。
 *
 * 与旧代最大的差别正是本文件要验的那件事：**工具声明不在 waterfall 载荷里**，
 * 宿主在 waterfall 之后才把 provider-owned 的 `tools` 贴回最终 assembly。所以必须
 * 在 `systemPrompt.assemble()` 返回之后投影，否则目录段会出现、声明一个都不会少。
 */
async function createHost({ presentation = 'native', deferral = true } = {}) {
  const [{ default: SystemPrompt }, executorModule] = await Promise.all([
    import(pathToFileURL(toolsRequire.resolve('@deepseek-ai/dsh-system-prompt')).href),
    importHost(presentation === 'ptc' ? '@deepseek-ai/dsh-tool-executor-ptc' : '@deepseek-ai/dsh-tool-executor-native'),
  ])
  assert.equal(typeof executorModule.apply, 'function', `${presentation} executor plugin must be installed`)
  const ctx = new Context()
  ctx.provide('loader', { import: importHost })
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(Tools)
  // PTC 会话需要 ptcRuntime：宿主的 sdkSection / wireSchemas 都要求它存在。
  if (presentation === 'ptc') ctx.provide('ptcRuntime', { language: 'typescript', programFormat: 'typescript' })
  await ctx.plugin(executorModule, {})

  const tools = ctx.get('tools')
  const systemPrompt = ctx.get('systemPrompt')
  // 全局族：所有 agent 都看得到（deferServers 只按名字前缀，不区分注册层）。
  for (const name of ['alpha', 'beta']) tools.register(definitionOf(`mcp__rc22__${name}`, `RC22 ${name} fixture tool`))
  // when=false 的工具：绝不能进目录/搜索结果。全局层注册，模拟条件工具。
  tools.register(definitionOf('mcp__rc22__conditional', 'RC22 conditional tool'), { when: () => false })

  const agent = { id: `rc22-${presentation}`, session: { id: `s-${presentation}`, header: { cwd: '/ws/a' }, deriveMessages: () => [] } }
  const scope = await scopeAgent(ctx, agent)
  // 同作用域覆盖：agent 自己注册的同名工具必须胜出，且声明/目录/执行三处一致。
  agent.ctx.tools.register(definitionOf('mcp__rc22__alpha', 'RC22 alpha OWN-scope override'))

  const dispose = installToolSearchRuntime(ctx, {
    // deferral=false：一台延迟的服务器都没有——模型不该看见搜索入口（issue #9）。
    deferServers: deferral ? ['rc22'] : [],
    serverNames: ['rc22'],
    policyFor: () => undefined,
  })
  const admit = (target = agent) => tools.resolve({ agent: target, modelSelection: MODEL, signal: signal() })
  const assemble = (target, toolSet) => systemPrompt.assemble({
    agent: target, scope: target, signal: signal(), modelSelection: MODEL, toolSet,
  })
  const search = async (target, toolSet, query) => {
    const definition = tools.get('tool_search', target, toolSet)
    assert.ok(definition, 'tool_search must be registered')
    return definition.execute({ query }, { agent: target, toolSet })
  }
  return {
    ctx, tools, agent, scope, systemPrompt, dispose, admit, assemble, search,
    names: (assembly) => assembly.tools.map((tool) => tool.name),
    // 0.2.2-rc.3 起 `checkGuards()` 返回 `{ reason }` 而不是裸字符串（宿主把拒绝理由结构化），
    // 这里只取 reason：下面两条断言要的是"拒绝理由里写了 deferred"与"通过时是 undefined"。
    guard: (target, name, toolSet) => tools.checkGuards({ name, agent: target, toolSet })?.reason,
    cleanup: async () => { dispose(); await scope.dispose() },
  }
}

test('npm 0.2.2-rc.1: native 声明先隐藏、搜索后出现，when=false 与 scope 覆盖不泄漏', MODERN, async () => {
  const host = await createHost({ presentation: 'native' })
  let admission
  try {
    assert.equal(detectToolsGeneration(host.tools).generation, 'modern')
    assert.equal(probeHost(host.ctx).definitions, true)
    admission = await host.admit()

    const before = await host.assemble(host.agent, admission)
    const beforeNames = host.names(before)
    assert.equal(beforeNames.includes('mcp__rc22__alpha'), false, '延迟工具在搜索前不得出现在最终 assembly 里')
    assert.equal(beforeNames.includes('mcp__rc22__beta'), false)
    assert.equal(beforeNames.includes('mcp__rc22__conditional'), false, 'when=false 从一开始就不在准入里')
    assert.ok(beforeNames.includes('tool_search'), '搜索入口必须常驻')
    const catalog = before.sections.find((section) => section.name === 'tool-search:catalog')
    assert.ok(catalog, '搜索前必须给出目录段')
    assert.match(catalog.text, /^- alpha$/m)
    assert.match(catalog.text, /^- beta$/m)
    assert.doesNotMatch(catalog.text, /conditional/, 'when=false 不得进目录（它不在准入里）')
    assert.match(host.guard(host.agent, 'mcp__rc22__beta', admission) ?? '', /deferred/)

    // 同一个准入根里搜索：返回完整 schema，且立刻可调用。
    const result = await host.search(host.agent, admission, 'select:mcp__rc22__beta')
    assert.equal(result.matches[0].name, 'mcp__rc22__beta')
    assert.equal(typeof result.matches[0].parameters, 'object', '命中必须带完整 schema')
    assert.match(result.instruction, /Do not search again/, '命中回执必须叫模型直接调用')
    assert.equal(host.guard(host.agent, 'mcp__rc22__beta', admission), undefined, '搜索成功后同一个准入根内必须可调用')
    assert.ok(host.tools.executable('mcp__rc22__beta', host.agent, admission), '注册与准入都没动过：搜索不重注册（PTC 绑定靠这条）')

    const after = await host.assemble(host.agent, admission)
    assert.ok(host.names(after).includes('mcp__rc22__beta'), '发现后必须出现在声明里')
    assert.equal(host.names(after).includes('mcp__rc22__alpha'), false, '没搜到的仍然隐藏')

    // scope 同名覆盖：发现后露出的必须是 own scope 的那份定义。
    await host.search(host.agent, admission, 'select:mcp__rc22__alpha')
    const override = await host.assemble(host.agent, admission)
    assert.ok(host.names(override).includes('mcp__rc22__alpha'))
    assert.equal(host.guard(host.agent, 'mcp__rc22__alpha', admission), undefined)
    assert.match(host.tools.get('mcp__rc22__alpha', host.agent, admission).description, /OWN-scope override/)
  } finally {
    admission?.dispose()
    await host.cleanup()
  }
})

test('npm 0.2.2-rc.1: 没有任何延迟工具时，搜索入口与目录段一起不出现（issue #9）', MODERN, async () => {
  // 用户报的现象：MCP 全部禁用后 `tool_search` 还在，模型看见就去搜一次空目录。
  // 这里用同一套真宿主夹具、只把"有延迟服务器"这一条去掉。
  const host = await createHost({ deferral: false })
  try {
    const admission = await host.admit()
    const assembly = await host.assemble(host.agent, admission)
    const names = host.names(assembly)
    assert.equal(names.includes('tool_search'), false,
      '没有可搜的工具时不得把搜索入口发给模型（issue #9）')
    // 其余工具一个都不能少：这是"没有东西可搜"，不是"把工具藏起来"。
    assert.ok(names.includes('mcp__rc22__alpha') && names.includes('mcp__rc22__beta'),
      '没有延迟工具时所有工具都该常驻可见')
    assert.equal(assembly.sections.some((section) => section.name === 'tool-search:catalog'), false,
      '没有延迟工具时不该有目录段')
    const guidance = assembly.sections.find((section) => section.name === 'tool-search:guidance')
    assert.ok(guidance === undefined || guidance.text === '', '引导段不得再声称"有工具被延迟"')
    // 搜索工具本身仍注册在宿主里（只是不发给模型）：一旦有工具被延迟，下一次组建立刻又出现。
    assert.ok(host.tools.schemas().some((schema) => schema.name === 'tool_search'), '搜索工具仍应注册在宿主')
  } finally {
    await host.cleanup()
  }
})

test('npm 0.2.2-rc.1: 没有延迟工具时 PTC 手册里也不出现搜索入口（issue #9 的另一半）', MODERN, async () => {
  // PTC 下模型看的不是函数清单而是 `tools:sdk` 手册——手册里留着 tool_search，模型照样会去搜。
  // 这一条用真宿主 + 真 executor + 真手册渲染器验"摘掉"这件事真的发生了（不是只在代码里推断）。
  const host = await createHost({ presentation: 'ptc', deferral: false })
  try {
    const admission = await host.admit()
    const assembly = await host.assemble(host.agent, admission)
    assert.deepEqual(host.names(assembly), ['run_code'], 'PTC 声明里只应有 run_code')
    const sdk = assembly.sections.find((section) => section.name === 'tools:sdk')
    assert.ok(sdk, 'PTC 必须有 tools:sdk 段')
    assert.equal(sdk.text.includes('tool_search'), false,
      '没有可搜的工具时，手册里也不得出现搜索入口（否则模型照样会照着手册去搜）')
    // 其余工具的手册条目不能被顺手删掉：这只是在摘"搜索入口"。
    assert.match(sdk.text, /mcp__rc22__alpha/, '常驻工具的签名必须仍在手册里（只摘搜索入口）')
  } finally {
    await host.cleanup()
  }
})

test('npm 0.2.2-rc.1: PTC 手册隐藏未发现工具、保留合法程序绑定，同一执行根搜索后立即可调', MODERN, async () => {
  const host = await createHost({ presentation: 'ptc' })
  let admission
  try {
    admission = await host.admit()
    const before = await host.assemble(host.agent, admission)
    // PTC 的传输工具由官方 executor 描述：声明清单里只有它。
    assert.deepEqual(host.names(before), ['run_code'])
    const sdk = before.sections.find((section) => section.name === 'tools:sdk')
    assert.ok(sdk, 'PTC 必须有 tools:sdk 段')
    assert.equal(sdk.text.includes('mcp__rc22__beta'), false, '未发现的延迟工具不得出现在手册里')
    assert.ok(sdk.text.includes('tool_search'), '搜索入口必须留在手册里——它是程序内唯一的搜索入口')

    // 程序内的两次调用用**同一个准入根**：先搜索，再拿被搜索的工具执行。
    const result = await host.search(host.agent, admission, 'select:mcp__rc22__beta')
    assert.equal(result.matches[0].name, 'mcp__rc22__beta')
    assert.equal(host.guard(host.agent, 'mcp__rc22__beta', admission), undefined, '搜索承诺必须在同一执行根内兑现')
    const bound = host.tools.executable('mcp__rc22__beta', host.agent, admission)
    assert.ok(bound, '程序绑定来自准入而不是声明：搜索后必须仍可执行（不是"下一步再试"）')
    assert.deepEqual(await bound.execute({ text: 'x' }, { agent: host.agent, toolSet: admission }), { tool: 'mcp__rc22__beta' })

    const after = await host.assemble(host.agent, admission)
    const sdkAfter = after.sections.find((section) => section.name === 'tools:sdk')
    assert.ok(sdkAfter.text.includes('mcp__rc22__beta'), '发现后必须回到手册')
    assert.equal(sdkAfter.text.includes('mcp__rc22__alpha'), false, '其余未发现工具继续隐藏')
  } finally {
    admission?.dispose()
    await host.cleanup()
  }
})

test('npm 0.2.2-rc.1: 两个 agent 的发现集互不污染（同一宿主、同一库存）', MODERN, async () => {
  const host = await createHost({ presentation: 'native' })
  let first
  let otherScope
  let second
  try {
    first = await host.admit()
    const other = { id: 'rc22-second', session: { id: 's-second', header: { cwd: '/ws/b' }, deriveMessages: () => [] } }
    otherScope = await scopeAgent(host.ctx, other)
    second = await host.tools.resolve({ agent: other, modelSelection: MODEL, signal: signal() })

    await host.search(host.agent, first, 'select:mcp__rc22__beta')
    const firstAssembly = await host.assemble(host.agent, first)
    assert.ok(host.names(firstAssembly).includes('mcp__rc22__beta'))

    // 第二个 agent 用自己的准入根组装：声明与目录都不得出现 first 的发现。
    const secondAssembly = await host.assemble(other, second)
    assert.equal(secondAssembly.tools.some((tool) => tool.name === 'mcp__rc22__beta'), false, '发现集必须按 agent 隔离')
    const catalog = secondAssembly.sections.find((section) => section.name === 'tool-search:catalog')
    assert.match(catalog.text, /^- beta$/m, '第二个 agent 的目录仍把它列为延迟工具')
    assert.match(host.guard(other, 'mcp__rc22__beta', second) ?? '', /deferred/)
  } finally {
    second?.dispose()
    await otherScope?.dispose()
    first?.dispose()
    await host.cleanup()
  }
})


test('npm 0.2.2-rc.1: PTC 会话的搜索结果必须带签名（模式在执行时读装配记录）', MODERN, async () => {
  // 缺陷原样：`execute` 用 `viewFor(agent, undefined, toolSet)` 取模式，没有 assembly 可看，
  // 现代宿主又没有 modeFor，于是恒判 native → 签名分支短路，而能力面照报 ready。
  const host = await createHost({ presentation: 'ptc' })
  let admission
  try {
    admission = await host.admit()
    // 先装配：模式是**装配时**的事实，执行时读回的就是这一条。
    const assembly = await host.assemble(host.agent, admission)
    assert.deepEqual(host.names(assembly), ['run_code'], '前置条件：PTC 下声明只剩 run_code')

    const result = await host.search(host.agent, admission, 'select:mcp__rc22__beta')
    assert.equal(typeof result.matches[0].signature, 'string',
      'PTC 下模型是在程序里调用工具，必须同时给出参数与返回类型')
    assert.match(result.matches[0].signature, /mcp__rc22__beta/)
  } finally {
    admission?.dispose()
    await host.cleanup()
  }
})

test('npm 0.2.2-rc.1: 同一进程里 native 作用域不得被当成 PTC 加签名（按作用域判，不按 ptcRuntime）', MODERN, async () => {
  // executor 是 per-scope 的，而 `ptcRuntime` 对所有作用域都可见。用 ptcRuntime 判模式，
  // 会把"root 挂 PTC、这个 agent 挂 native"的会话判成 PTC，给原生调用附加返回类型签名。
  const host = await createHost({ presentation: 'ptc' })
  let admission
  try {
    const nativeExecutor = await importHost('@deepseek-ai/dsh-tool-executor-native')
    await host.agent.ctx.plugin(nativeExecutor, {})
    admission = await host.admit()
    const assembly = await host.assemble(host.agent, admission)
    // native 的判别式不是"完整清单"——延迟工具本来就要搜过才出现，所以搜索前只剩入口本身。
    assert.deepEqual(host.names(assembly), ['tool_search'],
      '前置条件：该作用域走的是 native（声明里是搜索入口，不是 run_code）')

    const result = await host.search(host.agent, admission, 'select:mcp__rc22__beta')
    assert.equal('signature' in result.matches[0], false,
      'native 会话没有"返回类型"这个契约，加签名只是噪声')
  } finally {
    admission?.dispose()
    await host.cleanup()
  }
})
