// R2 复现：删掉挂载失败的条目后，getWorkspaceView 的 mountErrors 仍把它列出来。
//
// 用法（在隔离工作树根目录）：
//   cp <repo>/.tasks/review-1.11.1/repro/r2-stale-diagnostics.test.mjs .tmp-review/
//   node --test .tmp-review/r2-stale-diagnostics.test.mjs 2>&1 | grep '\[R2\]'
//
// ⚠️ 本文件 = `head -350 test/workspace-runtime.test.mjs`（sha256 前缀 7d9dc638088d2b45）
//    + 末尾追加的 R2 用例（第 353 行起）。若那份夹具变了，重新生成：
//    生成命令：取那份夹具前 350 行，再追加本文件末尾的 R2 用例。
//
// 期望（修复前）：
//   [R2] 删除后 servers = [] | mountErrors = [{"serverName":"db", ...}]
// 期望（修复后）：
//   [R2] 删除后 servers = [] | mountErrors = []
import { pathToFileURL } from 'node:url'
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { installAgentRuntime } from '../lib/workspace-runtime.js'
import { projectMcpServers } from '../lib/workspace-runtime.js'
import { agentToolLoadingPolicy, setAgentToolLoadingPolicy } from '../lib/workspace-runtime.js'
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
      { name: 'db', defer: false, wsPath: fixture.wsRoot },
      { name: 'deferred', defer: true, wsPath: fixture.wsRoot },
      { name: 'plain', defer: false, wsPath: fixture.wsRoot },
    ])
    // 全局族（loader 条目）与项目族（共享连接）合并成同一张表；项目族只取**本会话所在项目**。
    const agent = fixture.agentCtx.sessionAgent
    assert.deepEqual(serverNamesOf(fixture.ctx, agent).sort(), ['db', 'deferred', 'exa', 'github', 'plain'])
    assert.deepEqual(deferServersOf(fixture.ctx, agent), ['deferred'])

    // 项目策略随挂载进入会话状态；面板保存后由 setAgentToolLoadingPolicy 就地更新存活会话
    // （视图按 revision 自愈，不需要重连）。两个方向都钉住，避免"只写盘不生效"。
    // 没配过时是"跟随既有行为"（mode: legacy），不是 undefined：读侧归一后永远是一份可用策略。
    assert.deepEqual(agentToolLoadingPolicy(agent), { mode: 'legacy', groups: {}, tools: {} })
    const policy = { mode: 'recommended', groups: {}, tools: {} }
    assert.equal(setAgentToolLoadingPolicy(fixture.ctx, fixture.wsRoot, policy), 1, '本项目有 1 个存活会话')
    assert.deepEqual(agentToolLoadingPolicy(agent), policy)
    assert.equal(setAgentToolLoadingPolicy(fixture.ctx, fixture.wsRoot + '-other', policy), 0, '别的项目不受影响')
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
async function createRuntimeFixture({ deferTools = true, extraServers = {}, idleTimeoutMs, readyTimeoutMs, pendingFiber = false, fiberErrors = {}, exclude = ['github'] } = {}) {
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
    exclude,
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
  // 读面调用账本：宿主里 `get(name, scope)` 就是 `view(scope).visible.get(name)`，所以逐工具
  // get() 等于把整张表重建 N 次。替身必须把这几种重建暴露出来，否则这类 N+1 在测试里不可见。
  const toolReads = { views: [], schemas: 0, gets: 0 }
  let failToolReads = false
  // 真宿主的 register() 会同步派发 tools/change；替身默认关掉（否则每个用例都要处理重入），
  // 需要验证这条时序的用例显式打开。
  const registerCalls = []
  let emitsOnRegister = false
  // 合并视图对同一个工具必须返回**同一个对象**（真实宿主如此），否则「身份相同 ⇒ 不是我注册的」
  // 这条归属判定在替身里永远不成立，测试会假绿。
  const globalDefs = new Map()
  const globalDefOf = (schema) => {
    let definition = globalDefs.get(schema.name)
    if (!definition) { definition = { name: schema.name }; globalDefs.set(schema.name, definition) }
    return definition
  }
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
    // 形状照抄 dsh-tools：view() 是唯一的重建入口，get()/schemas() 都是它上面的投影。
    tools: {
      view(scope) {
        toolReads.views.push(scope)
        if (failToolReads) throw new Error('host tool view unavailable')
        const visible = new Map(globalSchemas.map((schema) => [schema.name, globalDefOf(schema)]))
        if (scope !== undefined) {
          for (const [name, definition] of scopedTools.get(scope) ?? []) visible.set(name, definition)
        }
        return { visible, knownNames: new Set(visible.keys()), restrictableNames: new Set(visible.keys()) }
      },
      schemas(scope) {
        toolReads.schemas += 1
        if (failToolReads) throw new Error('host tool view unavailable')
        return [...this.view(scope).visible.values()].map((definition) => this.schemaOf(definition, true))
      },
      schemaOf(definition, detachParameters) {
        // detach=true 在宿主里是深拷贝（snapshotJsonValue）；替身照做，免得投影形状与宿主分岔。
        const parameters = detachParameters ? structuredClone(definition.parameters) : definition.parameters
        return { name: definition.name, description: definition.description, parameters }
      },
      get(name, scope) {
        toolReads.gets += 1
        if (failToolReads) throw new Error('host tool view unavailable')
        return this.view(scope).visible.get(name)
      },
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
    toolReads,
    registerCalls,
    emitsOnRegister() { return emitsOnRegister },
    setEmitsOnRegister(on) { emitsOnRegister = on === true },
    resetRegisterCalls() { registerCalls.length = 0 },
    setGlobalTools(names) { globalSchemas.splice(0, globalSchemas.length, ...names.map((name) => ({ name }))) },
    failToolReads(on) { failToolReads = on === true },
    resetToolReads() { toolReads.views.length = 0; toolReads.schemas = 0; toolReads.gets = 0 },
    scopedViewReads() { return toolReads.views.filter((scope) => scope !== undefined) },
    globalViewReads() { return toolReads.views.filter((scope) => scope === undefined) },
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
    ownDefinitions(session) { return new Map(agentOwnTools.get(session.sessionAgent) ?? new Map()) },
    // mcp-client 的每一次 tools/list 同步都重建定义对象（同一批名字、新对象）：重连、list_changed 都是这个形状。
    republish(serverName) {
      for (const [scopeKey, name] of publishTargets) {
        if (name === serverName && scopedTools.has(scopeKey)) publish(scopeKey, serverName)
      }
    },
    currentDefinition(serverName, rawName) {
      for (const [scopeKey, name] of publishTargets) {
        if (name !== serverName) continue
        const found = scopedTools.get(scopeKey)?.get(`mcp__${serverName}__${rawName}`)
        if (found !== undefined) return found
      }
      return undefined
    },
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

test('R2 repro: stale mount error survives deletion', async () => {
  const rt = await import('../lib/workspace-runtime.js')
  const { readFile } = await import('node:fs/promises')
  const { McpManagerGateway } = await import('../lib/index.js')
  const fixture = await createRuntimeFixture({ exclude: [] })
  try {
    const rootConfig = join(fixture.wsRoot, 'cordis.yml')
    await writeFile(rootConfig, '[]\n')
    await writeFile(join(fixture.wsRoot, 'cordis.patch.yml'), '[]')
    // entries() 每次返回新数组：换成一个稳定数组，否则推入的 include 条目看不见。
    const entries = fixture.ctx.loader.entries()
    entries.push({ options: { id: 'include', name: 'cordis:include', config: { path: pathToFileURL(rootConfig).href } } })
    fixture.ctx.loader.entries = () => entries
    await writeFile(join(fixture.wsRoot, '.dsh', 'mcp.json'), JSON.stringify({ mcpServers: { db: { command: 'psql' } }, exclude: [] }, null, 2))
    const originalImport = fixture.ctx.loader.import
    fixture.ctx.loader.import = async (name) => {
      if (name === '@deepseek-ai/dsh-mcp-client') throw new Error('模拟：宿主未提供 mcp-client')
      return originalImport(name)
    }
    rt.installAgentRuntime(fixture.ctx)
    const created = await fixture.agentsService.create({ setup: undefined })
    await created.setup(fixture.agentCtx, fixture.agentCtx.sessionAgent)
    console.log('[R2] 挂载失败记录 =', JSON.stringify(rt.workspaceMountErrorsView(fixture.wsRoot)))
    const before = await McpManagerGateway.prototype.getWorkspaceView.call({ ctx: fixture.ctx }, { wsPath: fixture.wsRoot })
    console.log('[R2] 删除前 servers =', before.servers.map((s) => s.serverName), '| mountErrors =', before.mountErrors.length)
    try {
      const removed = await McpManagerGateway.prototype.removeWorkspaceServer.call({ ctx: fixture.ctx }, { wsPath: fixture.wsRoot, name: 'db' })
      console.log('[R2] removeWorkspaceServer =', JSON.stringify(removed?.persisted ?? removed))
    } catch (error) {
      console.log('[R2] removeWorkspaceServer 抛错，改用写盘路径:', error.message)
      await rt.writeWorkspaceConfigFile(fixture.wsRoot, [], [], undefined)
    }
    console.log('[R2] 盘上配置 =', (await readFile(join(fixture.wsRoot, '.dsh', 'mcp.json'), 'utf8')).replace(/\s+/g, ' '))
    const after = await McpManagerGateway.prototype.getWorkspaceView.call({ ctx: fixture.ctx }, { wsPath: fixture.wsRoot })
    console.log('[R2] 删除后 servers =', after.servers.map((s) => s.serverName), '| mountErrors =', JSON.stringify(after.mountErrors))
  } finally {
    await fixture.cleanup()
  }
})
