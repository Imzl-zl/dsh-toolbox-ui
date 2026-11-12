import assert from 'node:assert/strict'
import test from 'node:test'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import { mountRootInclude, readProfilePatches } from '@deepseek-ai/dsh-app-boot'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import { McpManagerGateway } from '../lib/index.js'

// O1 的**重启终验**：真 Include + 真 Loader + 真 ToolRuntime + 真 mcp-client + 真 stdio 子进程，
// 并且真的"重启"（dispose 整个 ctx、用同一对配置文件重新起一个宿主）。
//
// 为什么要真 Include 才能验：patch 行与 base 配置之间的边界全在 `Include` 里
// （`applyEntryPatches` 把 insert 叠到 base 上；`Include.write()` 写的是**已应用树**）。
// 手写夹具的 `write()` 是 no-op，那条路永远看不见——"base 被写脏/重启后重复条目"这类
// 只在真机上出现的后果，只能这么验。
//
// 生产形状（与 DSH CLI 一致）：根 Include 由官方 `mountRootInclude` 挂载，patch 列表来自
// `readProfilePatches`；本插件只写 `cordis.patch.yml`，条目由组合挂起来。
const TEST_TIMEOUT_MS = 60_000
const MCP_NAME = '@deepseek-ai/dsh-mcp-client'
// base 配置里放一条 group 条目：它不 import 任何包，用来证明 base 的**原有内容**
// 在任何创建/移除之后都原样留在文件里。
const BASE_CONFIG = '- id: base-group\n  name: cordis:group\n  config: []\n'

const FIXTURE_SERVER = `
import { writeFileSync } from 'node:fs'
const sentinel = process.argv[2]
process.stdin.setEncoding('utf8')
let buf = ''
const send = (m) => process.stdout.write(JSON.stringify(m) + '\\n')
process.stdin.on('end', () => process.exit(0))
process.on('exit', () => { try { writeFileSync(sentinel, 'bye') } catch {} })
process.stdin.on('data', (chunk) => {
  buf += chunk
  let i
  while ((i = buf.indexOf('\\n')) >= 0) {
    const line = buf.slice(0, i); buf = buf.slice(i + 1)
    if (!line.trim()) continue
    const m = JSON.parse(line)
    if (m.method === 'initialize') send({ jsonrpc: '2.0', id: m.id, result: { protocolVersion: m.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: 'fixture', version: '1.0.0' } } })
    else if (m.method === 'tools/list') send({ jsonrpc: '2.0', id: m.id, result: { tools: [{ name: 'echo', description: 'Echo.', inputSchema: { type: 'object', properties: {} } }] } })
    else if (m.method === 'tools/call') send({ jsonrpc: '2.0', id: m.id, result: { content: [{ type: 'text', text: 'echo:' + String(m.params.arguments?.text ?? '') }] } })
    else if (m.id !== undefined) send({ jsonrpc: '2.0', id: m.id, result: {} })
  }
})
`

/** 起一个宿主。每次调用都是一次独立的"进程重启"：重新读盘、重新物化整棵树。 */
async function boot({ base, patch, server }) {
  const root = join(base, '..')
  await symlink(join(import.meta.dirname, '..', 'node_modules'), join(root, 'node_modules'), 'junction').catch(() => {})
  const profileContext = {
    name: 'test',
    dir: root,
    patchPath: patch,
    installAnchor: root,
    cwd: root,
    home: join(root, 'home'),
    startedBundles: [],
    overlays: [],
    telemetryDisabledEnv: undefined,
  }
  const ctx = new Context()
  await ctx.plugin(Loader)
  ctx.provide('systemPrompt', { tools: () => {}, section: () => {}, getSectionOrder: () => 0 })
  await ctx.plugin(ToolRuntime)
  ctx.provide('profileContext', profileContext)
  // 生产那一半：宿主读盘得到完整 patch 列表，交给官方挂载函数。
  await mountRootInclude(ctx, base, readProfilePatches('dsh', profileContext))
  await ctx.plugin(McpManagerGateway, {})
  return ctx
}

test('real include host: add and removeServer survive a restart without duplicating or losing entries', { timeout: TEST_TIMEOUT_MS }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-include-e2e-'))
  const base = join(root, 'cordis.yml')
  const patch = join(root, 'cordis.patch.yml')
  const server = join(root, 'fixture-server.mjs')
  const sentinelA = join(root, 'a-exited')
  const sentinelB = join(root, 'b-exited')
  const home = join(root, 'home')
  await mkdir(home)
  await writeFile(server, FIXTURE_SERVER)
  await writeFile(base, BASE_CONFIG)
  await writeFile(join(root, 'package.json'), JSON.stringify({ name: 'dsh-profile-test', version: '0.0.0' }, null, 2))
  await writeFile(patch, `- insert:
    - id: mcp-a
      name: '${MCP_NAME}'
      config:
        transport: stdio
        serverName: a
        command: ${process.execPath}
        args: [ '${server}', '${sentinelA}' ]
`)

  // ── 第一次运行 ──
  let ctx = await boot({ base, patch, server })
  try {
    // 生产形状：patch 里的条目由组合挂起来，真 mcp-client 连真子进程。
    assert.ok(await waitFor(() => ctx.get('tools').schemas().some((s) => s.name === 'mcp__a__echo')), 'patch 行里的条目必须真的连上')
    assert.deepEqual([...ctx.loader.entries()].map((e) => e.options.id).sort(), ['base-group', 'include', 'mcp-a'])
    // 行的归属由官方组合决定（include 子树），插件不再自己在 loader 根部造条目。
    const includeTree = ctx.loader.resolve('include').subtree
    assert.ok([...includeTree.entries()].some((entry) => entry.options.id === 'mcp-a'), 'patch 行必须由 include 组合持有')

    // add(b)：组合应用之后工具立刻活。
    const added = await ctx.get('toolboxMcp').add({ name: 'b', transport: 'stdio', command: process.execPath, args: [server, sentinelB] })
    assert.equal(added.live, 'applied')
    assert.match(added.note, /开始连接/)
    assert.ok(await waitFor(() => ctx.get('tools').schemas().some((s) => s.name === 'mcp__b__echo')), '新服务器的工具必须立刻可见')
    assert.equal([...ctx.loader.entries()].filter((e) => e.options.config?.serverName === 'b').length, 1, 'add 必须让条目真的进 loader')

    // 应用 patch 不得碰 base 配置：patch 条目还在 patch 里，base 一个字节没动。
    assert.equal(await readFile(base, 'utf8'), BASE_CONFIG, 'add 之后 base 配置必须原样（否则 Include.write() 把 patch 条目烙了进去）')
    assert.match(await readFile(patch, 'utf8'), /serverName: b/, 'patch 里必须有新行')
  } finally {
    await ctx.fiber.dispose()
  }

  // ── 重启：patch 里的两条都必须各出现一次，且 base 仍然干净 ──
  ctx = await boot({ base, patch, server })
  try {
    assert.ok(await waitFor(() => {
      const names = ctx.get('tools').schemas().map((s) => s.name)
      return names.includes('mcp__a__echo') && names.includes('mcp__b__echo')
    }), '重启后两条连接都必须在')
    assert.deepEqual([...ctx.loader.entries()].map((e) => e.options.id).sort(), ['base-group', 'include', 'mcp-a', 'mcp-b'],
      '重启后每个条目必须恰好一条：base 一份 + patch insert 一份就是重复条目（O1 的核心风险）')
    assert.equal(await readFile(base, 'utf8'), BASE_CONFIG, '重启后 base 配置仍然原样')

    // removeServer(a)：条目停掉、子进程退出、patch 行删掉，base 不动。
    const removed = await ctx.get('toolboxMcp').removeServer('a')
    assert.equal(removed.live, 'applied')
    assert.match(removed.note, /停止运行中的连接/)
    assert.ok(await waitFor(() => !ctx.get('tools').schemas().some((s) => s.name === 'mcp__a__echo')), '工具必须消失')
    assert.equal([...ctx.loader.entries()].some((e) => e.options.id === 'mcp-a'), false, '条目必须被移除')
    assert.ok(await waitFor(() => existsSync(sentinelA)), 'stdio 子进程必须退出')
    assert.doesNotMatch(await readFile(patch, 'utf8'), /serverName: a\n/, 'patch 行也要删掉')
    assert.equal(await readFile(base, 'utf8'), BASE_CONFIG, 'removeServer 之后 base 配置必须原样')
  } finally {
    await ctx.fiber.dispose()
  }

  // ── 再重启：只剩 b，且没有残留 ──
  ctx = await boot({ base, patch, server })
  try {
    assert.ok(await waitFor(() => ctx.get('tools').schemas().some((s) => s.name === 'mcp__b__echo')))
    assert.deepEqual([...ctx.loader.entries()].map((e) => e.options.id).sort(), ['base-group', 'include', 'mcp-b'],
      '二次重启后不得有被移除条目的残留')
    assert.equal(ctx.get('tools').schemas().some((s) => s.name === 'mcp__a__echo'), false)
    assert.equal(await readFile(base, 'utf8'), BASE_CONFIG, '二次重启后 base 配置仍然原样')
  } finally {
    await ctx.fiber.dispose()
    await rm(root, { recursive: true, force: true })
  }
})

async function waitFor(predicate, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const value = await predicate()
    if (value) return value
    if (Date.now() > deadline) return undefined
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
}
