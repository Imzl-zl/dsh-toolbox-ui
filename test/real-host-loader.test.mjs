import assert from 'node:assert/strict'
import test from 'node:test'
import { existsSync } from 'node:fs'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { Context, Service } from '@deepseek-ai/cordis'
import Loader, { EntryTree } from '@deepseek-ai/cordis-plugin-loader'
import ToolRuntime from '@deepseek-ai/dsh-tools'

// 这一组用例打的是 **O1 的生产形状**：真 cordis Context + 真 Loader（带 include 子树）
// + 真 ToolRuntime + 真 mcp-client 连**真 stdio 子进程**。
//
// 为什么不能用手写夹具：add / removeServer / installBuiltins 的契约全在 loader 内部
// （`loader.create` 的根部 vs 子树、`loader.remove` 的 fiber 销毁、mcp-client 的
// serverName 注册表与子进程生命周期）。桩上给 loader 补一个 create/remove 只能证明
// "插件调用了它"——连没连上、子进程退没退，桩上一律看不见。前两轮用真金白银换来的教训
// 就在 docs/mcp-tool-search-design.md §12.1：夹具全绿、真宿主炸。
const TEST_TIMEOUT_MS = 60_000
const WAIT_MS = 20_000
const MCP_NAME = '@deepseek-ai/dsh-mcp-client'

// 最小 MCP stdio 服务（抄 test/real-host-integration.test.mjs 的 FIXTURE_SERVER）：
// 握手 + tools/list + tools/call，退出时落哨兵文件，用来断言子进程真的退了。
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

// 记录启动时环境变量的夹具：用来断言 `!!js` 表达式被求值成真值，而不是把字面量透给子进程。
const FIXTURE_SERVER_ENV_PROBE = `
import { writeFileSync } from 'node:fs'
const sentinel = process.argv[2]
const dump = process.argv[3]
writeFileSync(dump, 'MARKER=' + String(process.env.MARKER))
process.stdin.setEncoding('utf8')
let buf = ''
const send = (message) => process.stdout.write(JSON.stringify(message) + '\\n')
process.stdin.on('end', () => process.exit(0))
process.stdin.on('data', (chunk) => {
  buf += chunk
  let index
  while ((index = buf.indexOf('\\n')) >= 0) {
    const line = buf.slice(0, index)
    buf = buf.slice(index + 1)
    if (!line.trim()) continue
    const message = JSON.parse(line)
    if (message.method === 'initialize') {
      send({ jsonrpc: '2.0', id: message.id, result: { protocolVersion: message.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: 'fixture', version: '1.0.0' } } })
    } else if (message.method === 'tools/list') {
      send({ jsonrpc: '2.0', id: message.id, result: { tools: [{ name: 'echo', description: 'Echo.', inputSchema: { type: 'object', properties: {} } }] } })
    } else if (message.id !== undefined) {
      send({ jsonrpc: '2.0', id: message.id, result: {} })
    }
  }
})
`

/**
 * 最小 include 子树：`EntryTree` 子类，`[Service.init]` 里把固定条目列表物化进去。
 *
 * 这就是生产形状的那一半——profile patch 里的 mcp 条目不是 loader 根部的直接子项，
 * 而是 include 子树物化出来的（`profileMcpEntries()` 读的正是 `include.subtree.entries()`）。
 * `write()` 是 no-op：我们**不**实现持久化，因为根部创建不该写回任何配置文件（见下）。
 *
 * 零新依赖：`EntryTree` 由已安装的 `@deepseek-ai/cordis-plugin-loader` 导出。
 */
class IncludeTree extends EntryTree {
  constructor(ctx, config) {
    super(ctx)
    this.config = config
  }
  write() {}
  async *[Service.init]() {
    yield () => this.root.stop()
    await this.root.update(this.config.entries ?? [])
  }
}

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
 * 起一个真宿主：真 Loader（`builtins.include` 指向最小 IncludeTree）+ 真 ToolRuntime。
 * @param patchBody - 写进 cordis.patch.yml 的初始内容（插件只认这个文件）。
 * @param subtreeEntries - include 子树要物化的条目（生产里就是 patch 里的 mcp 条目）。
 */
async function createLoaderHost(patchBody, subtreeEntries = []) {
  const root = await mkdtemp(join(tmpdir(), 'dsh-o1-loader-'))
  const patch = join(root, 'cordis.patch.yml')
  const baseConfig = join(root, 'cordis.yml')
  await writeFile(patch, patchBody)
  await writeFile(baseConfig, '[]\n')
  const ctx = new Context()
  await ctx.plugin(Loader)
  ctx.loader.builtins.include = IncludeTree
  ctx.provide('systemPrompt', { tools: () => {}, section: () => {}, getSectionOrder: () => 0 })
  await ctx.plugin(ToolRuntime)
  const tools = ctx.get('tools')
  if (!tools) throw new Error('ToolRuntime 未激活')
  await ctx.loader.create({
    id: 'include',
    name: 'cordis:include',
    config: { path: pathToFileURL(patch).href, entries: subtreeEntries },
  })
  const { McpManagerGateway } = await import('../lib/index.js')
  await ctx.plugin(McpManagerGateway, {})
  return {
    ctx,
    tools,
    manager: ctx.get('mcpManager'),
    patch,
    root,
    entries: () => [...ctx.loader.entries()],
    toolNames: () => tools.schemas().map((schema) => schema.name),
    async cleanup() {
      await ctx.fiber.dispose()
      await rm(root, { recursive: true, force: true })
    },
  }
}

const stdioEntry = (id, serverName, args) => ({
  id,
  name: MCP_NAME,
  config: { transport: 'stdio', serverName, command: process.execPath, args },
})

test('real loader host: add() creates a live root entry, so the new server connects without a host restart', { timeout: TEST_TIMEOUT_MS }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-o1-add-'))
  const server = join(root, 'fixture-server.mjs')
  const sentinel = join(root, 'beta-exited')
  await writeFile(server, FIXTURE_SERVER)
  // 开局：patch 里只有 fixture 一台，include 子树物化它（= 生产形状）。
  const host = await createLoaderHost(
    `- insert:\n    - id: mcp-fixture\n      name: '${MCP_NAME}'\n      config:\n        transport: stdio\n        serverName: fixture\n        command: ${process.execPath}\n        args: [ '${server}', '${join(root, 'fixture-exited')}' ]\n`,
    [stdioEntry('mcp-fixture', 'fixture', [server, join(root, 'fixture-exited')])],
  )
  try {
    const connected = await waitFor(() => host.toolNames().includes('mcp__fixture__echo'))
    assert.ok(connected, '前置条件：include 子树里的条目必须真的连上')

    const result = await host.manager.add({ name: 'beta', transport: 'stdio', command: process.execPath, args: [server, sentinel] })
    assert.match(result.note, /开始连接/)
    assert.doesNotMatch(result.note, /重启后生效/, '连上了就不该再让用户重启')

    // 1. loader 里真有条目，而且是**根部**创建的（不走 include 子树）。
    const created = host.entries().filter((entry) => entry.options.config?.serverName === 'beta')
    assert.equal(created.length, 1, 'add 必须在 loader 里创建条目')
    assert.equal(created[0].options.id, 'mcp-beta', '条目 id 必须与 patch 行一致（resolveManagedEntry 靠它认人）')
    assert.equal(created[0].parent, host.ctx.loader.root, '必须在根部创建：include 子树的 create 会写回 base 配置文件')

    // 2. 工具真的进了活视图（不需要重启进程）。
    assert.ok(
      await waitFor(() => host.toolNames().includes('mcp__beta__echo')),
      'add 之后新服务器的工具必须立刻可见',
    )

    // 3. 面板必须把它认成"自己管的、连上了"——否则用户既不能改也不能卸。
    const row = (await host.manager.list()).servers.find((server) => server.serverName === 'beta')
    assert.equal(row.managed, true, '根部条目不得被划成 external（managedIds 逃生门要兜住）')
    assert.equal(row.phase, 'connected')
    assert.equal(row.toolCount, 1)

    // 4. 配置文件只有一个 beta 行：根部 create 不得把 patch 条目烙进 base 配置再 insert 一遍。
    assert.equal((await readFile(host.patch, 'utf8').then((text) => text.match(/serverName: beta/g) || [])).length, 1)
  } finally {
    await host.cleanup()
    await rm(root, { recursive: true, force: true })
  }
})

test('real loader host: a root create never writes back to the profile patch', { timeout: TEST_TIMEOUT_MS }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-o1-rootwrite-'))
  const server = join(root, 'fixture-server.mjs')
  await writeFile(server, FIXTURE_SERVER)
  const host = await createLoaderHost('[]\n', [])
  try {
    const before = await readFile(host.patch, 'utf8')
    await host.ctx.loader.create(stdioEntry('mcp-extra', 'extra', [server, join(root, 'extra-exited')]))
    await new Promise((resolve) => setTimeout(resolve, 300))
    assert.equal(await readFile(host.patch, 'utf8'), before, '根部 create 必须一个字节都不改 patch（Loader.write() 是 no-op）')
    assert.equal(await readFile(join(host.root, 'cordis.yml'), 'utf8'), '[]\n', '根部 create 也不得碰 base 配置')
  } finally {
    await host.cleanup()
    await rm(root, { recursive: true, force: true })
  }
})

test('real loader host: removeServer() stops the live entry and its stdio subprocess', { timeout: TEST_TIMEOUT_MS }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-o1-remove-'))
  const server = join(root, 'fixture-server.mjs')
  const sentinel = join(root, 'fixture-exited')
  await writeFile(server, FIXTURE_SERVER)
  const host = await createLoaderHost(
    `- insert:\n    - id: mcp-fixture\n      name: '${MCP_NAME}'\n      config:\n        transport: stdio\n        serverName: fixture\n        command: ${process.execPath}\n        args: [ '${server}', '${sentinel}' ]\n`,
    [stdioEntry('mcp-fixture', 'fixture', [server, sentinel])],
  )
  try {
    assert.ok(await waitFor(() => host.toolNames().includes('mcp__fixture__echo')), '前置条件：条目必须真的连上')
    assert.equal(existsSync(sentinel), false, '前置条件：子进程还活着')

    const result = await host.manager.removeServer('fixture')
    assert.match(result.note, /停止运行中的连接/)

    assert.equal(host.entries().some((entry) => entry.options.id === 'mcp-fixture'), false, 'loader 条目必须被移除')
    assert.equal(host.toolNames().includes('mcp__fixture__echo'), false, '工具必须从活视图里消失')
    assert.ok(await waitFor(() => existsSync(sentinel)), 'stdio 子进程必须退出（哨兵文件为证）')
    assert.doesNotMatch(await readFile(host.patch, 'utf8'), /serverName: fixture/, 'patch 行也要删掉')
  } finally {
    await host.cleanup()
    await rm(root, { recursive: true, force: true })
  }
})

test('real loader host: add() rolls the patch back when the loader entry fails to start', { timeout: TEST_TIMEOUT_MS }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-o1-rollback-'))
  // 真实失败：failOnStartupError + 一起来就退出的启动命令 → mcp-client 的 apply 抛出
  // （dsh-mcp-client/lib/index.js：`if (outcome.error !== void 0 && config.failOnStartupError) throw`）。
  // 用一个真存在的二进制（node）而不是不存在的路径：后者在 Windows 上会让 cmd.exe
  // 往测试输出里喷一行 "is not recognized"，而这里要的只是"连接建立不起来"。
  const host = await createLoaderHost('[]\n', [])
  try {
    const before = await readFile(host.patch, 'utf8')
    await assert.rejects(
      () => host.manager.add({
        name: 'broken',
        transport: 'stdio',
        command: process.execPath,
        args: ['--eval', 'process.exit(3)'],
        failOnStartupError: true,
      }),
      /initial connection or tool synchronization failed/,
    )
    assert.equal(await readFile(host.patch, 'utf8'), before, 'create 失败必须把 patch 写回原样（不留半套状态）')
    assert.equal(
      host.entries().some((entry) => entry.options.config?.serverName === 'broken'),
      false,
      '失败的条目不得留在 loader 里',
    )
  } finally {
    await host.cleanup()
    await rm(root, { recursive: true, force: true })
  }
})

test('real loader host: env expressions are evaluated for the live entry, not passed through as literal text', { timeout: TEST_TIMEOUT_MS }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-o1-env-'))
  const server = join(root, 'fixture-server.mjs')
  const dump = join(root, 'env-dump.txt')
  await writeFile(server, FIXTURE_SERVER_ENV_PROBE)
  const host = await createLoaderHost('[]\n', [])
  try {
    // `${HOME}` 经 normalizeMcpImport 变成内部 `!!js (process.env.HOME ?? "")`。
    await host.manager.add({
      name: 'withenv',
      transport: 'stdio',
      command: process.execPath,
      args: [server, join(root, 'unused'), dump],
      env: { MARKER: '${HOME}' },
    })
    assert.ok(await waitFor(() => existsSync(dump)), '新服务器必须真的连上')
    assert.match(await readFile(dump, 'utf8'), new RegExp(`MARKER=${process.env.HOME.replace(/\\/g, '\\\\')}`),
      'env 表达式必须被求值：loader 只对 { __jsExpr } 求值，raw 字符串原样透传给子进程')
  } finally {
    await host.cleanup()
    await rm(root, { recursive: true, force: true })
  }
})

test('real loader host: installBuiltins() appends live loader entries for the selected builtins', { timeout: TEST_TIMEOUT_MS }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-o1-builtins-'))
  const host = await createLoaderHost('[]\n', [])
  try {
    const result = await host.manager.installBuiltins({ ids: ['exa'] })
    assert.deepEqual(result.added, ['exa'])
    assert.match(result.note, /开始连接/)

    // 追加的条目必须真的进 loader（旧行为只写盘，点完"安装"连不上也没工具）。
    const created = host.entries().filter((entry) => entry.options.config?.serverName === 'exa')
    assert.equal(created.length, 1, 'installBuiltins 必须在 loader 里创建条目')
    assert.equal(created[0].options.id, 'mcp-exa', '条目 id 必须与 patch 行一致')
    assert.equal(created[0].parent, host.ctx.loader.root, '同样走根部创建')
    assert.equal(created[0].options.config.url, 'https://mcp.exa.ai/mcp')

    // 连接本身不在这里断言（要打真实网络）：连什么、怎么连由 add 那条用例的真夹具覆盖，
    // 这条只钉"条目进了 loader"这件新发生的事。
    assert.match(await readFile(host.patch, 'utf8'), /serverName: exa/)
  } finally {
    await host.cleanup()
    await rm(root, { recursive: true, force: true })
  }
})
