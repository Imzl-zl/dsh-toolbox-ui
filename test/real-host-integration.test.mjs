import assert from 'node:assert/strict'
import test from 'node:test'
import { existsSync } from 'node:fs'
import { createRequire } from 'node:module'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import * as scope from '@deepseek-ai/dsh-scope'
import {
  installAgentRuntime,
  projectConnectionsView,
  reconcileWorkspaceConnections,
  reconnectWorkspaceServer,
  workspaceMountErrorsView,
  workspaceScopeErrorsView,
  workspaceToolSchemas,
} from '../lib/workspace-runtime.js'

// 这一组用例打的是**真实官方包**（真 cordis / dsh-tools / dsh-scope / dsh-mcp-client + 真 stdio
// MCP 子进程），而不是替身：其余测试文件验证的是本插件内部自洽，只有这里能证明「共享作用域 +
// 工具投射 + monkey-patch setup」这套架构在官方契约上真的成立。
// 替身测不出的东西恰好是这里的地基：tools.schemas(scope) 按对象同一性查层、agentCtx 必须能
// 解析到 tools（dsh-agent-loop 的 AgentLoop.inject 含 tools）、mcp-client 的 serverName 注册表
// 按 scopeOf(ctx) 判重。
const TEST_TIMEOUT_MS = 60_000
const WAIT_MS = 20_000
const SCOPE_MODULE = '@deepseek-ai/dsh-scope'

// 最小 MCP stdio 服务：握手 + tools/list + tools/call，退出时落一个哨兵文件，
// 用来断言会话销毁后没有留下孤儿子进程。
const FIXTURE_SERVER = `
import { writeFileSync } from 'node:fs'
const sentinel = process.argv[2]
process.stdin.setEncoding('utf8')
let buf = ''
const send = (message) => process.stdout.write(JSON.stringify(message) + '\\n')
process.stdin.on('end', () => process.exit(0))
process.on('exit', () => { try { writeFileSync(sentinel, 'bye') } catch {} })
process.stdin.on('data', (chunk) => {
  buf += chunk
  let index
  while ((index = buf.indexOf('\\n')) >= 0) {
    const line = buf.slice(0, index)
    buf = buf.slice(index + 1)
    if (!line.trim()) continue
    const message = JSON.parse(line)
    if (message.method === 'initialize') {
      send({ jsonrpc: '2.0', id: message.id, result: {
        protocolVersion: message.params.protocolVersion,
        capabilities: { tools: {} },
        serverInfo: { name: 'fixture', version: '1.0.0' },
      } })
    } else if (message.method === 'tools/list') {
      send({ jsonrpc: '2.0', id: message.id, result: { tools: [{
        name: 'echo',
        description: 'Echo the given text back.',
        inputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] },
      }] } })
    } else if (message.method === 'tools/call') {
      send({ jsonrpc: '2.0', id: message.id, result: {
        content: [{ type: 'text', text: 'echo:' + String(message.params.arguments?.text ?? '') }],
      } })
    } else if (message.id !== undefined) {
      send({ jsonrpc: '2.0', id: message.id, result: {} })
    }
  }
})
`

// 可控版夹具：多一个 `exit` 工具（让服务器自己退出，用来制造真实的断连），并在启动时读一个
// 控制文件——文件内容为 fail 时立刻退出，用来让"重连预算耗尽"这件事在测试里几分钟变几百毫秒。
// 单独一份、不动 FIXTURE_SERVER，是为了不改变其他用例看到的工具数。
const FIXTURE_SERVER_CONTROLLABLE = `
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
const sentinel = process.argv[2]
const control = process.argv[3]
if (control && existsSync(control) && readFileSync(control, 'utf8').trim() === 'fail') process.exit(0)
process.stdin.setEncoding('utf8')
let buf = ''
const send = (message) => process.stdout.write(JSON.stringify(message) + '\\n')
process.stdin.on('end', () => process.exit(0))
process.on('exit', () => { try { writeFileSync(sentinel, 'bye') } catch {} })
process.stdin.on('data', (chunk) => {
  buf += chunk
  let index
  while ((index = buf.indexOf('\\n')) >= 0) {
    const line = buf.slice(0, index)
    buf = buf.slice(index + 1)
    if (!line.trim()) continue
    const message = JSON.parse(line)
    if (message.method === 'initialize') {
      send({ jsonrpc: '2.0', id: message.id, result: {
        protocolVersion: message.params.protocolVersion,
        capabilities: { tools: {} },
        serverInfo: { name: 'fixture', version: '1.0.0' },
      } })
    } else if (message.method === 'tools/list') {
      send({ jsonrpc: '2.0', id: message.id, result: { tools: [
        { name: 'echo', description: 'Echo the given text back.', inputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] } },
        { name: 'exit', description: 'Terminate this server process.', inputSchema: { type: 'object', properties: {} } },
      ] } })
    } else if (message.method === 'tools/call') {
      if (message.params?.name === 'exit') { process.exit(0) }
      send({ jsonrpc: '2.0', id: message.id, result: {
        content: [{ type: 'text', text: 'echo:' + String(message.params.arguments?.text ?? '') }],
      } })
    } else if (message.id !== undefined) {
      send({ jsonrpc: '2.0', id: message.id, result: {} })
    }
  }
})
`

// 可指定工具名的夹具服务：让「全局同名条目」提供与项目条目**不同**的工具集。同名但不同实例
// 要能被区分开，靠的正是工具集不同（否则两种行为在断言上不可分）。
const fixtureServerWithTool = (tool) => `
import { writeFileSync } from 'node:fs'
const sentinel = process.argv[2]
process.stdin.setEncoding('utf8')
let buf = ''
const send = (message) => process.stdout.write(JSON.stringify(message) + '\\n')
process.stdin.on('end', () => process.exit(0))
process.on('exit', () => { try { writeFileSync(sentinel, 'bye') } catch {} })
process.stdin.on('data', (chunk) => {
  buf += chunk
  let index
  while ((index = buf.indexOf('\\n')) >= 0) {
    const line = buf.slice(0, index)
    buf = buf.slice(index + 1)
    if (!line.trim()) continue
    const message = JSON.parse(line)
    if (message.method === 'initialize') {
      send({ jsonrpc: '2.0', id: message.id, result: {
        protocolVersion: message.params.protocolVersion,
        capabilities: { tools: {} },
        serverInfo: { name: '${tool}', version: '1.0.0' },
      } })
    } else if (message.method === 'tools/list') {
      send({ jsonrpc: '2.0', id: message.id, result: { tools: [{
        name: '${tool}',
        description: '${tool}',
        inputSchema: { type: 'object', properties: {} },
      }] } })
    } else if (message.method === 'tools/call') {
      send({ jsonrpc: '2.0', id: message.id, result: { content: [{ type: 'text', text: '${tool}' }] } })
    } else if (message.id !== undefined) {
      send({ jsonrpc: '2.0', id: message.id, result: {} })
    }
  }
})
`

async function waitFor(predicate, timeoutMs = WAIT_MS) {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const value = await predicate()
    if (value) return value
    if (Date.now() > deadline) return undefined
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
}

/**
 * 起一个真实宿主：真 Loader + 真 ToolRuntime + 真 scope，用最小替身只顶替 `agents`（官方契约是
 * `create/resume(options)`，由宿主调用 `options.setup(agentCtx, agent)`，agentCtx 是 loop scope ctx）。
 * @param wsRoot - 项目目录（含 .dsh/mcp.json）。
 * @param options.scopeModuleUrl - 用第二份 dsh-scope 实例加载（制造作用域身份失效）。
 * @param options.globalServers - 以**全局条目**的形态挂载的 mcp-client 实例（生产里就是 profile
 *   patch 里的 mcp 条目：它既在 `loader.entries()` 里，又有一条活在全局层的连接）。两者缺一都不是
 *   生产形状，所以这里两件一起做——否则插件会以为自己没有同名全局条目。
 * @returns 宿主句柄：ctx、tools、创建会话（可按工作区）、以及清理。
 */
async function createRealHost(wsRoot, { scopeModuleUrl, globalServers = [] } = {}) {
  const ctx = new Context()
  ctx.baseUrl = new URL('../', import.meta.url).href
  await ctx.plugin(Loader)
  const warnings = []
  // 插件的作用域故障记账会先 warn 一次：日志也是可观测面的一部分，用例要能断言它不刷屏。
  ctx.logger.exporter({ colors: 0, levels: { default: 3 }, export: (message) => { warnings.push(message.args.map(String).join(' ')) } })
  if (scopeModuleUrl) {
    // 制造真实的「两份 @deepseek-ai/dsh-scope 模块实例」：同一个文件用不同 URL 加载，
    // scope 标签（模块内的 Symbol）因此互不相认。这是作用域身份失效的唯一根因，
    // 也是本插件必须能检测并如实报告的那种故障。
    // （在 Node 24 上 loader.internal 为 undefined，所以只能改 loader.import 本身。）
    const loader = ctx.loader
    const originalImport = loader.import.bind(loader)
    loader.import = (name, ...rest) => (name === SCOPE_MODULE
      ? import(scopeModuleUrl)
      : originalImport(name, ...rest))
  }
  // ToolRuntime 声明 static inject = ['systemPrompt']；这里只顶替它，让 fiber 能激活（mode 默认 native）。
  ctx.provide('systemPrompt', { tools: () => {}, section: () => {}, getSectionOrder: () => 0 })
  await ctx.plugin(ToolRuntime)
  const tools = ctx.get('tools')
  if (!tools) throw new Error('ToolRuntime 未激活')

  // 全局条目：挂一份真 mcp-client 到根 ctx（= 全局层），并让它出现在 loader 的条目清单里——
  // 这正是生产里 profile patch 中 mcp 条目的形状。
  if (globalServers.length) {
    const mcpClient = await ctx.loader.import('@deepseek-ai/dsh-mcp-client')
    const fibers = globalServers.map((config) => ctx.plugin(
      { apply: mcpClient.apply, inject: mcpClient.inject, name: mcpClient.name, Config: mcpClient.Config },
      config,
    ))
    const entries = ctx.loader.entries.bind(ctx.loader)
    ctx.loader.entries = () => [
      ...entries(),
      ...globalServers.map((config) => ({ options: { name: '@deepseek-ai/dsh-mcp-client', config } })),
    ]
    await Promise.all(fibers)
  }

  const agentScopes = []
  const agents = {
    async create(options = {}) {
      const cwd = options.cwd ?? wsRoot
      const created = {}
      const ready = new Promise((resolve) => { created.resolve = resolve })
      // 生产形状：agent scope 建在注入了 tools 的 fiber 下（dsh-agent-loop 的 AgentLoop.inject 同样含 tools），
      // agentCtx.tools 因此可解析——插件直接读 agentCtx.tools 就是这个前提。
      ctx.inject(['tools'], (toolCtx) => {
        created.key = { agent: agentScopes.length }
        created.scope = scope.createScope(toolCtx, created.key)
        agentScopes.push(created.scope)
        created.resolve(created.scope)
      })
      await ready
      // 真实宿主的创建事务（dsh-agent-loop 在 publish 之前）：先 await 调用方的 setup，再 await
      // `agent/created` 的**串行**监听器，全部跑完才把 agent 交还调用方。插件现在就挂在那上面，
      // 所以这个替身必须真的派发该事件 —— 否则用例会「绿着但什么都没挂」。
      const agent = { session: { header: { cwd } }, ctx: created.scope.ctx }
      const commit = await options.setup?.(created.scope.ctx, agent)
      commit?.commit?.()
      await ctx.serial(ctx, 'agent/created', { agent, source: 'startup' })
      return { key: created.key, scope: created.scope }
    },
    async resume(options = {}) { return this.create(options) },
  }
  ctx.provide('agents', agents)
  installAgentRuntime(ctx)

  return {
    ctx,
    tools,
    agents,
    async createAgent(cwd = wsRoot) { return ctx.get('agents').create({ cwd }) },
    warnings() { return warnings.slice() },
    async cleanup() {
      for (const agentScope of agentScopes) await agentScope.dispose()
      await ctx.fiber.dispose()
    },
  }
}

test('real host: tools landing in the global layer are reported as a scope failure, not as a connection failure', { timeout: TEST_TIMEOUT_MS }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-mcp-real-host-leak-'))
  const wsRoot = join(root, 'workspace')
  const server = join(root, 'fixture-server.mjs')
  await mkdir(join(wsRoot, '.dsh'), { recursive: true })
  await writeFile(server, FIXTURE_SERVER)
  await writeFile(join(wsRoot, '.dsh', 'mcp.json'), JSON.stringify({
    mcpServers: { fixture: { command: process.execPath, args: [server, join(root, 'unused-sentinel')] } },
  }, null, 2))

  // 第二份 dsh-scope：插件建出的作用域带的是这份实例的 Symbol，真实 dsh-tools / mcp-client
  // 用的仍是第一份，于是 mcp-client 把工具注册进了全局层。
  const scopeEntry = createRequire(import.meta.url).resolve('@deepseek-ai/dsh-scope')
  const host = await createRealHost(wsRoot, { scopeModuleUrl: `${pathToFileURL(scopeEntry).href}?second-instance` })
  const { summarizeWorkspaceRow } = await import('../lib/index.js')
  try {
    await host.createAgent()

    // 故障确实发生了：工具出现在全局视图里（泄漏），共享作用域层里没有。
    const leaked = await waitFor(() => {
      const names = host.tools.schemas().map((schema) => schema.name)
      return names.includes('mcp__fixture__echo') ? names : undefined
    })
    assert.ok(leaked, '两份 dsh-scope 实例必须真的导致工具落到全局层（否则这条用例没测到东西）')

    // 面板必须报「作用域故障」并给出可判定的原因，而不是让用户去查 MCP 配置。
    const row = summarizeWorkspaceRow(host.ctx, wsRoot, { name: 'fixture', transport: 'stdio' }, undefined)
    assert.equal(row.scopeFailed, true)
    assert.equal(row.status, 'failed')
    assert.match(row.lastError, /有多份模块实例/)
    assert.notEqual(row.mountFailed, true)

    const scopeErrors = workspaceScopeErrorsView(wsRoot)
    assert.equal(scopeErrors.length, 1)
    assert.equal(scopeErrors[0].serverName, 'fixture')
    // 同一故障不得在轮询里反复刷日志
    const warnings = host.warnings()
    assert.equal(warnings.filter((line) => line.includes('作用域工具视图不可用')).length, 1, JSON.stringify(warnings))
    summarizeWorkspaceRow(host.ctx, wsRoot, { name: 'fixture', transport: 'stdio' }, undefined)
    assert.equal(host.warnings().filter((line) => line.includes('作用域工具视图不可用')).length, 1)
  } finally {
    await host.cleanup()
    await rm(root, { recursive: true, force: true })
  }
})

test('real host: one shared mcp-client per project, tools projected into each session, nothing leaked globally', { timeout: TEST_TIMEOUT_MS }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-mcp-real-host-'))
  const wsRoot = join(root, 'workspace')
  const sentinel = join(root, 'server-exited')
  const server = join(root, 'fixture-server.mjs')
  await mkdir(join(wsRoot, '.dsh'), { recursive: true })
  await writeFile(server, FIXTURE_SERVER)
  await writeFile(join(wsRoot, '.dsh', 'mcp.json'), JSON.stringify({
    // 空闲回收设得很短，好在用例里等到「会话都结束 → 连接保留 → 空闲超时才拆」这条链。
    // 空闲回收设得比"两次会话销毁 + 断言"长得多（2.5s vs 通常几十毫秒）：3 秒的余地在负载高的
    // CI 上才不会被两次 scope teardown 吃掉而误判。真正的回收边界由下面的 waitFor 断言。
    mcpServers: { fixture: { command: process.execPath, args: [server, sentinel], idleTimeoutMs: 2500 } },
  }, null, 2))

  const host = await createRealHost(wsRoot)
  try {
    // 同一项目开两个会话：这是「共享一份连接、不撞 serverName」的核心主张。
    const first = await host.createAgent()
    const second = await host.createAgent()

    // 首轮之前就绪：从 create() 返回的那一刻起（没有任何 waitFor）工具就必须已经在声明里。
    // 这是宿主自己的契约（mcp-client README: "The server's tools appear before the harness starts
    // its first turn"），也是「用的时候必须已经连上」这条要求的最小可验证形式。
    assert.ok(
      host.tools.schemas(first.key).some((schema) => schema.name === 'mcp__fixture__echo'),
      '共享连接必须在会话创建事务内就绪：工具不得晚于首轮',
    )

    // 第二个会话看到同一份工具集（共享连接的投射是幂等的、按会话各一份）
    assert.ok(host.tools.schemas(second.key).some((schema) => schema.name === 'mcp__fixture__echo'),
      '同一项目的第二个会话也必须拿到工具')

    // 隔离：全局视图看不到项目工具（泄漏到全局层正是作用域身份失效的症状）
    assert.deepEqual(
      host.tools.schemas().filter((schema) => schema.name.startsWith('mcp__fixture__')) .map((schema) => schema.name),
      [],
      '项目工具不得出现在全局视图里',
    )

    // 进程级事实：只应有一条共享连接，两个会话持有它
    const connections = await projectConnectionsView(host.ctx)
    assert.equal(connections.length, 1, '同一项目两个会话只应有一条共享连接')
    assert.equal(connections[0].serverName, 'fixture')
    assert.equal(connections[0].sessions, 2)
    assert.equal(connections[0].refs, 2)
    assert.equal(connections[0].state, 'ready')
    assert.equal(connections[0].fiberState, 2, 'fiber 应为 ACTIVE（连接与首轮 tools/list 已结束）')
    assert.equal(connections[0].toolCount, 1)
    assert.equal(connections[0].scopeError, '', '作用域视图必须可读，且工具必须在共享作用域层里')

    // 面板与挂载诊断：既没有挂载失败，也没有作用域故障
    assert.deepEqual(workspaceMountErrorsView(wsRoot), [])
    assert.deepEqual(workspaceScopeErrorsView(wsRoot), [])
    assert.deepEqual(workspaceToolSchemas(host.ctx, 'fixture', wsRoot).map((schema) => schema.name), ['mcp__fixture__echo'])

    // 两个会话各调一次：共享连接上的调用必须分别成立（多路复用不串线）
    for (const session of [first, second]) {
      const definition = host.tools.get('mcp__fixture__echo', session.key)
      assert.equal(typeof definition?.execute, 'function', '投射出来的定义必须可执行')
      const result = await definition.execute({ text: 'hi' }, { signal: new AbortController().signal })
      assert.deepEqual(result, { content: [{ type: 'text', text: 'echo:hi' }] })
    }

    // 会话全部结束：连接**保留**（空闲），子进程也留着 —— 这正是「下一次要用时已经就绪」。
    await first.scope.dispose()
    await second.scope.dispose()
    const idle = await projectConnectionsView(host.ctx)
    assert.equal(idle.length, 1, '会话结束不等于连接结束：连接留在空闲池里')
    assert.equal(idle[0].refs, 0)
    assert.equal(idle[0].sessions, 0)
    assert.equal(idle[0].idle, true, '空闲等待必须从诊断视图看出来')
    assert.equal(existsSync(sentinel), false, '空闲期间子进程不得退出（复用而不是重建）')

    // 空闲超时到点才真的拆，且不留孤儿子进程。
    const exited = await waitFor(() => existsSync(sentinel))
    assert.ok(exited, '空闲超时后共享连接必须释放，stdio 子进程必须退出')
    // teardown 是异步的：诊断视图在释放完成前会如实显示 disposing 占位，所以这里等到它清空。
    assert.ok(
      await waitFor(async () => (await projectConnectionsView(host.ctx)).length === 0),
      '回收完成后必须从诊断视图消失',
    )
  } finally {
    await host.cleanup()
    await rm(root, { recursive: true, force: true })
  }
})

// 用户现场的形状（issue #4 评论：「同时开两个项目 mcp 会失败」）：两个工作区**同时**开着会话，
// 各自配同一份 MCP 清单（用户正是用面板的「复制到…」把一份清单复制进另一个项目的），而且这些
// serverName 与一条全局条目同名。这一条覆盖夹具层测不到的三件事：真实 mcp-client 的 serverName
// 注册表按 `scopeOf(ctx)` 判重、真实 dsh-tools 的合并视图语义、以及同名时「工具归属」与「前缀」
// 不是一回事。
test('real host: two workspaces mounting the same server names at once stay isolated, each keeping its own tools', { timeout: TEST_TIMEOUT_MS }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-mcp-two-workspaces-'))
  const wsA = join(root, 'ws-a')
  const wsB = join(root, 'ws-b')
  const projectServer = join(root, 'project-server.mjs')
  const globalServer = join(root, 'global-server.mjs')
  await mkdir(join(wsA, '.dsh'), { recursive: true })
  await mkdir(join(wsB, '.dsh'), { recursive: true })
  await writeFile(projectServer, fixtureServerWithTool('echo'))
  await writeFile(globalServer, fixtureServerWithTool('globalOnly'))
  const projectEntry = (sentinel) => ({ command: process.execPath, args: [projectServer, sentinel] })
  // 两个项目配**完全同名**的两条 server：fixture 与 shared。ws-a 另外屏蔽同名的全局条目，
  // 用来分辨「这个工具是我这条连接的」还是「全局那份的」。
  await writeFile(join(wsA, '.dsh', 'mcp.json'), JSON.stringify({
    mcpServers: { fixture: projectEntry(join(root, 'a-fixture')), shared: projectEntry(join(root, 'a-shared')) },
    exclude: ['shared'],
  }, null, 2))
  await writeFile(join(wsB, '.dsh', 'mcp.json'), JSON.stringify({
    mcpServers: { fixture: projectEntry(join(root, 'b-fixture')), shared: projectEntry(join(root, 'b-shared')) },
  }, null, 2))

  const host = await createRealHost(wsA, {
    globalServers: [{ transport: 'stdio', serverName: 'shared', command: process.execPath, args: [globalServer, join(root, 'global-shared')] }],
  })
  try {
    // 同一 app 里两个工作区同时开会话：这正是「同时开两个项目」。
    const agentA = await host.createAgent(wsA)
    const agentB = await host.createAgent(wsB)
    const namesFor = (agent) => host.tools.schemas(agent.key).map((schema) => schema.name)

    // 1. 一条都不许挂载失败 —— 跨项目的同名条目在 0.1.5 起的宿主上互不冲突。
    assert.deepEqual(workspaceMountErrorsView(wsA), [], `ws-a 不应有挂载失败：${JSON.stringify(workspaceMountErrorsView(wsA))}`)
    assert.deepEqual(workspaceMountErrorsView(wsB), [], `ws-b 不应有挂载失败：${JSON.stringify(workspaceMountErrorsView(wsB))}`)
    // 同名条目存在时作用域身份也必须成立（两份 dsh-scope 才会让标签认不出来）。
    assert.deepEqual(workspaceScopeErrorsView(wsA), [])
    assert.deepEqual(workspaceScopeErrorsView(wsB), [])

    // 2. 每个会话拿到**自己项目**那份连接的工具。
    assert.ok(namesFor(agentA).includes('mcp__fixture__echo'), `ws-a 缺少自己项目的工具：${JSON.stringify(namesFor(agentA))}`)
    assert.ok(namesFor(agentA).includes('mcp__shared__echo'), `ws-a 的同名项目条目必须挂上：${JSON.stringify(namesFor(agentA))}`)
    assert.ok(namesFor(agentB).includes('mcp__fixture__echo'), `ws-b 缺少自己项目的工具：${JSON.stringify(namesFor(agentB))}`)
    assert.ok(namesFor(agentB).includes('mcp__shared__echo'), `ws-b 的同名项目条目必须挂上：${JSON.stringify(namesFor(agentB))}`)

    // 3. 全局同名条目的工具按 exclude 规则处理：ws-a 屏蔽了它 → 会话里不得出现；ws-b 没屏蔽 →
    //    照常从全局层可见。若把全局那份的工具投射进会话自己的层（前缀相同就会），屏蔽会被绕过。
    assert.ok(
      await waitFor(() => namesFor(agentB).includes('mcp__shared__globalOnly')),
      `未屏蔽的全局同名工具必须对 ws-b 可见：${JSON.stringify(namesFor(agentB))}`,
    )
    assert.equal(namesFor(agentA).includes('mcp__shared__globalOnly'), false,
      `ws-a 屏蔽了全局 shared，其工具不得经项目条目绕回会话：${JSON.stringify(namesFor(agentA))}`)

    // 4. 连接账目：每 (项目, serverName) 一条，一共四条；同名事实作为诊断带出而不是被当成冲突。
    const connections = await projectConnectionsView(host.ctx)
    assert.deepEqual(
      connections.map((entry) => `${entry.serverName}@${entry.wsPath === wsA ? 'a' : 'b'}`).sort(),
      ['fixture@a', 'fixture@b', 'shared@a', 'shared@b'],
    )
    // **四条都必须真的建成**：只断言"没有失败记录"会漏掉"连接其实没起来、错误又被后续投射清掉"
    // 这种形状（同名条目下确实可能发生），fiber 状态才是用户看到的那两个事实。
    assert.deepEqual(connections.map((entry) => entry.fiberState), [2, 2, 2, 2], '四条连接的 fiber 都必须 ACTIVE（apply 正常结束）')
    assert.deepEqual(connections.map((entry) => entry.state), ['ready', 'ready', 'ready', 'ready'])
    assert.deepEqual(connections.find((entry) => entry.wsPath === wsA && entry.serverName === 'shared').duplicateOwners, [wsB])
  } finally {
    await host.cleanup()
    await rm(root, { recursive: true, force: true })
  }
})

test('real host: project tool ownership does not re-admit an excluded global server with an overlapping namespace', { timeout: TEST_TIMEOUT_MS }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-mcp-project-ownership-'))
  const globalName = 'docs__shared'
  const projectName = 'docs'
  const control = join(root, 'control')
  const project = join(root, 'project')
  let host
  try {
    const globalScript = join(root, 'global.mjs')
    const projectScript = join(root, 'project.mjs')
    await writeFile(globalScript, fixtureServerWithTool('globalOnly'))
    await writeFile(projectScript, fixtureServerWithTool('projectOnly'))
    for (const wsPath of [control, project]) {
      await mkdir(join(wsPath, '.dsh'), { recursive: true })
      const mcpServers = wsPath === project
        ? { [projectName]: { command: process.execPath, args: [projectScript, join(root, 'project-exit')] } }
        : {}
      await writeFile(join(wsPath, '.dsh', 'mcp.json'), JSON.stringify({ mcpServers, exclude: [globalName] }))
    }
    host = await createRealHost(project, {
      globalServers: [{ transport: 'stdio', serverName: globalName, command: process.execPath, args: [globalScript, join(root, 'global-exit')] }],
    })
    const global = host.tools.schemas().find(({ name }) => name === `mcp__${globalName}__globalOnly`)
    assert.ok(global, '前置：真实全局 stdio 工具已挂载')
    const unpaired = await host.createAgent(control)
    const paired = await host.createAgent(project)
    const visible = (agent) => host.tools.schemas(agent.key).map(({ name }) => name)
    const ownName = `mcp__${projectName}__projectOnly`
    assert.ok(await waitFor(() => visible(paired).includes(ownName)), '前置：项目自有工具已实际投射')
    assert.ok(!visible(unpaired).includes(global.name), '对照：没有交叉前缀的项目按 exclude 正常屏蔽')
    assert.ok(!visible(paired).includes(global.name), '有交叉前缀的项目仍须屏蔽同一全局定义')
    assert.deepEqual(workspaceToolSchemas(host.ctx, projectName, project).map(({ name }) => name), [ownName],
      '详情必须只列出这一条连接实际提供的工具')
    assert.deepEqual(workspaceScopeErrorsView(project), [], '全局其他服务器的工具不是这个项目连接的隔离故障')
  } finally {
    await host?.cleanup()
    // root 是上面创建的测试专用叶目录（不是当前工作区或 profile）。
    await rm(root, { recursive: true, force: true })
  }
})

// 依赖树里 @deepseek-ai/dsh-scope 有两份实例时（宿主一份、插件一份 → 作用域标签互不相认），
// 官方的 serverName 判重键会退化成 ctx.root。这一条钉住"那时也必须能用"：两个项目的同名条目
// 照旧各自挂上，而不是第二个项目整批报 already in use（issue #4 评论的形状）。同一根因的另一面
// ——工具确实落到了全局层——仍要如实报出来（那条作用域故障不能被沉默掉）。
test('real host: two projects with the same server names still mount when dsh-scope is duplicated', { timeout: TEST_TIMEOUT_MS }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-mcp-two-workspaces-leak-'))
  const wsA = join(root, 'ws-a')
  const wsB = join(root, 'ws-b')
  const server = join(root, 'fixture-server.mjs')
  await mkdir(join(wsA, '.dsh'), { recursive: true })
  await mkdir(join(wsB, '.dsh'), { recursive: true })
  await writeFile(server, FIXTURE_SERVER)
  const entry = (sentinel) => ({ command: process.execPath, args: [server, sentinel] })
  // 两个项目共用同名条目 fixture；ws-a 另外有一条只有它自己用的 solo（用来钉住泄漏仍被报出）。
  await writeFile(join(wsA, '.dsh', 'mcp.json'), JSON.stringify({
    mcpServers: { fixture: entry(join(root, 'a-fixture')), solo: entry(join(root, 'a-solo')) },
  }, null, 2))
  await writeFile(join(wsB, '.dsh', 'mcp.json'), JSON.stringify({
    mcpServers: { fixture: entry(join(root, 'b-fixture')) },
  }, null, 2))

  const scopeEntry = createRequire(import.meta.url).resolve('@deepseek-ai/dsh-scope')
  const host = await createRealHost(wsA, { scopeModuleUrl: `${pathToFileURL(scopeEntry).href}?two-workspaces-leak` })
  try {
    const agentA = await host.createAgent(wsA)
    const agentB = await host.createAgent(wsB)
    const namesFor = (agent) => host.tools.schemas(agent.key).map((schema) => schema.name)

    // 1. 两边都不许有挂载失败：同名不再是"第二个项目整批起不来"。
    assert.deepEqual(workspaceMountErrorsView(wsA), [], `ws-a 不应有挂载失败：${JSON.stringify(workspaceMountErrorsView(wsA))}`)
    assert.deepEqual(workspaceMountErrorsView(wsB), [], `ws-b 不应有挂载失败：${JSON.stringify(workspaceMountErrorsView(wsB))}`)

    // 2. 连接真的建成了（fiber ACTIVE 是面板"已连接"那半事实的真相源）。
    const connections = await projectConnectionsView(host.ctx)
    assert.deepEqual(connections.map((entry) => `${entry.serverName}@${entry.wsPath === wsA ? 'a' : 'b'}`).sort(),
      ['fixture@a', 'fixture@b', 'solo@a'])
    assert.deepEqual(connections.map((entry) => entry.fiberState), [2, 2, 2], '三条连接都必须 ACTIVE（同名也不许占用）')

    // 3. 工具真的可用：标签认不出来时工具落在全局层，但会话必须看得到它们。
    for (const [label, agent] of [['ws-a', agentA], ['ws-b', agentB]]) {
      assert.ok(
        await waitFor(() => namesFor(agent).includes('mcp__fixture__echo')),
        `${label} 的会话必须能看到 fixture 的工具：${JSON.stringify(namesFor(agent))}`,
      )
    }

    // 4. 泄漏（同一根因的另一面）仍要被报出来：solo 没有同名实例，所以判定可下。
    assert.ok(
      await waitFor(() => workspaceScopeErrorsView(wsA).some((entry) => entry.serverName === 'solo')),
      `工具落到全局层必须如实报出：${JSON.stringify(workspaceScopeErrorsView(wsA))}`,
    )
  } finally {
    await host.cleanup()
    await rm(root, { recursive: true, force: true })
  }
})

// 挂载点换成 agent/created 串行监听器之后的两条契约，都在真实宿主事务里验：
//   1. 监听器在 caller 拿到 agent 之前跑完 → create() 一返回，连接就已经存在（无需轮询）；
//   2. 夹具保真度：宿主把监听器的抛错当作**否决创建** —— 这条成立，下一条断言才不是空过。
test('real host: the mount runs inside the creation transaction, and a throwing listener vetoes creation', { timeout: TEST_TIMEOUT_MS }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-mcp-real-host-created-'))
  const wsRoot = join(root, 'workspace')
  const server = join(root, 'fixture-server.mjs')
  await mkdir(join(wsRoot, '.dsh'), { recursive: true })
  await writeFile(server, FIXTURE_SERVER)
  await writeFile(join(wsRoot, '.dsh', 'mcp.json'), JSON.stringify({
    mcpServers: { fixture: { command: process.execPath, args: [server, join(root, 'unused-sentinel')] } },
  }, null, 2))

  const host = await createRealHost(wsRoot)
  try {
    await host.createAgent()
    // 没有任何 waitFor：创建事务里 await 过监听器，所以此刻连接必然已经建好。
    const connections = await projectConnectionsView(host.ctx)
    assert.equal(connections.length, 1, 'agent/created 监听器必须在 caller 拿到 agent 之前完成挂载')
    assert.equal(connections[0].serverName, 'fixture')

    // 夹具保真度对照：一个抛错的监听器必须让创建失败（否则「失败不否决创建」无从证伪）。
    const offBomb = host.ctx.on('agent/created', () => { throw new Error('listener veto') })
    await assert.rejects(() => host.createAgent(), /listener veto/, '宿主语义：监听器抛错否决创建')
    offBomb()
  } finally {
    await host.cleanup()
    await rm(root, { recursive: true, force: true })
  }
})

// 本次任务的核心场景：**先开会话、后写配置**（用户实际遇到的那个故障），以及随后的移除。
// 面板写盘路径写完就调 reconcileWorkspaceConnections；挂载不再只发生在会话创建那一刻。
test('real host: project config written while a session is live reaches it, and removal retracts it', { timeout: TEST_TIMEOUT_MS }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-mcp-real-host-live-'))
  const wsRoot = join(root, 'workspace')
  const sentinel = join(root, 'server-exited')
  const server = join(root, 'fixture-server.mjs')
  await mkdir(join(wsRoot, '.dsh'), { recursive: true })
  await writeFile(server, FIXTURE_SERVER)
  // 开局连配置文件都没有（首次给一个已经打开的项目添加 MCP）。
  assert.equal(existsSync(join(wsRoot, '.dsh', 'mcp.json')), false)

  const host = await createRealHost(wsRoot)
  try {
    const agent = await host.createAgent()
    assert.deepEqual(
      host.tools.schemas(agent.key).filter((schema) => schema.name.startsWith('mcp__fixture__')),
      [],
      '开局没有任何项目 server',
    )

    // 会话还开着的时候写入配置 + 对齐（= 面板写盘路径做的两件事）。
    await writeFile(join(wsRoot, '.dsh', 'mcp.json'), JSON.stringify({
      mcpServers: { fixture: { command: process.execPath, args: [server, sentinel], idleTimeoutMs: 0 } },
    }, null, 2))
    const reconciled = await reconcileWorkspaceConnections(host.ctx, wsRoot)
    assert.equal(reconciled.remounted, 1, '必须对存活会话重跑一次挂载')

    const names = await waitFor(() => {
      const current = host.tools.schemas(agent.key).map((schema) => schema.name)
      return current.includes('mcp__fixture__echo') ? current : undefined
    })
    assert.ok(names, '写配置后，仍然活着的会话必须拿到工具 —— 不需要重开会话')

    // 再移除：连接立刻销毁，工具从存活会话里撤掉，子进程退出。
    await writeFile(join(wsRoot, '.dsh', 'mcp.json'), JSON.stringify({ mcpServers: {} }, null, 2))
    const removed = await reconcileWorkspaceConnections(host.ctx, wsRoot)
    assert.deepEqual(removed.retired, ['fixture'])
    assert.ok(
      await waitFor(() => host.tools.schemas(agent.key).every((schema) => !schema.name.startsWith('mcp__fixture__'))),
      '移除后工具必须从存活会话里撤掉（不留僵尸工具）',
    )
    assert.ok(await waitFor(() => existsSync(sentinel)), '移除后 stdio 子进程必须退出')
  } finally {
    await host.cleanup()
    await rm(root, { recursive: true, force: true })
  }
})

test('real host: unloading the plugin retires a connection that is idle-retained', { timeout: TEST_TIMEOUT_MS }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-mcp-real-host-idle-unload-'))
  const wsRoot = join(root, 'workspace')
  const sentinel = join(root, 'server-exited')
  const server = join(root, 'fixture-server.mjs')
  await mkdir(join(wsRoot, '.dsh'), { recursive: true })
  await writeFile(server, FIXTURE_SERVER)
  // idleTimeoutMs: 0 = 永不自动回收，于是「卸载」是唯一会销毁它的路径 —— 这条用例才测得到东西。
  await writeFile(join(wsRoot, '.dsh', 'mcp.json'), JSON.stringify({
    mcpServers: { fixture: { command: process.execPath, args: [server, sentinel], idleTimeoutMs: 0 } },
  }, null, 2))

  const host = await createRealHost(wsRoot)
  try {
    const agent = await host.createAgent()
    const names = await waitFor(() => {
      const current = host.tools.schemas(agent.key).map((schema) => schema.name)
      return current.includes('mcp__fixture__echo') ? current : undefined
    })
    assert.ok(names, '前置条件：项目连接必须先连上')

    // 会话结束 → 连接进入空闲保留（refs 归零、连接还在、子进程还活着）。
    await agent.scope.dispose()
    const idleRow = (await projectConnectionsView(host.ctx))[0]
    assert.equal(idleRow.refs, 0)
    assert.equal(idleRow.state, 'ready', '前置条件：连接仍在（空闲保留），不是被拆掉')
    assert.equal(existsSync(sentinel), false, '空闲保留期间子进程必须还活着')

    // 插件卸载（HMR/remove）：真实 cordis 会把作用域 fiber 一起销毁，连接与子进程必须随之收掉。
    await host.ctx.fiber.dispose()
    assert.ok(await waitFor(() => existsSync(sentinel)), '卸载必须销毁空闲保留的连接（否则子进程活过插件）')
    console.log('PROBE after unload rows:', JSON.stringify(await projectConnectionsView(host.ctx))); assert.deepEqual(await projectConnectionsView(host.ctx), [], '卸载后不得再留共享连接')
  } finally {
    await host.cleanup()
    await rm(root, { recursive: true, force: true })
  }
})

test('real host: an exhausted connection can be rebuilt on demand (no host restart)', { timeout: TEST_TIMEOUT_MS }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-mcp-real-host-rebuild-'))
  const wsRoot = join(root, 'workspace')
  const sentinel = join(root, 'server-exited')
  const control = join(root, 'control.txt')
  const server = join(root, 'fixture-server.mjs')
  await mkdir(join(wsRoot, '.dsh'), { recursive: true })
  await writeFile(server, FIXTURE_SERVER_CONTROLLABLE)
  await writeFile(join(wsRoot, '.dsh', 'mcp.json'), JSON.stringify({
    mcpServers: {
      fixture: {
        command: process.execPath,
        args: [server, sentinel, control],
        // 让「重连预算耗尽」在几百毫秒内发生（默认 500ms→30s × 10 在用例里等不起）。
        reconnect: { initialDelayMs: 20, maxDelayMs: 50, maxAttempts: 2 },
        idleTimeoutMs: 0,
      },
    },
  }, null, 2))

  const host = await createRealHost(wsRoot)
  try {
    const agent = await host.createAgent()
    const echoTool = () => host.tools.get('mcp__fixture__echo', agent.key)

    // 正常态：工具可用。
    let definition = await waitFor(() => echoTool())
    assert.ok(definition, '初始连接必须就绪')
    assert.deepEqual(
      await definition.execute({ text: 'hi' }, { signal: new AbortController().signal }),
      { content: [{ type: 'text', text: 'echo:hi' }] },
    )

    // 制造终态：先让"下一次启动必然失败"，再让服务器自己退出 —— 重连会不断重生一个立刻退出的进程，
    // 预算耗尽后 mcp-client 注销工具并停止（README 明写的终态）。
    await writeFile(control, 'fail\n')
    const exitTool = host.tools.get('mcp__fixture__exit', agent.key)
    assert.ok(exitTool, '夹具必须暴露 exit 工具')
    await assert.rejects(() => exitTool.execute({}, { signal: new AbortController().signal }))

    const gone = await waitFor(() =>
      host.tools.schemas(agent.key).every((schema) => !schema.name.startsWith('mcp__fixture__')),
    )
    assert.ok(gone, '预算耗尽后工具必须被注销（这是 mcp-client 的终态，不是我们的判断）')

    // 恢复条件具备后按需重建：这就是面板「重连」走的同一条路径。
    await rm(control, { force: true })
    const rebuilt = await reconnectWorkspaceServer(host.ctx, wsRoot, 'fixture')
    assert.equal(rebuilt.hadLiveConnection, true, '重建必须先拆掉那条已死的连接')

    definition = await waitFor(() => echoTool(), WAIT_MS)
    assert.ok(definition, '重连后工具必须回来 —— 不需要重开会话，也不需要重启宿主')
    assert.deepEqual(
      await definition.execute({ text: 'again' }, { signal: new AbortController().signal }),
      { content: [{ type: 'text', text: 'echo:again' }] },
      '重建后的连接必须真的可用（能调用，不只是出现在列表里）',
    )
  } finally {
    await host.cleanup()
    await rm(root, { recursive: true, force: true })
  }
})

// MCP 出任何问题都不得把用户挡在会话门外：启动命令不存在时，create 仍必须成功。
// 失败以**连接失败**的形式如实呈现（工具数为 0 + fiber ACTIVE 的终态证据），而不是挂载失败 ——
// 两类失败刻意分开，这里把这条区分也钉住。
test('real host: a failing project MCP server is reported as a connection failure, never a veto on session creation', { timeout: TEST_TIMEOUT_MS }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-mcp-real-host-broken-'))
  const wsRoot = join(root, 'workspace')
  await mkdir(join(wsRoot, '.dsh'), { recursive: true })
  await writeFile(join(wsRoot, '.dsh', 'mcp.json'), JSON.stringify({
    mcpServers: { broken: { command: join(root, 'no-such-binary'), args: [] } },
  }, null, 2))

  const { summarizeWorkspaceRow } = await import('../lib/index.js')
  const host = await createRealHost(wsRoot)
  try {
    await host.createAgent()
    const row = await waitFor(() => {
      const current = summarizeWorkspaceRow(host.ctx, wsRoot, { name: 'broken', transport: 'stdio' }, undefined)
      return current.status === 'failed' ? current : undefined
    })
    assert.ok(row, '连不上的 server 必须被如实报成连接失败（0 工具 + fiber ACTIVE 的终态证据）')
    assert.notEqual(row.mountFailed, true, '连接失败不得与挂载阶段失败混为一谈')
  } finally {
    await host.cleanup()
    await rm(root, { recursive: true, force: true })
  }
})
