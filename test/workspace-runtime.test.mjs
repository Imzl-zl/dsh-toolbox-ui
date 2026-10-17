import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { installAgentRuntime } from '../lib/workspace-runtime.js'
import { projectMcpServers } from '../lib/workspace-runtime.js'
// 把一份 session 展开成真实 setup 契约的两个参数：setup(agentCtx, agent)。
const spawn = (s) => [s, s.sessionAgent]

test('project MCP defer flag reaches the ToolSearch config bridge', async () => {
  // 项目级共享连接是 `connectionCtx.plugin(...)` 建出来的，**不进 loader 树**，所以
  // allMcpEntries(ctx) 看不见它。ToolSearch 的"已知服务器 + defer 标志"因此必须有第二个
  // 来源，否则 UI 上项目服务器的"延迟加载"复选框是个静默 no-op。
  const { installAgentRuntime: install } = await import('../lib/workspace-runtime.js')
  const { deferServersOf, serverNamesOf } = await import('../lib/tool-search-config.js')
  const fixture = await createRuntimeFixture({
    deferTools: false,
    extraServers: { deferred: { command: 'run-deferred', defer: true }, plain: { command: 'run-plain' } },
  })
  try {
    install(fixture.ctx)
    const created = await fixture.agentsService.create({ setup: undefined })
    await created.setup(...spawn(fixture.agentCtx))

    assert.deepEqual(projectMcpServers(fixture.ctx).sort((a, b) => a.name.localeCompare(b.name)), [
      { name: 'db', defer: false },
      { name: 'deferred', defer: true },
      { name: 'plain', defer: false },
    ])
    // 全局族（loader 条目）与项目族（共享连接）合并成同一张表。
    assert.deepEqual(serverNamesOf(fixture.ctx).sort(), ['db', 'deferred', 'exa', 'github', 'plain'])
    assert.deepEqual(deferServersOf(fixture.ctx), ['deferred'])
  } finally {
    await fixture.cleanup()
  }
})

/** 轮询等待一个条件成立（空闲回收这类计时器行为需要它）。 */
async function waitFor(predicate, timeoutMs = 2000) {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    if (await predicate()) return true
    if (Date.now() > deadline) return false
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
}

// 模拟 cordis `ctx.effect()` 的返回语义：立即同步执行 factory、把它返回的 disposer 交给一个
// 幂等 wrapper（cordis 用 runner.epoch 保证同一 effect 只 dispose 一次），wrapper 透传 disposer
// 的返回值（异步 disposer 的 teardown promise 会被 Fiber._unload await）。
// 早先的替身返回的是空函数、且 sink 为空时连 factory 都不执行，会掩盖两类真实缺陷：
// 「HMR 撤回走的是不是官方 disposer」与「teardown 有没有被交回宿主」。
function makeEffect(sinks) {
  return (factory) => {
    const disposer = factory()
    let done = false
    const wrapper = () => {
      if (done) return undefined
      done = true
      return typeof disposer === 'function' ? disposer() : undefined
    }
    for (const sink of sinks) if (sink) sink.push(wrapper)
    return wrapper
  }
}
// 作用域已销毁的 ctx：cordis 的 effect() 开头就 assertActive()，我们照抄这条语义。
function makeInactiveEffect() {
  return () => { throw new Error('INACTIVE_EFFECT') }
}

// deferTools 默认 true = 生产时序：真实 mcp-client 的 apply 在 cordis 的微任务里才跑，工具要等
// connect + tools/list 才注册，所以 setup 当场看到的一定是空集，投射完全依赖后续 tools/change。
// 需要「工具已就绪」的用例显式调用 await fixture.connectAll()。
async function createRuntimeFixture({ deferTools = true, extraServers = {}, idleTimeoutMs, readyTimeoutMs, pendingFiber = false, fiberErrors = {} } = {}) {
  const wsRoot = await mkdtemp(join(tmpdir(), 'dsh-mcp-rt-'))
  await mkdir(join(wsRoot, '.dsh'), { recursive: true })
  await writeFile(join(wsRoot, '.dsh', 'mcp.json'), JSON.stringify({
    mcpServers: {
      db: {
        command: 'psql',
        env: { KEY: '${KEY}' },
        ...(idleTimeoutMs === undefined ? {} : { idleTimeoutMs }),
        ...(readyTimeoutMs === undefined ? {} : { readyTimeoutMs }),
      },
      ...extraServers,
    },
    exclude: ['github'],
  }, null, 2))
  const restrictCalls = []
  const mounts = []
  const effects = []
  const handlers = {}
  const warns = []
  const errors = []
  // 模拟宿主 ToolRuntime 的“按作用域”工具表：scopeKey -> [{name, ...}]。
  // 共享连接把工具注册进它的作用域层，会话侧按 scopeKey 读取并投射进 own 层。
  const scopedTools = new Map() // scopeKey -> Map<name, def>
  const agentOwnTools = new Map() // agent -> Map<name, def>
  // 契约如实：ctx 与 agent 分离（真实宿主里 setup 的第二参数才是 agent，
  // ctx 上没有 agent 属性）。命名 sessionAgent 而不是 agent，
  // 这样任何读 `agentCtx.agent` 的错读在替身里也拿不到东西。
  const ctxAgentObj = { id: 'a1', session: { header: { cwd: wsRoot } } }
  const agentCtx = {
    sessionAgent: ctxAgentObj,
    plugin(plugin, config) {
      // 会话不再直接挂 mcp-client；保留以便断言“没有走旧的每会话挂载路径”。
      mounts.push([plugin, config])
      const fiber = Promise.resolve()
      fiber.catch = () => fiber
      return fiber
    },
    tools: {
      restrict(filter) { restrictCalls.push(filter); return () => {}; },
      register(def) {
        let own = agentOwnTools.get(ctxAgentObj)
        if (!own) { own = new Map(); agentOwnTools.set(ctxAgentObj, own) }
        own.set(def.name, def)
        return () => { own.delete(def.name) }
      },
    },
    effect: makeEffect([effects]),
  }
  ctxAgentObj.ctx = agentCtx
  // 宿主创建事务的替身。真实宿主在 publish 前 await `agent/created` 的串行监听器，而本插件现在
  // 就挂在那上面（不再包装 agents.create/resume）。所以这里把旧调用点 `.setup(agentCtx, agent)`
  // 转发成一次**真实的事件派发**：测试驱动的是新路径，而不是替身自己编的捷径。
  // 刻意**不用 `?.`**：订阅缺失时必须当场抛错，否则挂载静默不发生，而"什么都没发生"类断言
  //（例如禁用 server 时 mounts.length === 0）会空过 —— 那种绿是假的。
  const dispatch = (agent) => {
    const listener = handlers['agent/created']
    if (typeof listener !== 'function') throw new Error('夹具：本测试没有安装 agent/created 订阅（installAgentRuntime 未调用？）')
    return listener({ agent })
  }
  const agentsService = {
    create() { return { setup: (_agentCtx, agent) => dispatch(agent) } },
    resume() { return { setup: (_agentCtx, agent) => dispatch(agent) } },
  }
  // 共享连接的 createScope 替身：建一个 scopeKey 的工具表，plugin() 时按 config.serverName
  // 注册两个工具（模拟 mcp-client 连接就绪后注册 mcp__<server>__*）。
  const createdScopes = []
  let connectionCount = 0            // 建立了几条底层连接（共享的关键指标）
  const sharedClientCalls = []       // 底层连接收到的调用（含 session 标记），验证多路复用不串
  const publishTargets = new Map()   // scopeKey -> serverName（用于 deferTools 时延后注册）
  const logExporters = []            // ensureLogCapture 挂上来的 exporter（模拟 cordis LoggerService）
  const publish = (scopeKey, srv) => {
    let table = scopedTools.get(scopeKey)
    if (!table) { table = new Map(); scopedTools.set(scopeKey, table) }
    const mkDef = (raw) => ({
      name: `mcp__${srv}__${raw}`,
      output: { schema: {}, render: () => [] },
      // 代理执行 = 转发到这条共享连接；按 JSON-RPC 语义各调用独立异步返回。
      execute: async (args) => {
        const id = sharedClientCalls.length
        sharedClientCalls.push({ id, tool: `${srv}.${raw}`, args })
        await new Promise((r) => setTimeout(r, Math.floor(Math.random() * 8)))
        return { content: [{ type: 'text', text: `${raw}:${args?.echo ?? ''}` }] }
      },
    })
    table.set(`mcp__${srv}__x`, mkDef('x'))
    table.set(`mcp__${srv}__y`, mkDef('y'))
  }
  const scopeModule = {
    createScope(_ctx, scopeKey) {
      scopedTools.set(scopeKey, new Map())
      // fiber 的形状与 cordis `ctx.plugin()` 的返回值对齐：thenable（await 它等到启动结束）
      // 且带一个状态代号（0=waiting 未激活、2=ACTIVE、3=failed），面板的行状态直接读它。
      const scopedCtx = {
        plugin(plugin, config) {
          mounts.push([plugin, config])
          connectionCount += 1                       // 每 (ws,server) 只应 +1
          publishTargets.set(scopeKey, config.serverName)
          if (!deferTools) publish(scopeKey, config.serverName)
          // fiberErrors：模拟"官方 apply 自己拒绝"（serverName 已被占用、配置被宿主拒绝）。
          // 这条路径上真实错误就是唯一线索，所以替身必须真的拒绝，而不是给个假的成功 fiber。
          const failure = fiberErrors[config.serverName]
          if (failure !== undefined) {
            const rejected = Promise.reject(new Error(failure))
            rejected.catch(() => {})                 // 真实 catch：没人 await 时也不产生 unhandledRejection
            rejected.state = 3
            return rejected
          }
          // pendingFiber：模拟"连接还没就绪"（真实 mcp-client 的 apply 要等 connect + tools/list 结束）。
          // 永不 settle 的 thenable 因此能把"等就绪"这件事变成可测的时序，而不是靠注入定时器。
          const fiber = pendingFiber ? new Promise(() => {}) : Promise.resolve()
          fiber.catch = () => fiber
          fiber.state = pendingFiber ? 0 : 2
          return fiber
        },
        // 与 cordis 的 Context.extend 一致：子 ctx 原型继承父 ctx，meta 作为自有属性遮蔽继承值。
        // 插件给连接 ctx 挂一个独有 root 就是走这里（见 createSharedConnection 的判重键说明）。
        extend(meta = {}) { return Object.assign(Object.create(this), meta) },
      }
      const scope = {
        key: scopeKey, ctx: scopedCtx, disposed: false,
        // 模拟真实 quiesceFiber 的异步 teardown：serverName 在 teardown 完成后才归还。
        dispose() { this.disposed = true; scopedTools.delete(scopeKey); return new Promise((resolve) => setTimeout(() => { connectionCount -= 1; resolve() }, 5)) },
      }
      createdScopes.push(scope)
      return scope
    },
  }
  // 全局工具的真相源：作用域故障判定要能造出「工具出现在全局视图」这一事实，所以它是可写的。
  const globalSchemas = [{ name: 'mcp__github__a' }, { name: 'mcp__exa__b' }]
  const ctx = {
    loader: {
      entries: () => [
        { options: { name: '@deepseek-ai/dsh-mcp-client', config: { serverName: 'github' } } },
        { options: { name: '@deepseek-ai/dsh-mcp-client', config: { serverName: 'exa' } } },
      ],
      import: async (name) => {
        if (name === '@deepseek-ai/dsh-scope') return scopeModule
        assert.equal(name, '@deepseek-ai/dsh-mcp-client')
        return { apply: () => {}, inject: [], name: 'mcp-client', Config: undefined }
      },
    },
    // 全局工具（用于 exclude/restrict 展开）在无 scope 时返回；带 scopeKey 时返回该共享连接注册的工具。
    tools: {
      schemas: (scope) => {
        if (scope !== undefined && scopedTools.has(scope)) return [...scopedTools.get(scope).values()].map((d) => ({ name: d.name }))
        return globalSchemas
      },
      get: (name, scope) => (scope !== undefined ? scopedTools.get(scope)?.get(name) : undefined),
    },
    get(name) {
      if (name === 'agents') return agentsService;
      if (name === 'tools') return ctx.tools;
      // 项目级写路径要求目标是已注册的工作区：真实宿主里这个项目就是被打开的那个。
      if (name === 'workspaceRegistry') return { list: () => [{ path: wsRoot, title: 'ws' }] };
      return undefined;
    },
    // 与 cordis 一致：注销时监听器真的从表里消失（否则「卸载后不该再收到事件」这类断言是假的）。
    on(event, handler) { handlers[event] = handler; return () => { if (handlers[event] === handler) delete handlers[event] } },
    effect: makeEffect([effects]),
    logger: {
      warn: (message) => warns.push(message), error: (message) => errors.push(message), info: () => {},
      // mcp-client 不暴露连接事件，面板靠 ctx.logger.exporter 订阅它的日志判定连接失败。
      buffer: [],
      exporter: (exp) => { logExporters.push(exp); return () => { const at = logExporters.indexOf(exp); if (at >= 0) logExporters.splice(at, 1) } },
    },
  }
  const sessionDisposers = []
  const fixture = {
    wsRoot, agentCtx, agentsService, ctx, restrictCalls, mounts, effects, handlers, warns, errors, scopedTools, agentOwnTools, createdScopes,
    globalSchemas,
    sessionDisposers,
    get connectionCount() { return connectionCount },
    sharedClientCalls,
    // 让连接“就绪”：注册工具并广播 tools/change，等价于真实 mcp-client connect + tools/list 完成。
    publishTools(scope) {
      publish(scope.key, publishTargets.get(scope.key))
      return handlers['tools/change']?.()
    },
    // 让当前所有共享连接就绪一次（生产主路径：setup 之后才有工具）。
    async connectAll() {
      for (const scope of createdScopes) {
        if (scope.disposed) continue
        publish(scope.key, publishTargets.get(scope.key))
      }
      await handlers['tools/change']?.()
    },
    ownToolNames(session) { return [...(agentOwnTools.get(session.sessionAgent) ?? new Map()).keys()].sort() },
    // 模拟 mcp-client 写一条日志（正文带 mcp-client(<serverName>)，与官方 label 一致；真实
    // cordis 的 message.name 是 hyphenate(fiber.name) = 'mcp-client'，不含括号）。
    emitMcpLog(type, text) {
      const record = { type, name: 'mcp-client', args: [text], ts: Date.now() }
      for (const exp of [...logExporters]) exp.export(record)
      return record
    },
    // 会话替身留下的 disposer 一律在收尾时跑掉：否则模块级的会话记录会在同文件的用例之间累积，
    // 把「会话销毁没清理」这类缺陷盖住。
    async cleanup() {
      for (const dispose of sessionDisposers.splice(0)) { try { await dispose() } catch { /* noop */ } }
      await rm(wsRoot, { recursive: true, force: true })
    },
  }
  return fixture
}


// 构造一个会话替身：tools.register 写入该会话的 own 层；effect(fn) 按 cordis 语义立即执行 fn，
// 返回幂等 disposer。session.dispose() 依序跑掉本会话所有 effect 的 disposer 并等待它们的
// teardown promise —— 等价于 cordis 销毁 agent scope 时做的事。
function makeSession(fixture, id, effectSink = null) {
  const own = []
  let active = true
  // 契约如实：真实宿主里 setup 的第二个参数才是 agent
  // （dsh-agent-loop: `setup?.(prepared.agent.ctx, prepared.agent)`），ctx 上没有 agent 属性。
  // 早年这里把 agent 挂在 ctx 上，于是 `agentCtx.agent` 这种错读在替身里“能跑”，
  // 却在真实宿主抛 `cannot get property "agent" without inject`，而 40+ 个用例全部假通过。
  // 因此替身把两者分开：ctx 用 session，agent 用 sessionAgent，调用方必须传两个参数。
  const sessionAgent = { id, session: { header: { cwd: fixture.wsRoot } } }
  const session = {
    plugin: () => { throw new Error('会话不应直接挂 mcp-client') },
    tools: {
      restrict: () => () => {},
      register(def) { const table = fixture.agentOwnTools.get(sessionAgent) ?? new Map(); table.set(def.name, def); fixture.agentOwnTools.set(sessionAgent, table); return () => table.delete(def.name) },
    },
    // cordis 的 effect() 开头就 assertActive()：作用域销毁后再登记生命周期会直接抛。
    // 这正是本模块赖以判定「会话已在建连期间结束」的官方面，必须在替身里如实建模。
    effect(factory) {
      if (!active) throw new Error('INACTIVE_EFFECT')
      return makeEffect([own, effectSink])(factory)
    },
    async dispose() { active = false; await Promise.all(own.splice(0).map((fn) => fn())) },
  }
  sessionAgent.ctx = session
  fixture.sessionDisposers.push(() => session.dispose())
  // 铺开 ctx 的方法（tools/effect/dispose），另带 sessionAgent：
  // 调用方写 setup(A, A.sessionAgent)，而 A 上**没有** agent 属性。
  return { ...session, ctx: session, sessionAgent }
}

test('agent runtime decorator composes create/resume and applies workspace scope', async () => {
  const { installAgentRuntime: install } = await import('../lib/workspace-runtime.js')
  const fixture = await createRuntimeFixture()
  try {
    install(fixture.ctx)
    const created = await fixture.agentsService.create({ setup: undefined })
    const resumed = await fixture.agentsService.resume({ setup: undefined })

    // 包装后 setup 是 compose 版本；调用它模拟真实 agent setup。
    await created.setup(fixture.agentCtx, fixture.agentCtx.sessionAgent)
    await resumed.setup(fixture.agentCtx, fixture.agentCtx.sessionAgent)

    // 项目配置中的服务器被尝试挂载（本测试环境无 @deepseek-ai/dsh-mcp-client，挂载被容错跳过）。
    assert.ok(fixture.mounts.length === 0 || fixture.mounts[0][1].serverName === 'db')
    // exclude['github'] 展开为当前全局工具名 mcp__github__a 并应用 restrict。
    assert.ok(fixture.restrictCalls.length >= 1)
    const deny = fixture.restrictCalls.at(-1).deny
    assert.deepEqual(deny, ['mcp__github__a'])
    // agent 创建不被 mcp 模块加载失败阻断。
    assert.equal(typeof created.setup, 'function')
  } finally {
    await fixture.cleanup()
  }
})

test('agent runtime skips disabled servers and handles missing config', async () => {
  const { installAgentRuntime: install } = await import('../lib/workspace-runtime.js')
  const fixture = await createRuntimeFixture()
  const empty = await mkdtemp(join(tmpdir(), 'dsh-mcp-rt-'))
  try {
    await writeFile(join(fixture.wsRoot, '.dsh', 'mcp.json'), JSON.stringify({
      mcpServers: { off: { command: 'node', disabled: true } },
    }, null, 2))
    install(fixture.ctx)
    const created = await fixture.agentsService.create({ setup: undefined })
    await created.setup(fixture.agentCtx, fixture.agentCtx.sessionAgent)
    // disabled 服务器不挂载。
    assert.equal(fixture.mounts.length, 0)

    // 无 .dsh/mcp.json 的目录：挂载顺利跑完，无 restrict、无挂载。
    // （挂载点现在是 agent/created，所以这里直接派发事件，而不是造一个 agents 服务替身。）
    const plainCtx = { ...fixture.ctx, tools: { schemas: () => [] } }
    install(plainCtx)
    const plainAgent = {
      ctx: { effect: () => () => {}, tools: { restrict: () => { throw new Error('must not restrict') } } },
      session: { header: { cwd: empty } },
    }
    await fixture.handlers['agent/created']({ agent: plainAgent })
    assert.equal(fixture.mounts.length, 0)
  } finally {
    await fixture.cleanup()
    await rm(empty, { recursive: true, force: true })
  }
})

test('tools/change reconciles workspace restrict when global tools change', async () => {
  const { installAgentRuntime: install } = await import('../lib/workspace-runtime.js')
  const fixture = await createRuntimeFixture()
  try {
    install(fixture.ctx)
    const created = await fixture.agentsService.create({ setup: undefined })
    await created.setup(fixture.agentCtx, fixture.agentCtx.sessionAgent)
    const before = fixture.restrictCalls.length

    // 全局工具集变化（新增 github 工具），reconcile 重新应用 restrict（key 变化）。
    fixture.ctx.tools.schemas = () => [{ name: 'mcp__github__a' }, { name: 'mcp__github__b' }, { name: 'mcp__exa__c' }]
    await fixture.handlers['tools/change']()
    assert.ok(fixture.restrictCalls.length > before)
    assert.deepEqual(fixture.restrictCalls.at(-1).deny, ['mcp__github__a', 'mcp__github__b'])

    // 无变化的 change 不重复 restrict（restrictKey 相同）。
    const stable = fixture.restrictCalls.length
    await fixture.handlers['tools/change']()
    assert.equal(fixture.restrictCalls.length, stable)
  } finally {
    await fixture.cleanup()
  }
})

test('exclude owner disambiguation never denies ambiguous names (double underscore safe)', async () => {
  const { installAgentRuntime: install } = await import('../lib/workspace-runtime.js')
  const fixture = await createRuntimeFixture()
  try {
    // 全局同时存在 my 与 my__server：mcp__my__server__x 的归属在两者间歧义
    // （可能是 my 的 raw tool server__x，也可能是 my__server 的 x）。
    fixture.ctx.loader = {
      entries: () => [
        { options: { name: '@deepseek-ai/dsh-mcp-client', config: { serverName: 'my' } } },
        { options: { name: '@deepseek-ai/dsh-mcp-client', config: { serverName: 'my__server' } } },
      ],
      import: async () => ({ apply: () => {}, inject: [], name: 'mcp-client', Config: undefined }),
    }
    fixture.ctx.tools.schemas = () => [{ name: 'mcp__my__server__x' }]
    await writeFile(join(fixture.wsRoot, '.dsh', 'mcp.json'), JSON.stringify({
      mcpServers: { db: { command: 'psql' } },
      exclude: ['my__server'],
    }, null, 2))
    install(fixture.ctx)
    const created = await fixture.agentsService.create({ setup: undefined })
    await created.setup(fixture.agentCtx, fixture.agentCtx.sessionAgent)
    // 旧逻辑会把 mcp__my__server__x 计入 deny（误伤 my）；新逻辑归属歧义时保守不拒。
    assert.equal(fixture.restrictCalls.length, 0)
  } finally {
    await fixture.cleanup()
  }
})

test('mount failures are recorded for observability instead of silently dropped', async () => {
  const { installAgentRuntime: install, workspaceMountErrorsView } = await import('../lib/workspace-runtime.js')
  const fixture = await createRuntimeFixture()
  try {
    await writeFile(join(fixture.wsRoot, '.dsh', 'mcp.json'), JSON.stringify({
      mcpServers: { db: { command: 'psql', failOnStartupError: true } },
      exclude: [],
    }, null, 2))
    // 显式制造解析失败，而不是依赖「宿主包碰巧不在 node_modules 里」这种偶然。
    fixture.ctx.loader.import = async () => { throw new Error('模拟：宿主未提供 mcp-client') }
    install(fixture.ctx)
    const created = await fixture.agentsService.create({ setup: undefined })
    // setup 不被挂载失败阻断（compose 不 drive），失败被记录而非静默吞掉。
    await created.setup(fixture.agentCtx, fixture.agentCtx.sessionAgent)
    const records = workspaceMountErrorsView(fixture.wsRoot)
    assert.equal(records.length, 1)
    assert.equal(records[0].serverName, 'db')
    assert.ok(records[0].error.length > 0)
  } finally {
    await fixture.cleanup()
  }
})

test('a serverName taken in the registration scope is reported with the official reason, the owner and the root cause', async () => {
  const rt = await import('../lib/workspace-runtime.js')
  // 官方 apply 拒绝时抛的就是这句（serverName 已被同一注册作用域里的另一个实例占用）。
  const conflict = 'mcp-client: serverName "exa" is already in use by another mcp-client instance — pick a unique serverName in cordis.yml'
  const fixture = await createRuntimeFixture({ extraServers: { exa: { command: 'exa-mcp' } }, fiberErrors: { exa: conflict } })
  try {
    rt.installAgentRuntime(fixture.ctx)
    const session = makeSession(fixture, 'mount-conflict-1')
    const created = await fixture.agentsService.create({ setup: undefined })
    await created.setup(session.ctx, session.sessionAgent)

    const failures = rt.workspaceMountErrorsView(fixture.wsRoot)
    const entry = failures.find((failure) => failure.serverName === 'exa')
    assert.ok(entry, `占用必须记账：${JSON.stringify(failures)}`)
    // 官方原文是唯一事实来源：我们的措辞（"共享连接启动失败（fiber 3）"）会把线索丢掉。
    assert.match(entry.error, /is already in use/)
    assert.doesNotMatch(entry.error, /共享连接启动失败（fiber/)
    // 「和谁同名」：夹具里 exa 是全局 loader 条目，owner 因此报得出来。
    assert.match(entry.error, /同名条目：全局 MCP/)
    // 「为什么只有这个宿主会占用」：这条不变量本该由结构保证（见 createSharedConnection）。
    assert.match(entry.error, /@deepseek-ai\/dsh-scope 是否被解析成了多份实例/)
    // 同一轮里没被占用的 server 照常挂载，不许被记成失败。
    assert.equal(failures.some((failure) => failure.serverName === 'db'), false, JSON.stringify(failures))
  } finally {
    await fixture.cleanup()
  }
})

test('workspace MCPs resolve through the host loader rather than the plugin own path', async () => {
  // 插件自己 import 时，Node 以插件真实路径为基点解析，在 link / pnpm 安装下找不到
  // dsh 自带的 mcp-client（全局 MCP 走 loader 所以一直正常，只有项目 MCP 会挂）。
  const { installAgentRuntime: install, workspaceMountErrorsView } = await import('../lib/workspace-runtime.js')
  const fixture = await createRuntimeFixture()
  try {
    const resolved = []
    const scopeMod = {
      createScope(_ctx, scopeKey) {
        const scopedCtx = {
          plugin: (plugin, config) => { fixture.mounts.push([plugin, config]); const f = Promise.resolve(); f.catch = () => f; return f },
          // ctx.extend 是 cordis context 契约的一部分（插件给连接 ctx 挂独有 root 就走它），
          // 替身少了它会让"挂载真的发生"这条断言假失败——那是替身失真，不是插件的问题。
          extend(meta = {}) { return Object.assign(Object.create(this), meta) },
        }
        return { ctx: scopedCtx, dispose() {} }
      },
    }
    fixture.ctx.loader.import = async (name) => {
      resolved.push(name)
      if (name === '@deepseek-ai/dsh-scope') return scopeMod
      return { apply: () => {}, inject: [], name: 'mcp-client', Config: undefined }
    }
    install(fixture.ctx)
    const created = await fixture.agentsService.create({ setup: undefined })
    await created.setup(fixture.agentCtx, fixture.agentCtx.sessionAgent)

    // 共享连接需要两个宿主模块：dsh-scope（造隔离作用域）与 mcp-client（真正连接）。
    assert.deepEqual([...resolved].sort(), ['@deepseek-ai/dsh-mcp-client', '@deepseek-ai/dsh-scope'])
    assert.equal(fixture.mounts.length, 1, '项目 MCP 应通过宿主解析的模块真正挂载')
    assert.equal(workspaceMountErrorsView(fixture.wsRoot).length, 0)
  } finally {
    await fixture.cleanup()
  }
})

// 挂载点是官方的 agent/created 串行监听器：安装只订阅事件，宿主服务一个字节都不动；
// cleanup 注销订阅。（旧实现包装 agents.create/resume，那条路已删除。）
// 就绪预算是给"首轮"的，不是给"每次写盘"的：挂载要在预算内等就绪，而配置对齐
// （reconcile，会话已经活着、没有首轮要保护）**不得**为每个会话各等一次预算 ——
// 否则 3 个会话 + 一个不可达服务器会让一次面板保存阻塞十几秒。
test('readiness budget protects the first turn but never blocks a config write', async () => {
  const { installAgentRuntime: install, reconcileWorkspaceConnections } = await import('../lib/workspace-runtime.js')
  const fixture = await createRuntimeFixture({ pendingFiber: true, readyTimeoutMs: 400 })
  try {
    install(fixture.ctx)
    const A = makeSession(fixture, 'A')
    const B = makeSession(fixture, 'B')
    const mountStart = Date.now()
    await (await fixture.agentsService.create({ setup: undefined })).setup(A, A.sessionAgent)
    const mountMs = Date.now() - mountStart
    assert.ok(mountMs >= 350, `首轮挂载必须在预算内等就绪（实测 ${mountMs}ms）`)
    await (await fixture.agentsService.resume({ setup: undefined })).setup(B, B.sessionAgent)

    const writeStart = Date.now()
    const result = await reconcileWorkspaceConnections(fixture.ctx, fixture.wsRoot)
    const writeMs = Date.now() - writeStart
    assert.equal(result.remounted, 2, '两个存活会话都要重新对齐')
    // 判据来自夹具的机制而不是"跑得快"：就绪预算是 400ms，而这个 fixture 的 fiber 永不 settle，
    // 所以只要 reconcile 真的逐个会话等就绪，这里必然 ≥400ms；对齐路径自己的活儿是微秒级。
    assert.ok(writeMs < 300, `配置对齐不得逐个会话等就绪（实测 ${writeMs}ms，预算 400ms×2）`)
  } finally {
    await fixture.cleanup()
  }
})

// 空闲计时器与「重新被引用」的竞态：计时器到点时若连接已被重新持有，绝不能拆。
// （这是空闲回收唯一的危险窗口：refs 归零起计时器，之后又有人 acquire。）
test('shared project connection: a re-acquired connection is not disposed by a stale idle timer', async () => {
  const { installAgentRuntime: install, projectConnectionsView } = await import('../lib/workspace-runtime.js')
  const fixture = await createRuntimeFixture({ idleTimeoutMs: 150, deferTools: false })
  try {
    install(fixture.ctx)
    const A = makeSession(fixture, 'A')
    await (await fixture.agentsService.create({ setup: undefined })).setup(A, A.sessionAgent)
    await A.dispose() // refs 归零 → 起空闲计时器
    const B = makeSession(fixture, 'B')
    await (await fixture.agentsService.resume({ setup: undefined })).setup(B, B.sessionAgent) // 复用同一条
    assert.equal(fixture.createdScopes.length, 1, '必须复用同一条连接')
    assert.equal((await projectConnectionsView(fixture.ctx))[0].idle, false, '重新被引用后不再是空闲态')
    assert.deepEqual(fixture.ownToolNames(B), ['mcp__db__x', 'mcp__db__y'], '复用的连接必须照旧可投射工具')
    // 等过空闲阈值的 ~2.7 倍：被持有的连接不得被那个已经失效的计时器拆掉。
    // 两个余量都要够宽：重取用要在 150ms 内完成（否则计时器先到、用例在 :468 就失败），
    // 而这里要等到远超 150ms 才算证明了计时器确实被取消。
    await new Promise((resolve) => setTimeout(resolve, 400))
    assert.equal(fixture.connectionCount, 1, '被持有的连接不得被过期的空闲计时器拆掉')
    assert.equal(fixture.createdScopes[0].disposed, false)
  } finally {
    await fixture.cleanup()
  }
})

// 「监听器绝不否决会话创建」这条边界本身要被测：宿主把监听器的抛错当作否决创建，
// 所以即使载荷本身爆炸（例如 agent.session 在读取时抛），也只能吞成日志。
// （另一条端到端用例证明宿主的否决语义真实存在，这条证明我们没有踩上去。）
test('agent runtime: a throwing agent payload is swallowed by the listener, never vetoing creation', async () => {
  const { installAgentRuntime: install } = await import('../lib/workspace-runtime.js')
  const fixture = await createRuntimeFixture()
  try {
    install(fixture.ctx)
    const hostile = {
      get session() { throw new Error('payload blew up') },
      ctx: { effect: () => () => {}, tools: { register: () => () => {} } },
    }
    await assert.doesNotReject(
      () => fixture.handlers['agent/created']({ agent: hostile }),
      '监听器抛错会否决会话创建，所以必须自吞',
    )
    assert.ok(
      fixture.errors.some((line) => line.includes('已吞掉，不阻断会话创建')),
      '自吞必须留下可诊断的日志：' + JSON.stringify(fixture.errors),
    )
  } finally {
    await fixture.cleanup()
  }
})

// 面板的编辑表单是"重建 spec"而不是增量改 spec，所以视图层必须把**表单不渲染的字段**也投影出去，
// 否则用户编辑一次就把它们抹掉：`disabled`（会让被禁用的 server 被悄悄启用）与项目级预算旋钮。
test('workspace view projects the fields the edit form has to carry back', async () => {
  const { installAgentRuntime: install } = await import('../lib/workspace-runtime.js')
  const { summarizeWorkspaceRow } = await import('../lib/index.js')
  const fixture = await createRuntimeFixture()
  try {
    install(fixture.ctx)
    const row = summarizeWorkspaceRow(fixture.ctx, fixture.wsRoot, {
      name: 'db', transport: 'stdio', idleTimeoutMs: 0, readyTimeoutMs: 1234,
    }, undefined)
    assert.equal(row.idleTimeoutMs, 0, '空闲预算必须投影出去（0 是合法值，不能被当成未设置）')
    assert.equal(row.readyTimeoutMs, 1234, '就绪预算同样要投影出去')
    const offRow = summarizeWorkspaceRow(fixture.ctx, fixture.wsRoot, { name: 'off', transport: 'stdio', disabled: true }, undefined)
    assert.equal(offRow.enabled, false, '禁用状态由 enabled 表达，表单据此带回 disabled')
  } finally {
    await fixture.cleanup()
  }
})

// 按需重建（重连耗尽的终态）必须让**同项目所有存活会话**都重新指到新连接上。
// 旧实现只顺手修好了"正在挂载的那个"：其余会话的槽位一直指向已销毁的连接，永久读不到工具 ——
// 正是这次改动要消灭的症状，只不过换了个触发场景。这条测试就是它的回归守卫。
test('on-demand rebuild of an exhausted connection keeps every live session on the new connection', async (t) => {
  const rt = await import('../lib/workspace-runtime.js')
  const fixture = await createRuntimeFixture({ deferTools: false })
  try {
    rt.installAgentRuntime(fixture.ctx)
    const A = makeSession(fixture, 'A')
    await (await fixture.agentsService.create({ setup: undefined })).setup(A, A.sessionAgent)
    await fixture.connectAll()
    assert.deepEqual(fixture.ownToolNames(A), ['mcp__db__x', 'mcp__db__y'])
    const firstScope = fixture.createdScopes[0]

    // 制造终态：mcp-client 重连耗尽时会**注销工具而保留作用域** —— 夹具里就是清空这张表。
    // 注意不能调 connectAll()：那会按生产路径把工具**重新发布**回来。这里只派发 tools/change，
    // 也就是"服务器那边工具没了，宿主通知工具集变了"这一件事。
    fixture.scopedTools.get(firstScope.key).clear()
    await fixture.handlers['tools/change']()
    assert.deepEqual(fixture.ownToolNames(A), [], '前置：工具确实被注销了')

    // 让它"老到"足以被判为终态（阈值 5s）。只 mock Date，不动真实定时器（夹具的 dispose 依赖真定时器）。
    // `now` 必须显式给：这个 Node 版本里 enable({apis:['Date']}) 把时钟置 0，而 entry.createdAt 是
    // 真实时钟（1.79e12），差值会是巨大的负数，age 判定永远不成立。
    t.mock.timers.enable({ apis: ['Date'], now: Date.now() })
    t.mock.timers.tick(6_000)

    const B = makeSession(fixture, 'B')
    await (await fixture.agentsService.resume({ setup: undefined })).setup(B, B.sessionAgent)
    assert.equal(fixture.createdScopes.length, 2, '终态连接必须在这次挂载被拆掉并按配置重建')
    assert.equal(firstScope.disposed, true, '旧连接必须被销毁')

    await fixture.connectAll()
    assert.deepEqual(fixture.ownToolNames(A), ['mcp__db__x', 'mcp__db__y'], '先前那个会话必须被重新投射到新连接上（旧的 bug 就在这里）')
    assert.deepEqual(fixture.ownToolNames(B), ['mcp__db__x', 'mcp__db__y'])
    const row = (await rt.projectConnectionsView(fixture.ctx))[0]
    assert.equal(row.refs, 2, '两个会话各持一份引用')
    assert.equal(row.toolCount, 2)
  } finally {
    await fixture.cleanup()
  }
})

test('agent runtime install subscribes to agent/created, mounts through it, and cleanup unsubscribes', async () => {
  const { installAgentRuntime: install } = await import('../lib/workspace-runtime.js')
  const fixture = await createRuntimeFixture()
  try {
    const pristineCreate = fixture.agentsService.create
    const cleanup = install(fixture.ctx)
    assert.equal(fixture.agentsService.create, pristineCreate, '不得改写宿主服务')
    const listener = fixture.handlers['agent/created']
    assert.equal(typeof listener, 'function', '必须订阅 agent/created')

    // 挂载确实由这个监听器驱动：派发一次事件就该建出共享连接。
    const session = makeSession(fixture, 'A')
    await listener({ agent: session.sessionAgent })
    assert.equal(fixture.connectionCount, 1, '监听器必须真的把项目 MCP 挂上')

    cleanup()
    assert.equal(fixture.handlers['agent/created'], undefined, 'cleanup 必须注销订阅')
    cleanup() // 二次清理幂等。
    assert.equal(fixture.handlers['agent/created'], undefined)
  } finally {
    await fixture.cleanup()
  }
})
// 同一会话被挂载两次（重复派发 / 双监听器）必须幂等：连接按 (wsPath, serverName) 去重，
// 工具按名字去重。旧实现的风险是「重复安装叠装饰器 → 调用深度无限增长」，那条路随
// monkey-patch 一起消失了；这里守住的是它留下的等价风险。
test('mounting the same session twice reuses the one shared connection and one tool set', async () => {
  const { installAgentRuntime: install } = await import('../lib/workspace-runtime.js')
  // deferTools: false = 连接在挂载时就已经注册好了工具，好断言自己的工具集大小。
  const fixture = await createRuntimeFixture({ deferTools: false })
  try {
    install(fixture.ctx)
    const session = makeSession(fixture, 'A')
    await fixture.handlers['agent/created']({ agent: session.sessionAgent })
    await fixture.handlers['agent/created']({ agent: session.sessionAgent })
    assert.equal(fixture.connectionCount, 1, '同一 (wsPath, serverName) 只应有一条共享连接')
    assert.equal(fixture.ownToolNames(session).length, 2, '重复挂载不得让工具重复注册')
  } finally {
    await fixture.cleanup()
  }
})

// exclude 变更后重算 deny 并写入会话作用域，不依赖 tools/change（改屏蔽不动全局工具集，
// 那个事件不会触发）。断言的是「重算并调用 restrict」——`restrict()` 是作用域层上的登记，
// 写盘后必须有人主动算一次；算完之后运行中的会话在下一轮请求就不再见得到被屏蔽的工具。
test('exclude change recomputes deny and calls restrict without a tools/change event', async () => {
  const { installAgentRuntime: install } = await import('../lib/workspace-runtime.js')
  const { McpManagerGateway } = await import('../lib/index.js')
  const fixture = await createRuntimeFixture()
  try {
    install(fixture.ctx)
    const created = await fixture.agentsService.create({ setup: undefined })
    await created.setup(fixture.agentCtx, fixture.agentCtx.sessionAgent)
    assert.deepEqual(fixture.restrictCalls.at(-1).deny, ['mcp__github__a'])

    await McpManagerGateway.prototype.setWorkspaceExclude.call({ ctx: fixture.ctx }, {
      wsPath: fixture.wsRoot, serverName: 'exa', hidden: true,
    })

    assert.deepEqual(fixture.restrictCalls.at(-1).deny, ['mcp__exa__b', 'mcp__github__a'], '写入后应重算 deny 并调用 restrict')
  } finally {
    await fixture.cleanup()
  }
})

test('failed restrict is retried instead of being recorded as applied', async () => {
  const { installAgentRuntime: install } = await import('../lib/workspace-runtime.js')
  const fixture = await createRuntimeFixture()
  try {
    // 第一次 restrict 抛错：此时不得把 restrictKey 记为已生效，否则同一 deny 再也不会重试。
    let attempts = 0
    fixture.agentCtx.tools.restrict = (filter) => {
      attempts += 1
      if (attempts === 1) throw new Error('boom')
      fixture.restrictCalls.push(filter)
      return () => {}
    }
    install(fixture.ctx)
    const created = await fixture.agentsService.create({ setup: undefined })
    await created.setup(fixture.agentCtx, fixture.agentCtx.sessionAgent)
    assert.equal(attempts, 1)
    assert.deepEqual(fixture.restrictCalls, [], '首次调用抛错，不应记录为已应用')

    await fixture.handlers['tools/change']()
    assert.equal(attempts, 2, '同一 deny 必须重试')
    assert.deepEqual(fixture.restrictCalls.at(-1).deny, ['mcp__github__a'])
  } finally {
    await fixture.cleanup()
  }
})

// 安装不再依赖 agents 服务：挂载点换成 agent/created 之后，连 ctx.get('agents') 都不需要。
// （旧实现必须等 ctx.inject(['agents']) 就绪，才能改写出一个可装饰的 create/resume。）
test('agent runtime install needs no agents service', async () => {
  const { installAgentRuntime: install } = await import('../lib/workspace-runtime.js')
  const fixture = await createRuntimeFixture()
  try {
    const withoutAgents = { ...fixture.ctx, get: () => undefined, agents: undefined }
    const cleanup = install(withoutAgents)
    const listener = fixture.handlers['agent/created']
    assert.equal(typeof listener, 'function', 'agents 未就绪也必须装上挂载点')
    const session = makeSession(fixture, 'A')
    await listener({ agent: session.sessionAgent })
    assert.equal(fixture.connectionCount, 1, '没有 agents 服务也能正常挂载')
    cleanup()
    assert.equal(fixture.handlers['agent/created'], undefined)
  } finally {
    await fixture.cleanup()
  }
})

test('workspace RPCs do not install the agent runtime', async () => {
  const { McpManagerGateway } = await import('../lib/index.js')
  const fixture = await createRuntimeFixture()
  try {
    await McpManagerGateway.prototype.listWorkspaces.call({ ctx: fixture.ctx })
    assert.equal(fixture.handlers['agent/created'], undefined, 'RPC 不应承担装配职责')
  } finally {
    await fixture.cleanup()
  }
})

test('restrict failures become observable instead of dying in a swallowed catch', async () => {
  const { installAgentRuntime: install, workspaceRestrictErrorView, liveWorkspaceAgentCount } = await import('../lib/workspace-runtime.js')
  const fixture = await createRuntimeFixture()
  try {
    fixture.agentCtx.tools.restrict = () => { throw new Error('scope gone') }
    install(fixture.ctx)
    const created = await fixture.agentsService.create({ setup: undefined })
    await created.setup(fixture.agentCtx, fixture.agentCtx.sessionAgent)

    // 运行中的会话数是用户判断「这次切换能否影响当前会话」的依据，也是诊断入口。
    assert.equal(liveWorkspaceAgentCount(fixture.wsRoot), 1)
    const failure = workspaceRestrictErrorView(fixture.wsRoot)
    assert.match(failure?.error ?? '', /scope gone/)
    assert.deepEqual(failure.deny, ['mcp__github__a'])
  } finally {
    await fixture.cleanup()
  }
})

test('a later successful restrict clears the recorded failure', async () => {
  const { installAgentRuntime: install, workspaceRestrictErrorView } = await import('../lib/workspace-runtime.js')
  const fixture = await createRuntimeFixture()
  try {
    let fail = true
    fixture.agentCtx.tools.restrict = (filter) => {
      if (fail) throw new Error('transient')
      fixture.restrictCalls.push(filter)
      return () => {}
    }
    install(fixture.ctx)
    const created = await fixture.agentsService.create({ setup: undefined })
    await created.setup(fixture.agentCtx, fixture.agentCtx.sessionAgent)
    assert.ok(workspaceRestrictErrorView(fixture.wsRoot))

    fail = false
    await fixture.handlers['tools/change']()
    assert.equal(workspaceRestrictErrorView(fixture.wsRoot), null, '成功后必须清除，避免陈旧告警长期挂在面板上')
  } finally {
    await fixture.cleanup()
  }
})

// ── 共享连接：同项目多会话不再撞 serverName，且各会话都拿到工具 ──
test('shared project connection: two sessions of one project reuse ONE mcp-client instance', async () => {
  const { installAgentRuntime: install, workspaceMountErrorsView } = await import('../lib/workspace-runtime.js')
  const fixture = await createRuntimeFixture()
  try {
    install(fixture.ctx)
    const A = makeSession(fixture, 'A')
    const B = makeSession(fixture, 'B')
    await (await fixture.agentsService.create({ setup: undefined })).setup(A, A.sessionAgent)
    await (await fixture.agentsService.resume({ setup: undefined })).setup(B, B.sessionAgent)

    // 只挂了一份官方 mcp-client（一个共享作用域、一条底层连接），serverName 只登记一次。
    assert.equal(fixture.createdScopes.length, 1, '每 (项目, serverName) 只应建一个共享作用域')
    assert.equal(fixture.connectionCount, 1, '两个会话必须共用一条连接')
    assert.deepEqual(workspaceMountErrorsView(fixture.wsRoot), [], '共享连接下不应再有 serverName 冲突')
    // 生产时序：setup 当场还没有工具，要等 connect + tools/list 完成后的 tools/change。
    assert.deepEqual(fixture.ownToolNames(A), [], 'setup 当场共享连接尚未注册工具')
    await fixture.connectAll()
    assert.deepEqual(fixture.ownToolNames(A), ['mcp__db__x', 'mcp__db__y'])
    assert.deepEqual(fixture.ownToolNames(B), ['mcp__db__x', 'mcp__db__y'])
  } finally {
    await fixture.cleanup()
  }
})

// ── 引用计数：先关的会话只撤自己的投射，末个会话关掉才释放连接 ──
// idleTimeoutMs: 0 表示「永不自动回收」：显式选择常驻的项目，不该被空闲计时器悄悄拆掉。
test('shared project connection: idleTimeoutMs 0 keeps the connection resident after the last session ends', async () => {
  const { installAgentRuntime: install, projectConnectionsView } = await import('../lib/workspace-runtime.js')
  const fixture = await createRuntimeFixture({ idleTimeoutMs: 0 })
  try {
    install(fixture.ctx)
    const A = makeSession(fixture, 'A')
    await (await fixture.agentsService.create({ setup: undefined })).setup(A, A.sessionAgent)
    await A.dispose()
    assert.equal(fixture.connectionCount, 1)
    const row = (await projectConnectionsView(fixture.ctx))[0]
    assert.equal(row.idleTimeoutMs, 0)
    assert.equal(row.idle, false, '0 = 不回收，所以不存在“空闲等待”这个状态')
    // 等一小会儿仍然是常驻的（没有任何计时器在跑）。
    await new Promise((resolve) => setTimeout(resolve, 40))
    assert.equal(fixture.connectionCount, 1, 'idleTimeoutMs: 0 的连接不得被空闲回收')
    assert.equal(fixture.createdScopes[0].disposed, false)
  } finally {
    await fixture.cleanup()
  }
})

test('shared project connection: releasing the last session keeps the connection idle, and the idle timeout retires it', async () => {
  const { installAgentRuntime: install, projectConnectionsView } = await import('../lib/workspace-runtime.js')
  // 50ms 空闲回收，好在用例里等到它。
  const fixture = await createRuntimeFixture({ idleTimeoutMs: 50 })
  try {
    install(fixture.ctx)
    const A = makeSession(fixture, 'A')
    const B = makeSession(fixture, 'B')
    await (await fixture.agentsService.create({ setup: undefined })).setup(A, A.sessionAgent)
    await (await fixture.agentsService.resume({ setup: undefined })).setup(B, B.sessionAgent)
    await fixture.connectAll()

    assert.equal(fixture.createdScopes.length, 1)
    assert.equal(fixture.createdScopes[0].disposed, false)

    // 关掉会话 A（cordis 销毁 agent scope → 跑本会话所有 effect 的 disposer）。
    await A.dispose()
    assert.equal(fixture.createdScopes[0].disposed, false, '还有会话在用，连接不得断开')
    assert.deepEqual(fixture.ownToolNames(B), ['mcp__db__x', 'mcp__db__y'])
    assert.deepEqual(fixture.ownToolNames(A), [], 'A 的投射已撤回')

    // 末个会话关掉：连接**不拆**，只进入空闲等待 —— 这就是「下一次要用时已经就绪」的前提。
    await B.dispose()
    assert.equal(fixture.connectionCount, 1, '末个会话关掉后连接必须保留（空闲）')
    const idleRow = (await projectConnectionsView(fixture.ctx))[0]
    assert.equal(idleRow.refs, 0)
    assert.equal(idleRow.idle, true, '空闲等待必须能从诊断视图看出来')

    // 空闲超时到点才真的回收（替身的作用域 dispose 还会异步把连接计数减掉，所以等计数）。
    assert.ok(await waitFor(() => fixture.connectionCount === 0), '空闲超时后必须回收连接')
  } finally {
    await fixture.cleanup()
  }
})

// ── 面板「重连」在**空闲保留**这个状态下也必须真的重建连接。这是本功能特意制造出来的常态
//    （最后一个会话结束 = 连接留着待用），而它不是「有存活会话」的场景：reconcile 只遍历
//    agentWorkspaceStates，没人挂着的时候它拆完旧连接就没有任何人再建新的 —— 面板会显示
//    「已重连」而连接其实没了，正好把「下次直接用」这条承诺打掉。 ──
test('shared project connection: reconnecting an idle-retained connection rebuilds it instead of leaving nothing', async () => {
  const { installAgentRuntime: install, projectConnectionsView, reconnectWorkspaceServer } = await import('../lib/workspace-runtime.js')
  const fixture = await createRuntimeFixture()
  try {
    install(fixture.ctx)
    const A = makeSession(fixture, 'A')
    await (await fixture.agentsService.create({ setup: undefined })).setup(A, A.sessionAgent)
    await fixture.connectAll()
    assert.equal(fixture.connectionCount, 1)
    // 会话结束 → 连接进入空闲保留（refs 归零、连接还在）。
    await A.dispose()
    const idle = (await projectConnectionsView(fixture.ctx))[0]
    assert.equal(idle.refs, 0)
    assert.equal(idle.idle, true, '前置条件：这条连接必须处在空闲保留态')
    assert.equal(fixture.connectionCount, 1)

    const result = await reconnectWorkspaceServer(fixture.ctx, fixture.wsRoot, 'db')
    assert.equal(result.hadLiveConnection, true, '点之前确实有一条活动连接')
    // 重建后必须仍有一条连接，且同样处于空闲保留（引用当场还回去，等下次会话复用）。
    assert.equal(fixture.connectionCount, 1, '空闲态重连必须建回一条新连接，而不是拆完什么都不剩')
    const after = await projectConnectionsView(fixture.ctx)
    assert.equal(after.length, 1, '重连后诊断视图里必须还有这条连接')
    assert.equal(after[0].refs, 0, '空闲态重连不产生悬挂引用')
    assert.equal(after[0].idle, true, '重建后的连接同样进入空闲保留')
  } finally {
    await fixture.cleanup()
  }
})

// ── 禁用的条目不该被「重连」凭空建出连接来（挂载路径同样跳过 disabled）。 ──
test('shared project connection: reconnecting a disabled entry does not build a connection', async () => {
  const { installAgentRuntime: install, reconnectWorkspaceServer, readWorkspaceConfigCached } = await import('../lib/workspace-runtime.js')
  const fixture = await createRuntimeFixture()
  try {
    install(fixture.ctx)
    // 写盘置为 disabled，再点重连。
    const configPath = join(fixture.wsRoot, '.dsh', 'mcp.json')
    const config = JSON.parse(await readFile(configPath, 'utf8'))
    config.mcpServers.db.disabled = true
    await writeFile(configPath, JSON.stringify(config, null, 2))
    const server = (await readWorkspaceConfigCached(fixture.ctx, fixture.wsRoot)).servers.find((s) => s.name === 'db')
    assert.equal(server.disabled, true, '前置条件：条目必须是 disabled')
    await reconnectWorkspaceServer(fixture.ctx, fixture.wsRoot, 'db')
    assert.equal(fixture.connectionCount, 0, '禁用条目不得因为点重连就建出连接')
  } finally {
    await fixture.cleanup()
  }
})

// ── 同项目两会话「交叉并发实际调用」项目 MCP，验证一份连接 + 不串扰 ──
test('shared project connection: two sessions call the project MCP concurrently without crosstalk', async () => {
  const { installAgentRuntime: install, workspaceMountErrorsView } = await import('../lib/workspace-runtime.js')
  const fixture = await createRuntimeFixture()
  try {
    install(fixture.ctx)
    const A = makeSession(fixture, 'A')
    const B = makeSession(fixture, 'B')
    await (await fixture.agentsService.create({ setup: undefined })).setup(A, A.sessionAgent)
    await (await fixture.agentsService.resume({ setup: undefined })).setup(B, B.sessionAgent)
    await fixture.connectAll()

    assert.equal(fixture.connectionCount, 1, '两个并发会话必须共用一条连接')
    assert.deepEqual(workspaceMountErrorsView(fixture.wsRoot), [])

    const toolA = fixture.agentOwnTools.get(A.sessionAgent).get('mcp__db__x')
    const toolB = fixture.agentOwnTools.get(B.sessionAgent).get('mcp__db__x')
    assert.ok(toolA && toolB, '两个会话各自 own 层都应拿到 mcp__db__x')

    // 交叉并发：A、B 各发 25 个带唯一 echo 的调用，全部经同一条连接多路复用。
    const jobs = []
    for (let i = 0; i < 25; i += 1) {
      jobs.push(toolA.execute({ echo: `A${i}` }).then((r) => ['A' + i, r.content[0].text]))
      jobs.push(toolB.execute({ echo: `B${i}` }).then((r) => ['B' + i, r.content[0].text]))
    }
    const out = await Promise.all(jobs)
    const crossed = out.filter(([tag, text]) => text !== `x:${tag}`)
    assert.deepEqual(crossed, [], '并发交叉调用出现串扰: ' + JSON.stringify(crossed))
    assert.equal(fixture.sharedClientCalls.length, 50)
    assert.equal(fixture.connectionCount, 1)
  } finally {
    await fixture.cleanup()
  }
})

// ── 并发 setup 竞态：check→await→set 未串行化会让两个会话各建一份连接、触发 serverName 冲突 ──
test('shared project connection: concurrent setup of two sessions builds ONE connection (setup race serialized)', async () => {
  const { installAgentRuntime: install, workspaceMountErrorsView, readWorkspaceConfigCached } = await import('../lib/workspace-runtime.js')
  const fixture = await createRuntimeFixture()
  try {
    // 预填配置缓存：让两个 setup 跳过文件读取、同步进入 acquire。再把 mcp-client 的模块
    // 加载换成受控 barrier：不 resolve 前两个 acquire 都停在 await 处——否则 fs.stat 时序
    // 会让第一个 setup 先全链路跑完，第二个变成顺序复用，测不出竞态。
    install(fixture.ctx)
    await readWorkspaceConfigCached(fixture.ctx, fixture.wsRoot)
    const originalImport = fixture.ctx.loader.import
    const mcpBarrier = []
    fixture.ctx.loader.import = (name) => name === '@deepseek-ai/dsh-scope' ? originalImport(name) : new Promise((resolve) => mcpBarrier.push(resolve))
    const A = makeSession(fixture, 'A')
    const B = makeSession(fixture, 'B')
    const created = await fixture.agentsService.create({ setup: undefined })
    const resumed = await fixture.agentsService.resume({ setup: undefined })
    // dsh 启动恢复多会话的真实形态：并发 setup，不等待第一个完成。
    const pa = created.setup(A, A.sessionAgent)
    const pb = resumed.setup(B, B.sessionAgent)
    const deadline = Date.now() + 2000
    while (mcpBarrier.length < 1 && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 1))
    assert.ok(mcpBarrier.length >= 1, '至少一个 acquire 发起 mcp-client 模块加载，实际 ' + mcpBarrier.length)
    for (const resolve of mcpBarrier) resolve({ apply: () => {}, inject: [], name: 'mcp-client', Config: undefined })
    await Promise.all([pa, pb])
    assert.equal(fixture.mounts.length, 1, '并发 setup 必须只挂一份 mcp-client')
    assert.equal(fixture.connectionCount, 1, '并发 setup 必须只建一条连接')
    assert.deepEqual(workspaceMountErrorsView(fixture.wsRoot), [], '并发 setup 不得触发 serverName 冲突')
    await fixture.connectAll()
    assert.deepEqual(fixture.ownToolNames(A), ['mcp__db__x', 'mcp__db__y'])
    assert.deepEqual(fixture.ownToolNames(B), ['mcp__db__x', 'mcp__db__y'])
  } finally {
    await fixture.cleanup()
  }
})

// ── 释放→重建竞态：teardown 是异步的，立即重开必须等旧连接归还 serverName ──
test('shared project connection: session churn reuses the live connection instead of rebuilding it', async () => {
  const { installAgentRuntime: install, workspaceMountErrorsView, projectConnectionsView } = await import('../lib/workspace-runtime.js')
  const fixture = await createRuntimeFixture()
  try {
    install(fixture.ctx)
    const A = makeSession(fixture, 'A')
    await (await fixture.agentsService.create({ setup: undefined })).setup(A, A.sessionAgent)
    assert.equal(fixture.connectionCount, 1)

    // 会话关闭不再引发 teardown：连接留在空闲池里，所以「释放窗口」这种竞态窗口根本不存在了
    // ——旧实现要在这里等旧连接销毁完才允许新建，否则会撞 serverName。
    await A.dispose()
    assert.equal(fixture.createdScopes[0].disposed, false, '会话关闭不得拆连接')

    const B = makeSession(fixture, 'B')
    await (await fixture.agentsService.resume({ setup: undefined })).setup(B, B.sessionAgent)
    assert.equal(fixture.connectionCount, 1, '重开会话必须复用同一条连接')
    assert.equal(fixture.createdScopes.length, 1, '不得再建第二个作用域')
    const rows = await projectConnectionsView(fixture.ctx)
    assert.equal(rows.length, 1)
    assert.equal(rows[0].refs, 1, '引用是从 0 加回同一条连接，而不是重建')
    assert.equal(rows[0].idle, false, '重新被引用的连接不再是空闲态')
    assert.deepEqual(workspaceMountErrorsView(fixture.wsRoot), [])
    await fixture.connectAll()
    assert.deepEqual(fixture.ownToolNames(B), ['mcp__db__x', 'mcp__db__y'])
  } finally {
    await fixture.cleanup()
  }
})

// ── HMR/卸载：cleanup 必须走每个 slot 自己的 cordis disposer 撤回投射并释放连接；
//    之后会话正常销毁不得重复释放（负计数/重复 dispose）。 ──
test('shared project connection: plugin cleanup retracts projections through the official disposer (HMR safety)', async () => {
  const { installAgentRuntime: install } = await import('../lib/workspace-runtime.js')
  const fixture = await createRuntimeFixture()
  try {
    const cleanup = install(fixture.ctx)
    const A = makeSession(fixture, 'A')
    const B = makeSession(fixture, 'B')
    await (await fixture.agentsService.create({ setup: undefined })).setup(A, A.sessionAgent)
    await (await fixture.agentsService.resume({ setup: undefined })).setup(B, B.sessionAgent)
    await fixture.connectAll()
    assert.equal(fixture.createdScopes.length, 1)
    assert.equal(fixture.ownToolNames(A).length, 2)
    assert.equal(fixture.ownToolNames(B).length, 2)
    // 模拟插件 HMR 重载：卸载旧实例（installAgentRuntime 返回的 cleanup 即 ctx.effect 的清理体）。
    await cleanup()
    assert.deepEqual(fixture.ownToolNames(A), [], 'HMR 后运行中会话的工具投射必须撤回')
    assert.deepEqual(fixture.ownToolNames(B), [])
    assert.equal(fixture.createdScopes[0].disposed, true, 'HMR 后共享连接必须释放')
    assert.equal(fixture.connectionCount, 0)
    // 会话之后正常销毁：slot 的 disposer 已被 cleanup 跑过，必须幂等（不重复释放、不负计数）。
    await A.dispose()
    await B.dispose()
    assert.equal(fixture.connectionCount, 0, '重复释放不得把计数压到负数或再次 dispose 连接')
  } finally {
    await fixture.cleanup()
  }
})

// ── 多 app root：一个 root 的 tools/change 与释放不得影响另一个 root 的投射/连接 ──
test('shared project connection: separate app roots never interfere', async () => {
  const { installAgentRuntime: install } = await import('../lib/workspace-runtime.js')
  const f1 = await createRuntimeFixture()
  const f2 = await createRuntimeFixture()
  try {
    install(f1.ctx)
    install(f2.ctx)
    const A = makeSession(f1, 'A')
    const B = makeSession(f2, 'B')
    await (await f1.agentsService.create({ setup: undefined })).setup(A, A.sessionAgent)
    await (await f2.agentsService.create({ setup: undefined })).setup(B, B.sessionAgent)
    await f1.connectAll()
    await f2.connectAll()
    assert.equal(f1.connectionCount, 1)
    assert.equal(f2.connectionCount, 1)
    assert.equal(f1.ownToolNames(A).length, 2)
    assert.equal(f2.ownToolNames(B).length, 2)
    // 关掉 app1 的会话：连接进入空闲（不拆），app2 的连接与投射完全不受影响。
    await A.dispose()
    assert.equal(f1.connectionCount, 1, '会话关闭不等于连接关闭（空闲保留）')
    assert.deepEqual(f1.ownToolNames(A), [], 'app1 的投射必须撤回')
    assert.equal(f2.connectionCount, 1, '另一个 app root 的连接不得被牵连')
    assert.equal(f2.ownToolNames(B).length, 2)
  } finally {
    await f1.cleanup()
    await f2.cleanup()
  }
})

// ── 会话在建连期间被销毁：dsh-agent-loop 的 setupAndPublish 用 raceAbort 抛弃 setup 但不取消它。
//    所有权凭 cordis 的 assertActive 判定：作用域已销毁时 agentCtx.effect() 直接抛，引用当场归还。 ──
test('shared project connection: a session disposed mid-connect returns its reference (no leaked reference)', async () => {
  const { installAgentRuntime: install, readWorkspaceConfigCached, workspaceConnectionStatus } = await import('../lib/workspace-runtime.js')
  // 空闲超时留得比下面那句「等 setup 续跑」的 30ms 长，否则断言时连接已经被空闲回收了。
  const fixture = await createRuntimeFixture({ idleTimeoutMs: 200 })
  try {
    install(fixture.ctx)
    await readWorkspaceConfigCached(fixture.ctx, fixture.wsRoot)
    const originalImport = fixture.ctx.loader.import
    let releaseImport
    fixture.ctx.loader.import = (name) => (name === '@deepseek-ai/dsh-scope'
      ? originalImport(name)
      : new Promise((resolve) => { releaseImport = () => resolve({ apply: () => {}, inject: [], name: 'mcp-client', Config: undefined }) }))
    const A = makeSession(fixture, 'A')
    const pending = (await fixture.agentsService.create({ setup: undefined })).setup(A, A.sessionAgent)
    const deadline = Date.now() + 2000
    while (!releaseImport && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 1))
    assert.ok(releaseImport, 'setup 必须已停在共享连接的模块加载上')
    // 会话此刻销毁（宿主已经在跑 prepared.dispose()），被抛弃的 setup 稍后才续跑。
    await A.dispose()
    releaseImport()
    await pending
    await new Promise((resolve) => setTimeout(resolve, 30))
    // 引用必须归零（这是这条用例真正守的性质）；连接本身按新语义进入空闲等待，由空闲超时回收。
    const idle = workspaceConnectionStatus(fixture.ctx, fixture.wsRoot, { name: 'db' })
    assert.equal(idle.refs, 0, '被抛弃的 setup 不得留下悬挂的引用计数')
    assert.equal(idle.mounted, true, '空闲连接仍然存在（这正是「下次要用时已经就绪」）')
    assert.equal(fixture.ownToolNames(A).length, 0, '已销毁的会话不应留下工具投射')
    assert.ok(fixture.warns.some((line) => line.includes('已归还共享连接引用')), JSON.stringify(fixture.warns))
    assert.ok(await waitFor(() => fixture.createdScopes[0].disposed), '空闲超时后必须回收这条连接')
  } finally {
    await fixture.cleanup()
  }
})

// ── 插件在建连期间被 HMR 卸载：generation 令牌（而不是会话记录）负责这条判定，引用同样归还。 ──
test('shared project connection: a plugin unloaded mid-connect returns the reference (generation token)', async () => {
  const { installAgentRuntime: install, readWorkspaceConfigCached } = await import('../lib/workspace-runtime.js')
  const fixture = await createRuntimeFixture()
  try {
    const cleanup = install(fixture.ctx)
    await readWorkspaceConfigCached(fixture.ctx, fixture.wsRoot)
    const originalImport = fixture.ctx.loader.import
    let releaseImport
    fixture.ctx.loader.import = (name) => (name === '@deepseek-ai/dsh-scope'
      ? originalImport(name)
      : new Promise((resolve) => { releaseImport = () => resolve({ apply: () => {}, inject: [], name: 'mcp-client', Config: undefined }) }))
    const A = makeSession(fixture, 'A')
    const pending = (await fixture.agentsService.create({ setup: undefined })).setup(A, A.sessionAgent)
    const deadline = Date.now() + 2000
    while (!releaseImport && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 1))
    assert.ok(releaseImport, 'setup 必须已停在共享连接的模块加载上')
    // 会话仍然活着（effect 不会抛），但本代装饰器已经卸载：不能接管，否则谁都不会释放它。
    await cleanup()
    releaseImport()
    await pending
    await new Promise((resolve) => setTimeout(resolve, 30))
    assert.equal(fixture.connectionCount, 0, '插件已卸载，飞行中的 setup 建出的连接必须当场归还')
    assert.equal(fixture.ownToolNames(A).length, 0)
    assert.ok(fixture.warns.some((line) => line.includes('插件已卸载')), JSON.stringify(fixture.warns))
  } finally {
    await fixture.cleanup()
  }
})

// ── 空闲保留态下的插件卸载：本改动新引入的生命周期状态（会话全没了、连接还留着）。
//    这条**不在替身夹具里**断言：真实 teardown 靠 cordis 的 fiber 级联（createScope 用
//    `ctx.plugin(scope)` 把作用域 fiber 挂在插件 fiber 下），而夹具的 createScope 是假的、
//    看不到级联。真实行为由 test/real-host-integration.test.mjs 的真宿主用例覆盖。 ──

// ── 生产主路径：真实 mcp-client 在 setup 当场还没注册任何工具（apply 在 cordis 的微任务里跑，
//    工具要等 connect + tools/list），投射完全依赖后续的 tools/change。 ──
test('shared project connection: tools registered after connect reach every live session via tools/change', async () => {
  const { installAgentRuntime: install } = await import('../lib/workspace-runtime.js')
  const fixture = await createRuntimeFixture()
  try {
    install(fixture.ctx)
    const A = makeSession(fixture, 'A')
    const B = makeSession(fixture, 'B')
    await (await fixture.agentsService.create({ setup: undefined })).setup(A, A.sessionAgent)
    await (await fixture.agentsService.resume({ setup: undefined })).setup(B, B.sessionAgent)
    assert.equal(fixture.connectionCount, 1)
    assert.deepEqual(fixture.ownToolNames(A), [], 'setup 当场共享连接尚未注册工具')
    assert.deepEqual(fixture.ownToolNames(B), [])
    // 连接就绪 → mcp-client 注册工具 → tools/change。
    await fixture.publishTools(fixture.createdScopes[0])
    assert.deepEqual(fixture.ownToolNames(A), ['mcp__db__x', 'mcp__db__y'], '就绪后必须补投射进每个存活会话')
    assert.deepEqual(fixture.ownToolNames(B), ['mcp__db__x', 'mcp__db__y'])
  } finally {
    await fixture.cleanup()
  }
})

// ── 插件卸载必须能被宿主 await 到连接真正关闭，否则关停会早于 MCP 子进程退出。
//    会话销毁**不再**等于连接关闭（它只把连接留在空闲池里），所以 teardown promise 只在卸
//    载/重建这类「不再有效」的路径上产生。 ──
test('shared project connection: plugin unload teardown stays awaitable by the host', async () => {
  const { installAgentRuntime: install } = await import('../lib/workspace-runtime.js')
  const bySession = await createRuntimeFixture()
  try {
    install(bySession.ctx)
    const A = makeSession(bySession, 'A')
    await (await bySession.agentsService.create({ setup: undefined })).setup(A, A.sessionAgent)
    assert.equal(bySession.connectionCount, 1)
    await A.dispose()
    assert.equal(bySession.connectionCount, 1, '会话销毁后连接必须保留（空闲），不再产生 teardown')
  } finally {
    await bySession.cleanup()
  }
  const byUnload = await createRuntimeFixture()
  try {
    const cleanup = install(byUnload.ctx)
    await (await byUnload.agentsService.create({ setup: undefined })).setup(...spawn(makeSession(byUnload, 'A')))
    assert.equal(byUnload.connectionCount, 1)
    await cleanup()
    assert.equal(byUnload.connectionCount, 0, '插件卸载的 cleanup 必须返回 teardown promise')
  } finally {
    await byUnload.cleanup()
  }
})

// ── 配置变更：**就地重载**共享连接，而不是「继续复用旧的 + 等所有会话结束」。
//    依据是宿主自己的配置条目语义（mcp-client README: "Editing the configuration entry reloads
//    the server connection in place, and unchanged names stay unchanged"），而工具名是
//    (serverName, rawName) 的纯函数，所以重载不会让会话历史/权限规则失效。 ──
test('shared project connection: a config change reloads the shared connection in place', async () => {
  const { installAgentRuntime: install, workspaceConnectionStatus, readWorkspaceConfigCached } = await import('../lib/workspace-runtime.js')
  const fixture = await createRuntimeFixture()
  try {
    install(fixture.ctx)
    const A = makeSession(fixture, 'A')
    await (await fixture.agentsService.create({ setup: undefined })).setup(...spawn(A))
    assert.equal(fixture.mounts.at(-1)[1].command, 'psql')
    assert.equal(fixture.createdScopes.length, 1)
    await fixture.connectAll()
    assert.deepEqual(fixture.ownToolNames(A), ['mcp__db__x', 'mcp__db__y'])

    // 用户改了 .dsh/mcp.json（长度不同，必然绕过 mtime+size 短路），随后开新会话：
    // 挂载路径发现指纹变了 → 就地重载（旧连接 retire、新连接按新配置建）。
    await writeFile(join(fixture.wsRoot, '.dsh', 'mcp.json'), JSON.stringify({
      mcpServers: { db: { command: 'psql-next-generation', env: { KEY: '${KEY}' } } },
      exclude: ['github'],
    }, null, 2))
    const B = makeSession(fixture, 'B')
    await (await fixture.agentsService.resume({ setup: undefined })).setup(...spawn(B))
    assert.equal(fixture.createdScopes.length, 2, '配置变了必须重载：新的作用域 + 新的连接实例')
    assert.equal(fixture.createdScopes[0].disposed, true, '旧连接必须被销毁，不能留下双连接')
    assert.equal(fixture.connectionCount, 1, '同一时刻只应有一条')
    assert.equal(fixture.mounts.at(-1)[1].command, 'psql-next-generation')
    assert.ok(fixture.warns.some((line) => line.includes('就地重载')), '重载必须留下日志，' + JSON.stringify(fixture.warns))

    // 工具名不变（纯函数），所以旧会话不需要重开：它的槽位被重新指向新连接。
    await fixture.connectAll()
    assert.deepEqual(fixture.ownToolNames(A), ['mcp__db__x', 'mcp__db__y'], '旧会话的工具名集合必须不变')
    const after = await readWorkspaceConfigCached(fixture.ctx, fixture.wsRoot)
    const status = workspaceConnectionStatus(fixture.ctx, fixture.wsRoot, after.servers[0])
    assert.equal(status.configStale, false, '重载之后不再存在「配置待生效」这个长期状态')
    assert.equal(status.refs, 2)
  } finally {
    await fixture.cleanup()
  }
})

// ── 面板必须能枚举项目 MCP 的工具：它们注册在共享作用域层里，toolInventory 走的全局视图看不到。
//    而且必须按 (wsPath, serverName) 精确定位：手工编辑 .dsh/mcp.json 能造出两个项目同名。 ──
test('shared project connection: the panel enumerates project MCP tools by (wsPath, serverName)', async () => {
  const { installAgentRuntime: install } = await import('../lib/workspace-runtime.js')
  const { McpManagerGateway } = await import('../lib/index.js')
  const fixture = await createRuntimeFixture()
  try {
    install(fixture.ctx)
    const gateway = { ctx: fixture.ctx }
    const listTools = (payload) => McpManagerGateway.prototype.tools.call(gateway, payload)
    assert.deepEqual((await listTools({ name: 'db', wsPath: fixture.wsRoot })).tools, [], '尚无会话持有连接时应为空')
    await (await fixture.agentsService.create({ setup: undefined })).setup(...spawn(makeSession(fixture, 'A')))
    await fixture.connectAll()
    const listed = await listTools({ name: 'db', wsPath: fixture.wsRoot })
    assert.deepEqual(listed.tools.map((t) => t.name).sort(), ['mcp__db__x', 'mcp__db__y'])
    assert.equal(listed.ambiguous, false)
    // 另一个项目问同名 server：不能把本项目的工具列给它。
    assert.deepEqual((await listTools({ name: 'db', wsPath: fixture.wsRoot + '-other' })).tools, [], '跨项目同名不得串工具')
    // 全局 MCP 仍走原来的 toolInventory 通路（只传名字）。
    assert.deepEqual((await listTools({ name: 'github' })).tools.map((t) => t.name), ['mcp__github__a'])
  } finally {
    await fixture.cleanup()
  }
})

// ── 项目行状态与全局走同一个判定函数（deriveMcpPhase）：连接态取自 cordis fiber 的状态代号，
//    而不是猜 mcp-client 的日志文案。重连耗尽（fiber ACTIVE + 零工具）必须读成失败，不是恒显连接中。 ──
test('shared project connection: the row status comes from deriveMcpPhase over the fiber state, not log guessing', async () => {
  const { installAgentRuntime: install, readWorkspaceConfigCached } = await import('../lib/workspace-runtime.js')
  const { summarizeWorkspaceRow } = await import('../lib/index.js')
  const fixture = await createRuntimeFixture()
  try {
    install(fixture.ctx)
    const server = (await readWorkspaceConfigCached(fixture.ctx, fixture.wsRoot)).servers[0]
    // 尚无会话持有连接：没有 fiber，与全局「条目未加载」同义。
    const idle = summarizeWorkspaceRow(fixture.ctx, fixture.wsRoot, server, undefined)
    assert.equal(idle.status, 'stopped')
    assert.equal(idle.refs, 0)

    await (await fixture.agentsService.create({ setup: undefined })).setup(...spawn(makeSession(fixture, 'A')))
    // fiber ACTIVE（mcp-client 的 apply 等到首次连接与 tools/list 结束才 ACTIVE）且零工具：终态失败。
    // 这条判定不需要任何日志——文案只用来填 lastError。
    const failed = summarizeWorkspaceRow(fixture.ctx, fixture.wsRoot, server, undefined)
    assert.equal(failed.status, 'failed', 'ACTIVE + 零工具就是不可用的终态，不该显示连接中')
    assert.match(failed.lastError, /未注册任何工具/)
    assert.notEqual(failed.mountFailed, true, '这是连接失败，不是挂载失败')
    // 有 mcp-client 日志时，用它替换 lastError 的文案（原因更具体），状态判定不变。
    fixture.emitMcpLog('error', 'mcp-client(db): giving up after 10 consecutive failed reconnect attempts — tools unregistered')
    const withLog = summarizeWorkspaceRow(fixture.ctx, fixture.wsRoot, server, undefined)
    assert.equal(withLog.status, 'failed')
    assert.match(withLog.lastError, /giving up/)
    // 工具就绪后：已连接。
    await fixture.connectAll()
    const connected = summarizeWorkspaceRow(fixture.ctx, fixture.wsRoot, server, undefined)
    assert.equal(connected.status, 'connected')
    assert.equal(connected.toolCount, 2)
    assert.equal(connected.lastError, null)
    assert.equal(connected.refs, 1)
    // 挂载失败是另一条通路：标记与文案都不同，面板不会把两者混成一句。
    const mountFailedRow = summarizeWorkspaceRow(fixture.ctx, fixture.wsRoot, server, 'command 求值为空')
    assert.equal(mountFailedRow.mountFailed, true)
    assert.match(mountFailedRow.lastError, /求值为空/)
    // 禁用的行与全局一致读成 disabled（而不是「连接中」那种误导性的加载态）。
    const disabled = summarizeWorkspaceRow(fixture.ctx, fixture.wsRoot, { ...server, disabled: true }, undefined)
    assert.equal(disabled.status, 'disabled')
  } finally {
    await fixture.cleanup()
  }
})

// ── 跨项目同名 serverName：0.1.5 起是合法配置（官方按注册作用域判重），两个项目各自的共享
//    作用域互不干扰，各自拿到自己的工具；面板只把「还有谁同名」当诊断事实，不写成失败原因。 ──
test('shared project connection: a duplicate serverName across projects stays isolated and is reported as a diagnostic fact', async () => {
  const { installAgentRuntime: install, readWorkspaceConfigCached } = await import('../lib/workspace-runtime.js')
  const { summarizeWorkspaceRow } = await import('../lib/index.js')
  const fixture = await createRuntimeFixture()
  const other = await mkdtemp(join(tmpdir(), 'dsh-mcp-dup-'))
  try {
    await mkdir(join(other, '.dsh'), { recursive: true })
    await writeFile(join(other, '.dsh', 'mcp.json'), JSON.stringify({ mcpServers: { db: { command: 'psql' } } }))
    install(fixture.ctx)
    const A = makeSession(fixture, 'A')
    const B = makeSession(fixture, 'B')
    B.sessionAgent.session.header.cwd = other
    await (await fixture.agentsService.create({ setup: undefined })).setup(A, A.sessionAgent)
    await (await fixture.agentsService.resume({ setup: undefined })).setup(B, B.sessionAgent)
    await fixture.connectAll()
    // 两个项目各有自己的共享作用域，各自的工具只进各自会话的 own 层。
    assert.equal(fixture.createdScopes.length, 2)
    assert.deepEqual(fixture.ownToolNames(A), ['mcp__db__x', 'mcp__db__y'])
    assert.deepEqual(fixture.ownToolNames(B), ['mcp__db__x', 'mcp__db__y'])
    const server = (await readWorkspaceConfigCached(fixture.ctx, fixture.wsRoot)).servers[0]
    const row = summarizeWorkspaceRow(fixture.ctx, fixture.wsRoot, server, undefined)
    assert.deepEqual(row.duplicateOwners, [other], '同名必须作为诊断事实可观测')
    // 同名不等于冲突：官方按注册作用域判重，两个项目各自连上、各自拿到工具，所以不得把一条
    // 健康连接写成失败原因（只有 mountFailed / status=failed 时才把同名解释成可能的原因）。
    assert.equal(row.mountFailed, undefined)
    assert.equal(row.lastError, null)
  } finally {
    await rm(other, { recursive: true, force: true })
    await fixture.cleanup()
  }
})

// ── 单个工具注册失败不能被同一轮里后一个工具的成功抹掉（否则面板一切正常而会话缺工具）。 ──
test('shared project connection: one tool failing to register is not erased by a sibling success', async () => {
  const { installAgentRuntime: install, workspaceMountErrorsView } = await import('../lib/workspace-runtime.js')
  const fixture = await createRuntimeFixture()
  try {
    install(fixture.ctx)
    const A = makeSession(fixture, 'A')
    const original = A.tools.register.bind(A.tools)
    A.tools.register = (def) => {
      if (def.name === 'mcp__db__x') throw new Error('tool name collision')
      return original(def)
    }
    await (await fixture.agentsService.create({ setup: undefined })).setup(A, A.sessionAgent)
    await fixture.connectAll()
    assert.deepEqual(fixture.ownToolNames(A), ['mcp__db__y'], '成功的那个仍应注册')
    assert.deepEqual(workspaceMountErrorsView(fixture.wsRoot), [{ serverName: 'db', error: 'tool name collision' }], '失败必须留在可观测记录里')
  } finally {
    await fixture.cleanup()
  }
})

// ── 键约定入口：appRoot 只接受真 ctx，传错会当场抛而不是把状态写进一个随手造的键里。 ──
test('shared project connection: the key convention entry rejects a non-context argument', async () => {
  const { workspaceToolSchemas } = await import('../lib/workspace-runtime.js')
  assert.throws(() => workspaceToolSchemas(undefined, 'db'), /cordis context/)
  assert.throws(() => workspaceToolSchemas('not-a-ctx', 'db'), /cordis context/)
})

// ── HMR 新旧两代重叠：被取代的旧代只收回自己的订阅，不得撕掉存活代的投射与会话记录。
//    这三件销毁动作（令牌/会话记录/投射）必须共用同一条归属判定 —— 只守住令牌那一件，
//    就等于承认重叠存在、却让另外两件在重叠时破坏存活代。 ──
test('shared project connection: a superseded generation leaves the surviving generation intact', async () => {
  const { installAgentRuntime: install, projectConnectionsView, reconcileWorkspaceConnections } = await import('../lib/workspace-runtime.js')
  const fixture = await createRuntimeFixture()
  try {
    // 重叠：新一代先装上，旧代随后才清理（HMR 的安装与卸载两半不同步）。
    const oldCleanup = install(fixture.ctx)
    const newCleanup = install(fixture.ctx)
    const A = makeSession(fixture, 'A')
    await (await fixture.agentsService.create({ setup: undefined })).setup(A, A.sessionAgent)
    await fixture.connectAll()
    assert.deepEqual(fixture.ownToolNames(A).sort(), ['mcp__db__x', 'mcp__db__y'])
    assert.equal(fixture.connectionCount, 1)

    await oldCleanup()
    // 存活代的投射、连接、会话记录都必须还在。
    assert.deepEqual(fixture.ownToolNames(A).sort(), ['mcp__db__x', 'mcp__db__y'], '旧代清理不得撕掉存活代的工具投射')
    assert.equal(fixture.connectionCount, 1, '旧代清理不得销毁存活代的连接')
    const rows = await projectConnectionsView(fixture.ctx)
    assert.equal(rows.length, 1, '存活代的会话记录不得被旧代清理抹掉')
    // 会话记录若被旧代抹掉，配置对齐就再也找不到这个会话（remounted 恒为 0）—— 这条钉住那个后果。
    const remounted = await reconcileWorkspaceConnections(fixture.ctx, fixture.wsRoot)
    assert.equal(remounted.remounted, 1, '存活代仍必须能对齐它自己的存活会话')
    assert.deepEqual(fixture.ownToolNames(A).sort(), ['mcp__db__x', 'mcp__db__y'])

    // 存活代自己卸载：这时才把共享状态收干净。
    await newCleanup()
    assert.equal(fixture.connectionCount, 0, '末代卸载必须销毁连接')
    assert.deepEqual(fixture.ownToolNames(A), [], '末代卸载必须撤回投射')
  } finally {
    await fixture.cleanup()
  }
})

// ── 订阅失败必须回滚：ctx.on 抛出时不能留下半个挂载器（旧实现对应「不能留下被改写的方法」）。 ──
test('agent runtime install rolls back its subscriptions when subscribing fails', async () => {
  const { installAgentRuntime: install } = await import('../lib/workspace-runtime.js')
  const fixture = await createRuntimeFixture()
  try {
    assert.throws(() => install({ ...fixture.ctx, effect: undefined }), /effect\(\)/, '没有生命周期归属就不该装')
    const failure = new Error('subscribe refused')
    // agent/created 订阅成功、tools/change 订阅抛错：前者必须被收回去。
    const broken = {
      ...fixture.ctx,
      on(event, handler) {
        if (event === 'tools/change') throw failure
        return fixture.ctx.on(event, handler)
      },
    }
    assert.throws(() => install(broken), /subscribe refused/)
    assert.equal(fixture.handlers['agent/created'], undefined, '失败的安装不得留下订阅')
    // 事后仍可正常安装。
    const cleanup = install(fixture.ctx)
    assert.equal(typeof fixture.handlers['agent/created'], 'function')
    await cleanup()
    assert.equal(fixture.handlers['agent/created'], undefined)
  } finally {
    await fixture.cleanup()
  }
})

// ── 只读诊断视图：面板每行只看得见自己那一格，看不到「本进程共有几条共享连接、refs 有没有
//    卡住不归零」。这条视图要如实给出 refs 与 sessions 两个独立事实（相等=健康），并覆盖
//    ready / disposing 两种 cell 状态；它必须全程只读，不得改动引用计数。 ──
test('shared project connection: the read-only diagnostics view reports refs and sessions per connection', async () => {
  const { installAgentRuntime: install, projectConnectionsView } = await import('../lib/workspace-runtime.js')
  const fixture = await createRuntimeFixture()
  try {
    install(fixture.ctx)
    const A = makeSession(fixture, 'A')
    const B = makeSession(fixture, 'B')
    await (await fixture.agentsService.create({ setup: undefined })).setup(A, A.sessionAgent)
    await (await fixture.agentsService.resume({ setup: undefined })).setup(B, B.sessionAgent)
    await fixture.connectAll()

    const rows = await projectConnectionsView(fixture.ctx)
    assert.equal(rows.length, 1, '同项目两个会话只应有一条共享连接')
    assert.deepEqual(rows[0], {
      wsPath: fixture.wsRoot,
      serverName: 'db',
      sessions: 2,
      duplicateOwners: [],
      state: 'ready',
      refs: 2,
      // 空闲回收策略与当前是否处于空闲等待：面板据此区分「暂时没人用」与「连接没了」。
      idleTimeoutMs: 300000,
      idle: false,
      toolCount: 2,
      // fiber 的状态代号原样带出（2 = ACTIVE），面板/排障可以直接喂给 deriveMcpPhase。
      fiberState: 2,
      configStale: false,
      configError: '',
      scopeError: '',
    })
    // 只读：问一次诊断不得动引用计数，否则这个接口自己就会把连接锁死或提前释放。
    assert.equal((await projectConnectionsView(fixture.ctx))[0].refs, 2)
    assert.equal(fixture.connectionCount, 1)

    await A.dispose()
    const afterOne = await projectConnectionsView(fixture.ctx)
    assert.equal(afterOne[0].refs, 1, '一个会话结束后引用应减一')
    assert.equal(afterOne[0].sessions, 1, 'refs 与 sessions 必须同步下降（不相等即为漏引用）')

    await B.dispose()
    // 最后一个会话结束后：引用归零，但连接按新语义留在空闲池里 —— 视图如实带出 idle。
    const afterAll = await projectConnectionsView(fixture.ctx)
    assert.equal(afterAll.length, 1, '连接保留（空闲），不产生 disposing 占位')
    assert.equal(afterAll[0].refs, 0)
    assert.equal(afterAll[0].sessions, 0)
    assert.equal(afterAll[0].idle, true)
    assert.equal(fixture.connectionCount, 1)
  } finally {
    await fixture.cleanup()
  }
})

// ── 建连中（还没有 entry）也必须出现在视图里：卡在建连上恰恰是最需要排障的形态，
//    过滤掉等于看不见。此时没有连接态可读，configStale 给 null 而不是伪造 false。 ──
test('shared project connection: a connection still being established is visible as connecting', async () => {
  const { installAgentRuntime: install, projectConnectionsView } = await import('../lib/workspace-runtime.js')
  const fixture = await createRuntimeFixture()
  try {
    install(fixture.ctx)
    const originalImport = fixture.ctx.loader.import
    let releaseImport
    fixture.ctx.loader.import = (name) => (name === '@deepseek-ai/dsh-scope'
      ? originalImport(name)
      : new Promise((resolve) => { releaseImport = () => resolve({ apply: () => {}, inject: [], name: 'mcp-client', Config: undefined }) }))
    const A = makeSession(fixture, 'A')
    const pending = (await fixture.agentsService.create({ setup: undefined })).setup(A, A.sessionAgent)
    const deadline = Date.now() + 2000
    while (!releaseImport && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 1))
    assert.ok(releaseImport, 'setup 必须已停在共享连接的模块加载上')

    const rows = await projectConnectionsView(fixture.ctx)
    assert.equal(rows.length, 1)
    assert.equal(rows[0].state, 'connecting')
    assert.equal(rows[0].refs, 0)
    assert.equal(rows[0].sessions, 0)
    assert.equal(rows[0].configStale, null)
    assert.equal(rows[0].serverName, 'db')

    releaseImport()
    await pending
  } finally {
    await fixture.cleanup()
  }
})

test('scope failures are recorded and surfaced instead of reading as “connected”', async () => {
  const rt = await import('../lib/workspace-runtime.js')
  const { summarizeWorkspaceRow } = await import('../lib/index.js')
  const fixture = await createRuntimeFixture({ idleTimeoutMs: 20 })
  try {
    rt.installAgentRuntime(fixture.ctx)
    const session = makeSession(fixture, 'scope-1')
    // 两份 dsh-scope 实例的症状从建连起就存在：工具被注册到全局层。判定在「首次
    // fiber ACTIVE 读取时」一次性定论（否则每行每 5s 轮询都要比一次全局视图），
    // 所以泄漏事实必须在 setup 之前就位——这与真实故障的时序一致。
    fixture.globalSchemas.push({ name: 'mcp__db__leaked' })
    const created = await fixture.agentsService.create({ setup: undefined })
    await created.setup(session.ctx, session.sessionAgent)

    const status = rt.workspaceConnectionStatus(fixture.ctx, fixture.wsRoot, { name: 'db' })
    assert.match(status.scopeError, /有多份模块实例/, '作用域故障必须带出可判定的原因')

    // 面板行：必须标成作用域故障，而不是「0 工具 → 连接失败」——否则用户会去查 MCP 配置。
    // （真实宿主上 schemas(scopeKey) 认不出标签时会退回全局层，因此工具数是「读到」的而不是 0，
    //  这条更隐蔽的形状由 real-host-integration.test.mjs 用真 dsh-tools 覆盖；这里的替身只建模
    //  作用域层，所以不断言读取结果，只断言判定与上报。）
    const row = summarizeWorkspaceRow(fixture.ctx, fixture.wsRoot, { name: 'db', transport: 'stdio' }, undefined)
    assert.equal(row.status, 'failed')
    assert.equal(row.scopeFailed, true)
    assert.notEqual(row.mountFailed, true, '这是作用域故障，不是挂载失败')
    assert.match(row.lastError, /全局层/)

    // 只读排障视图同样如实带出（面板暂未接线，这条接口是排障入口）。
    const rows = await rt.projectConnectionsView(fixture.ctx)
    assert.match(rows.find((entry) => entry.serverName === 'db').scopeError, /全局层/)
    assert.equal(rt.workspaceScopeErrorsView(fixture.wsRoot).length, 1)

    // 面板每 5s 轮询都会走到这条路径：同一故障只该打一条日志，且结论不翻腾。
    const warnings = fixture.warns.filter((line) => line.includes('作用域工具视图不可用'))
    assert.equal(warnings.length, 1, JSON.stringify(fixture.warns))
    rt.workspaceConnectionStatus(fixture.ctx, fixture.wsRoot, { name: 'db' })
    assert.equal(fixture.warns.filter((line) => line.includes('作用域工具视图不可用')).length, 1)
    assert.equal(rt.workspaceScopeErrorsView(fixture.wsRoot).length, 1)

    // 故障消失（依赖树修复）后**新连接**必须重新判定：记账要能清掉，不能变永久假警报。
    // 新连接 = 旧连接被回收之后重建，所以这里用短空闲超时等到回收，再开新会话。
    fixture.globalSchemas.pop()
    await session.dispose()
    assert.ok(await waitFor(() => fixture.createdScopes[0].disposed), '空闲超时后旧连接必须回收，才有“新连接”可判')
    const healedSession = makeSession(fixture, 'scope-1-healed')
    const healedCreated = await fixture.agentsService.create({ setup: undefined })
    await healedCreated.setup(healedSession.ctx, healedSession.sessionAgent)
    fixture.publishTools(fixture.createdScopes.at(-1))
    const healed = rt.workspaceConnectionStatus(fixture.ctx, fixture.wsRoot, { name: 'db' })
    assert.equal(healed.scopeError, '')
    assert.deepEqual(rt.workspaceScopeErrorsView(fixture.wsRoot), [])
    assert.equal(summarizeWorkspaceRow(fixture.ctx, fixture.wsRoot, { name: 'db', transport: 'stdio' }, undefined).scopeFailed, undefined)
  } finally {
    await fixture.cleanup()
  }
})

test('a same-named global instance is never reported as a scope failure (undecidable, so not asserted)', async () => {
  const rt = await import('../lib/workspace-runtime.js')
  const { summarizeWorkspaceRow } = await import('../lib/index.js')
  // github 既有同名全局 loader 条目、它的工具又出现在全局视图里：与本项目连接的“泄漏”不可区分。
  const fixture = await createRuntimeFixture({ extraServers: { github: { command: 'gh-mcp' } } })
  try {
    rt.installAgentRuntime(fixture.ctx)
    const session = makeSession(fixture, 'scope-2')
    const created = await fixture.agentsService.create({ setup: undefined })
    await created.setup(session.ctx, session.sessionAgent)

    const status = rt.workspaceConnectionStatus(fixture.ctx, fixture.wsRoot, { name: 'github' })
    assert.equal(status.scopeError, '', '同名实例存在时不可判定，宁可不断言也不能冤枉健康连接')
    const row = summarizeWorkspaceRow(fixture.ctx, fixture.wsRoot, { name: 'github', transport: 'stdio' }, undefined)
    assert.notEqual(row.scopeFailed, true)
    assert.equal(row.status, 'failed', '连接已 ACTIVE 且 0 工具：仍按既有的 deriveMcpPhase 读作失败')
  } finally {
    await fixture.cleanup()
  }
})

test('a workspace registry failure is reported once instead of silently showing no projects', async () => {
  const rt = await import('../lib/workspace-runtime.js')
  const fixture = await createRuntimeFixture()
  try {
    const originalGet = fixture.ctx.get
    const unique = `registry down ${Date.now()}`
    fixture.ctx.get = (name) => (name === 'workspaceRegistry'
      ? { list() { throw new Error(unique) } }
      : originalGet(name))

    assert.deepEqual(await rt.listWorkspaceRecords(fixture.ctx), [])
    assert.deepEqual(await rt.listWorkspaceRecords(fixture.ctx), [])
    const warnings = fixture.warns.filter((line) => line.includes('读取工作区注册表失败'))
    assert.equal(warnings.length, 1, '轮询会重复走到这里，同一故障只该打一条日志')
    assert.match(warnings[0], new RegExp(unique))
  } finally {
    await fixture.cleanup()
  }
})
