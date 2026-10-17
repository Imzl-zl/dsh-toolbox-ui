import assert from 'node:assert/strict'
import test from 'node:test'
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import ToolRuntime, { TOOL_RUNTIME_SCHEDULER } from '@deepseek-ai/dsh-tools'
import * as scopeMod from '@deepseek-ai/dsh-scope'
import { installToolSearchRuntime, DEFAULTS } from '../lib/tool-search-runtime.js'

// 真宿主集成：真 cordis Context + 真 SystemPrompt + 真 ToolRuntime + 真 dsh-scope。
// 手写夹具证明不了"修好的代码在宿主里跑得对"——B2（interpolate）当初就是夹具全绿、
// 真宿主每步抛错。这条用例是唯一能防住那类复发的闸门。
//
// dsh-system-prompt 不是本插件的直接依赖（不 hoist 到 node_modules 根），但它是 dsh-tools
// 的依赖，两者在 pnpm store 里是兄弟目录，所以从 dsh-tools 的解析路径上跳两级即可。
const require_ = createRequire(import.meta.url)
const systemPromptUrl = new URL('../../dsh-system-prompt/lib/index.js', pathToFileURL(require_.resolve('@deepseek-ai/dsh-tools'))).href
const { default: SystemPrompt, renderPrompt } = await import(systemPromptUrl)

const TEST_TIMEOUT_MS = 60_000

// 32 个全局族工具（模拟 profile patch 里的 mcp 条目）。名字跟着 serverName 走——含连字符的
// 服务器名（内置目录 11/47 个）是 `+<server>` 约束的关键用例，用无连字符的名字测等于没测。
const globalTools = (server, count = 16) => Array.from({ length: count }, (_, index) => ({
  name: `mcp__${server}__g${index}`,
  description: `global deferred tool number ${index} for browser work`,
  parameters: { type: 'object', properties: { arg: { type: 'string' } } },
}))

/** 项目族工具：注册进 agent 自己的作用域层（workspace-runtime 投射项目 MCP 的形状）。 */
const OWN_TOOLS = Array.from({ length: 12 }, (_, index) => ({
  name: `mcp__proj__p${index}`,
  description: `project deferred tool number ${index} for database work`,
  parameters: { type: 'object', properties: { arg: { type: 'string' } } },
}))

async function createHost({ descriptionOf, hyphenated = false, deferNothing = false, globalToolCount = 16 } = {}) {
  const ctx = new Context()
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  const tools = ctx.get('tools')
  const systemPrompt = ctx.get('systemPrompt')
  // 服务器名可切换成含连字符的（内置目录里 11/47 个是这种），用来覆盖 `+<server>` 约束。
  const server = hyphenated ? 'defer-me' : 'deferme'

  // 全局族：从根 ctx 注册 → 全局层。
  for (const schema of [...globalTools(server, globalToolCount), ...OWN_TOOLS]) {
    const description = descriptionOf?.(schema.name) ?? schema.description
    tools.register({
      name: schema.name,
      description,
      parameters: schema.parameters,
      output: { schema: { type: 'object', additionalProperties: true }, render: (_a, value) => [{ type: 'text', text: JSON.stringify(value) }] },
      async execute() { return { ok: true, tool: schema.name } },
    })
  }
  // 一个全局 prompt section，模拟 dsh-mcp-client 给每个服务器注册的 `mcp:<server>` 指令段。
  systemPrompt.section({ name: `mcp:${server}`, order: 3100, interpolate: false, text: () => 'DEFERME SERVER INSTRUCTIONS (up to 32KB)' })
  systemPrompt.section({ name: 'mcp:proj', order: 3100, interpolate: false, text: () => 'PROJ SERVER INSTRUCTIONS' })

  const dispose = installToolSearchRuntime(ctx, {
    // deferNothing 模拟"用户把所有服务器的延迟加载都关掉"：serverNames 仍是全集
    // （真实形状——serverNamesOf 恒返回全部已知服务器），只是 defer 集合为空。
    deferServers: () => (deferNothing ? [] : [server, 'proj']),
    serverNames: () => [server, 'proj'],
  })

  // agent 作用域：key 就是 agent 对象本身（dsh-agent-loop:778 `createScope(loopCtx, this)`
  // 就是这么做的——loop 实例同时是 scope key、带 ctx、带 session）。
  // 作用域必须从一个**已注入 tools 的 ctx** 上建，否则 `agent.ctx.tools` 属性访问会被
  // cordis 的 inject 守卫拒掉（真实宿主给 agent 的 ctx 就带 tools 依赖）。
  const agent = { id: 'a1', session: { deriveMessages: () => [] } }
  const injected = []
  await new Promise((resolve) => {
    injected.push(ctx.inject(['tools'], (toolCtx) => {
      const scope = scopeMod.createScope(toolCtx, agent)
      agent.ctx = scope.ctx
      agent.scope = scope
      resolve()
    }))
  })
  // 项目族工具注册进 agent 自己的层（own layer）——restrict 结构性遮不到的那一层。
  for (const schema of OWN_TOOLS) {
    agent.ctx.tools.register({
      name: schema.name,
      description: schema.description,
      parameters: schema.parameters,
      output: { schema: { type: 'object', additionalProperties: true }, render: (_a, value) => [{ type: 'text', text: JSON.stringify(value) }] },
      async execute() { return { ok: true, tool: schema.name } },
    })
  }

  // context 形状必须与宿主一致：`assembleContextFor` 返回 `{ agent, scope: agent, signal }`
  // （dsh-agent）。少给 agent 字段，handler 会按 fail-open 早退——那正是"没遮住"的样子。
  const assemble = () => systemPrompt.assemble({ agent, scope: agent, signal: new AbortController().signal })
  const call = (name, args = {}) => tools.execute({ callId: `c${Math.random()}`, name, arguments: args, agent, signal: new AbortController().signal })

  return { ctx, tools, agent, assemble, call, dispose: async () => { dispose(); await agent.scope?.dispose(); await ctx.fiber.dispose() } }
}

test('real host: 遮罩同时覆盖全局族与项目族，目录带 interpolate:false', TEST_TIMEOUT_MS, async () => {
  const host = await createHost()
  try {
    const assembly = await host.assemble()
    const names = assembly.tools.map((tool) => tool.name)

    // 全局族被遮。
    assert.equal(names.includes('tool_search'), true, '搜索工具必须可见')
    assert.equal(names.some((name) => name.startsWith('mcp__deferme__')), false, '全局族延迟工具必须被遮')
    // 项目族（注册在 agent own 层）同样被遮——决策 8① 的真宿主证明。
    assert.equal(names.some((name) => name.startsWith('mcp__proj__')), false, '项目族延迟工具必须被遮')

    const catalog = assembly.sections.find((section) => section.name === 'tool-search:catalog')
    assert.ok(catalog, '目录 section 必须追加')
    assert.equal(catalog.interpolate, false, '目录嵌第三方描述，绝不能插值')
    assert.ok(catalog.text.includes('mcp__deferme__g0'))
    assert.ok(catalog.text.includes('mcp__proj__p0'))
    // 被延迟服务器的指令段清空（A3）。
    assert.equal(assembly.sections.find((s) => s.name === 'mcp:deferme').text, '')
    assert.equal(assembly.sections.find((s) => s.name === 'mcp:proj').text, '')
  } finally {
    await host.dispose()
  }
})

test('real host: 工具描述里的 {{var}} 不会让每步组装抛错', TEST_TIMEOUT_MS, async () => {
  // B2 的复发闸门：这个 bug 当初手写夹具全绿，真宿主每步 renderPrompt 抛
  // `unknown prompt variable`，agent loop 每步失败。
  const host = await createHost({
    descriptionOf: (name) => (name === 'mcp__deferme__g0'
      ? 'Launch a browser with a {{profile}} template and ${VAR} syntax.'
      : undefined),
  })
  try {
    const assembly = await host.assemble()
    assert.doesNotThrow(() => renderPrompt(assembly), '含 {{var}} 的第三方描述绝不能打断提示词渲染')
    assert.ok(renderPrompt(assembly).includes('mcp__deferme__g0'))
  } finally {
    await host.dispose()
  }
})

test('real host: guard 拒绝未发现的直调，搜索后真 dispatcher 放行', TEST_TIMEOUT_MS, async () => {
  const host = await createHost()
  try {
    // 直调未发现的延迟工具：走真 registry 的完整管线（createExecution → pre-execute
    // waterfall → guardReason → dispatch），必须拿到我们带指引的拒绝。
    const denied = await host.call('mcp__deferme__g3')
    assert.equal(denied.isError, true)
    assert.match(denied.content[0].text, /is deferred/)
    assert.match(denied.content[0].text, /tool_search/)

    // 搜索命中。
    const found = await host.call('tool_search', { query: 'select:mcp__deferme__g3' })
    assert.equal(found.isError, false)
    const value = JSON.parse(found.content[0].text)
    assert.equal(value.matches[0].name, 'mcp__deferme__g3')
    assert.deepEqual(value.matches[0].parameters, { type: 'object', properties: { arg: { type: 'string' } } })

    // 再直调：这次必须真的执行到工具体。
    const allowed = await host.call('mcp__deferme__g3')
    assert.equal(allowed.isError, false)
    assert.equal(JSON.parse(allowed.content[0].text).tool, 'mcp__deferme__g3')

    // 项目族同理。
    const deniedOwn = await host.call('mcp__proj__p1')
    assert.equal(deniedOwn.isError, true)
    await host.call('tool_search', { query: 'select:mcp__proj__p1' })
    const allowedOwn = await host.call('mcp__proj__p1')
    assert.equal(allowedOwn.isError, false)
    assert.equal(JSON.parse(allowedOwn.content[0].text).tool, 'mcp__proj__p1')
  } finally {
    await host.dispose()
  }
})

test('real host: 发现后工具回到 assembly，指令段随之恢复', TEST_TIMEOUT_MS, async () => {
  const host = await createHost()
  try {
    await host.call('tool_search', { query: 'select:mcp__deferme__g3' })
    const assembly = await host.assemble()
    assert.ok(assembly.tools.some((tool) => tool.name === 'mcp__deferme__g3'), '发现的工具必须回到工具列表')
    // deferme 还有 15 个未发现，指令段仍应遮着。
    assert.equal(assembly.sections.find((s) => s.name === 'mcp:deferme').text, '')

    // 全部发现后，指令段恢复。
    for (let index = 0; index < 16; index++) await host.call('tool_search', { query: `select:mcp__deferme__g${index}` })
    const after = await host.assemble()
    assert.equal(after.sections.find((s) => s.name === 'mcp:deferme').text, 'DEFERME SERVER INSTRUCTIONS (up to 32KB)',
      '该服务器工具全部被发现后，指令段不再占上下文')
  } finally {
    await host.dispose()
  }
})

test('real host: 库存不变则目录字节稳定，工具增减后跟随变化', TEST_TIMEOUT_MS, async () => {
  const host = await createHost()
  try {
    const first = (await host.assemble()).sections.find((s) => s.name === 'tool-search:catalog').text
    const second = (await host.assemble()).sections.find((s) => s.name === 'tool-search:catalog').text
    assert.equal(first, second, '库存不变必须是同一份字节（缓存前缀稳定）')

    // 新注册一个工具 → revision 变 → 目录必须跟上。
    host.tools.register({
      name: 'mcp__deferme__late',
      description: 'a late arrival tool',
      parameters: { type: 'object', properties: {} },
      output: { schema: { type: 'object', additionalProperties: true }, render: (_a, value) => [{ type: 'text', text: JSON.stringify(value) }] },
      async execute() { return { ok: true } },
    })
    const third = (await host.assemble()).sections.find((s) => s.name === 'tool-search:catalog').text
    assert.ok(third.includes('mcp__deferme__late'), '新工具必须进入目录')
    assert.ok((await host.assemble()).tools.every((tool) => tool.name !== 'mcp__deferme__late'), '新工具在同一次组装里就被遮掉（无窗口）')
  } finally {
    await host.dispose()
  }
})

test('real host: 没有任何服务器被延迟时，引导段与目录段都不进提示词', TEST_TIMEOUT_MS, async () => {
  // P2：引导段是启动时一次性注册的静态 section，而 defer 是活状态。曾经它无条件注入，
  // 于是"全部关掉延迟加载"之后模型仍读到"Some tools are deferred… call tool_search…"——
  // 在教它去找一批并不存在的延迟工具。这里在真宿主 + 真 renderPrompt 上钉住两个方向。
  const off = await createHost({ deferNothing: true })
  try {
    const assembly = await off.assemble()
    const prompt = renderPrompt(assembly)
    assert.equal(prompt.includes('Some tools are deferred'), false, '没有延迟工具时引导段不得出现在提示词里')
    assert.equal(prompt.includes('Deferred tool catalog'), false, '目录段同理（两者是同一句话的两半）')
    // 另一半：不延迟就必须全量可见——那正是关掉这个功能想要的行为。
    assert.ok(assembly.tools.some((tool) => tool.name.startsWith('mcp__deferme__')), '关掉延迟后全局族工具必须全量可见')
    assert.ok(assembly.tools.some((tool) => tool.name.startsWith('mcp__proj__')), '项目族同理')
    assert.equal(assembly.tools.some((tool) => tool.name === 'tool_search'), true, 'tool_search 仍注册着（总开关没关）')
  } finally {
    await off.dispose()
  }

  const on = await createHost()
  try {
    const prompt = renderPrompt(await on.assemble())
    assert.ok(prompt.includes('Some tools are deferred'), '有东西被延迟时引导段必须出现')
    assert.ok(prompt.includes('Deferred tool catalog'), '目录段也必须出现')
  } finally {
    await on.dispose()
  }
})

test('real host: +约束对含连字符的服务器名生效', TEST_TIMEOUT_MS, async () => {
  // 服务器名必须**真的含连字符**。内置目录 47 个 serverName 里 11 个含 `-`
  // （chrome-devtools、brave-search、sequential-thinking…）；修复前约束段只取一个拉丁词
  // （`/^\+([a-z0-9_-]+)/` → 'defer-me'），而工具名按非字母数字切词
  // （['mcp','defer','me','g3']），于是 `+defer-me` 恒不命中、整条查询静默返回空。
  const host = await createHost({ hyphenated: true })
  try {
    const value = JSON.parse((await host.call('tool_search', { query: '+defer-me g3' })).content[0].text)
    assert.deepEqual(value.matches.map((m) => m.name), ['mcp__defer-me__g3'])

    // 只有约束词、没有排序词：`+<server>` 的常用形态，按名字约束平权返回。
    // 仍受 max_results 约束（默认 DEFAULTS.maxResults）——全量枚举不该走这条路，
    // 模型要某服务器的全部工具时该读目录 section（列了全部名字）或用 `select:`。
    // 断言"受约束"而不是钉死一个数字：钉数字会让限额调优无谓地红在这里。
    const only = JSON.parse((await host.call('tool_search', { query: '+defer-me' })).content[0].text)
    assert.ok(only.matches.length > 0 && only.matches.length <= DEFAULTS.maxResults)
    assert.ok(only.matches.every((m) => m.name.startsWith('mcp__defer-me__')))

    // 不匹配的约束词返回空，而不是误伤全部候选。
    const none = JSON.parse((await host.call('tool_search', { query: '+nope g3' })).content[0].text)
    assert.deepEqual(none.matches, [])
  } finally {
    await host.dispose()
  }
})

test('real host: select: 返回的每个工具都能直接调，即使一批超过 maxDiscovered', TEST_TIMEOUT_MS, async () => {
  // 回归：`select:` 是目录 section 指明的"知道名字就用它"的路径，**不受 maxResults 限制**，
  // 一次返回请求的全部名字；而 maxDiscovered 的淘汰在整批加入**之后**执行，于是同一批里靠前
  // 的工具被立刻重新遮罩。模型的处境自相矛盾：结果里同时写着 discoveredTools=30 与
  // discoveredCount=20、instruction 说"按名字直接调"，而其中 10 个下一次调用必被守卫拒。
  // 这就是项目纪律里的"看起来成功了其实没生效"。
  const count = DEFAULTS.maxDiscovered + 10
  const host = await createHost({ globalToolCount: count })
  try {
    const names = globalTools('deferme', count).map((schema) => schema.name)
    const value = JSON.parse((await host.call('tool_search', { query: `select:${names.join(',')}` })).content[0].text)

    assert.equal(value.matches.length, names.length, 'select: 按请求原样回报全部名字')
    // 自洽性：报告的发现总数不能小于本次刚发现的数目。
    assert.ok(value.discoveredCount >= value.discoveredTools.length,
      `discoveredCount(${value.discoveredCount}) 不得小于本次新发现数(${value.discoveredTools.length})`)

    // 承诺的可执行性：instruction 说了"按名字直接调"，那就必须每个都能调。
    const denied = []
    for (const name of names) {
      const out = await host.call(name)
      if (out.isError) denied.push(name)
    }
    assert.deepEqual(denied, [], '刚返回 schema 的工具不得在下一次调用被拒绝')
  } finally {
    await host.dispose()
  }
})
