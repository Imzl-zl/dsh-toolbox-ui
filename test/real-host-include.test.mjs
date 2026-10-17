import assert from 'node:assert/strict'
import test from 'node:test'
import { existsSync } from 'node:fs'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import Loader, { Group } from '@deepseek-ai/cordis-plugin-loader'
import { Include } from '@deepseek-ai/cordis-plugin-include'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import { readManagedMcpServers } from '../lib/mcp-config.js'
import { McpManagerGateway } from '../lib/index.js'

// O1 的**终验**：真 `@deepseek-ai/cordis-plugin-include` 夹具 + 真 Loader + 真 ToolRuntime
// + 真 mcp-client + 真 stdio 子进程，并且真的"重启"（dispose 整个 ctx、用同一对配置文件
// 重新起一个宿主）。
//
// 为什么必须真 Include 才能验：O1 剩下那个未决问题全在 `Include.write()` 上——
//   `EntryTree.create/remove` 结尾都会调 `group.tree.write()`，对 include 子树里的条目
//   那就是 `Include.write()`，它把 **`this.root.data`（base 条目 + patch 插入条目的并集）**
//   写回 `config.path` 指向的文件。于是"创建/移除一个 patch 条目"会把 patch 条目烙进
//   base 配置，下次启动 base 一份 + patch insert 一份 → 重复条目。
//   手写夹具的 `write()` 是 no-op，那条路永远看不见。
//
// 生产形状（与 DSH CLI 一致）：include 条目的 config 是
//   `{ path: <cordis.yml>, patches: [ { insert: [...] } ] }`
// 即 base 配置文件 + 宿主读盘后交过来的 patch 列表。本插件自己只写 cordis.patch.yml
// （`patchPath()` 从 include 条目的 config.path 推导），不经过 loader。
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
  const ctx = new Context()
  await ctx.plugin(Loader)
  ctx.loader.builtins.include = Include
  ctx.loader.builtins.group = Group
  ctx.provide('systemPrompt', { tools: () => {}, section: () => {}, getSectionOrder: () => 0 })
  await ctx.plugin(ToolRuntime)
  // 宿主那一半：读 patch 文件，把条目列表交给 include（生产里由 DSH CLI 做）。
  const parsed = readManagedMcpServers(await readFile(patch, 'utf8'))
  await ctx.loader.create({
    id: 'include',
    name: 'cordis:include',
    config: {
      path: pathToFileURL(base).href,
      patches: [{
        insert: Object.entries(parsed.entryIds).map(([name, id]) => ({
          id,
          name: MCP_NAME,
          config: { transport: 'stdio', serverName: name, command: process.execPath, args: [server, join(base, '..', `${name}-exited`)] },
        })),
      }],
    },
  })
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
  await writeFile(server, FIXTURE_SERVER)
  await writeFile(base, BASE_CONFIG)
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
    // 生产形状：patch 里的条目由 include 子树物化，真 mcp-client 连真子进程。
    await new Promise((r) => setTimeout(r, 800))
    assert.deepEqual([...ctx.loader.entries()].map((e) => e.options.id).sort(), ['base-group', 'include', 'mcp-a'])
    assert.ok(ctx.get('tools').schemas().some((s) => s.name === 'mcp__a__echo'), 'include 子树里的条目必须真的连上')

    // add(b)：根部创建，工具立刻活。
    const added = await ctx.get('mcpManager').add({ name: 'b', transport: 'stdio', command: process.execPath, args: [server, sentinelB] })
    assert.match(added.note, /开始连接/)
    await new Promise((r) => setTimeout(r, 800))
    const beta = [...ctx.loader.entries()].filter((e) => e.options.config?.serverName === 'b')
    assert.equal(beta.length, 1, 'add 必须创建条目')
    assert.equal(beta[0].parent, ctx.loader.root, '必须在根部创建（不走 include 子树）')
    assert.ok(ctx.get('tools').schemas().some((s) => s.name === 'mcp__b__echo'), '新服务器的工具必须立刻可见')

    // 根部创建不得碰 base 配置：patch 条目还在 patch 里，base 一个字节没动。
    assert.equal(await readFile(base, 'utf8'), BASE_CONFIG, 'add 之后 base 配置必须原样（否则 Include.write() 把 patch 条目烙了进去）')
    assert.match(await readFile(patch, 'utf8'), /serverName: b/, 'patch 里必须有新行')
  } finally {
    await ctx.fiber.dispose()
  }

  // ── 重启：patch 里的两条都必须各出现一次，且 base 仍然干净 ──
  ctx = await boot({ base, patch, server })
  try {
    await new Promise((r) => setTimeout(r, 1200))
    assert.deepEqual([...ctx.loader.entries()].map((e) => e.options.id).sort(), ['base-group', 'include', 'mcp-a', 'mcp-b'],
      '重启后每个条目必须恰好一条：base 一份 + patch insert 一份就是重复条目（O1 的核心风险）')
    const names = ctx.get('tools').schemas().map((s) => s.name)
    assert.ok(names.includes('mcp__a__echo') && names.includes('mcp__b__echo'), '重启后两条连接都必须在')
    assert.equal(await readFile(base, 'utf8'), BASE_CONFIG, '重启后 base 配置仍然原样')

    // removeServer(a)：条目停掉、子进程退出、patch 行删掉，base 不动。
    const removed = await ctx.get('mcpManager').removeServer('a')
    assert.match(removed.note, /停止运行中的连接/)
    await new Promise((r) => setTimeout(r, 800))
    assert.equal([...ctx.loader.entries()].some((e) => e.options.id === 'mcp-a'), false, '条目必须被移除')
    assert.equal(ctx.get('tools').schemas().some((s) => s.name === 'mcp__a__echo'), false, '工具必须消失')
    assert.ok(await waitFor(() => existsSync(sentinelA)), 'stdio 子进程必须退出')
    assert.doesNotMatch(await readFile(patch, 'utf8'), /serverName: a/, 'patch 行也要删掉')
    assert.equal(await readFile(base, 'utf8'), BASE_CONFIG, 'removeServer 之后 base 配置必须原样')
  } finally {
    await ctx.fiber.dispose()
  }

  // ── 再重启：只剩 b，且没有残留 ──
  ctx = await boot({ base, patch, server })
  try {
    await new Promise((r) => setTimeout(r, 1200))
    assert.deepEqual([...ctx.loader.entries()].map((e) => e.options.id).sort(), ['base-group', 'include', 'mcp-b'],
      '二次重启后不得有被移除条目的残留')
    assert.ok(ctx.get('tools').schemas().some((s) => s.name === 'mcp__b__echo'))
    assert.equal(ctx.get('tools').schemas().some((s) => s.name === 'mcp__a__echo'), false)
    assert.equal(await readFile(base, 'utf8'), BASE_CONFIG, '二次重启后 base 配置仍然原样')
  } finally {
    await ctx.fiber.dispose()
    await rm(root, { recursive: true, force: true })
  }
})

test('real include host: ctx.loader.remove on a subtree entry neither removes it nor leaves the config clean', { timeout: TEST_TIMEOUT_MS }, async () => {
  // 这条是**反向对照**，守的是"removeServer 为什么必须走 entry.parent.remove()"。
  // 真 Include 实测（两个后果同时发生）：
  //   ① `EntryTree.remove()` 先用完整 id `include:<id>` resolve 出条目，再把同一个完整 id
  //      传给 `EntryGroup.remove()`，而后者按 `this.tree.store[id]` 查的是**局部 id**
  //      → 查不到 → `if (!entry) return`，**静悄悄地什么都没删**；
  //   ② 它结尾照样调 `entry.parent.tree.write()` = `Include.write()`，把整个 root.data
  //      （含 patch 插入的 mcp 条目）写回 base 配置 → patch 条目被烙进 cordis.yml。
  // 也就是说：走那条路会"既没删掉、又把配置写脏"。谁把它改回去，这条立刻红。
  const root = await mkdtemp(join(tmpdir(), 'dsh-include-ctl-'))
  const base = join(root, 'cordis.yml')
  const patch = join(root, 'cordis.patch.yml')
  const server = join(root, 'fixture-server.mjs')
  await writeFile(server, FIXTURE_SERVER)
  await writeFile(base, BASE_CONFIG)
  await writeFile(patch, `- insert:
    - id: mcp-a
      name: '${MCP_NAME}'
      config:
        transport: stdio
        serverName: a
        command: ${process.execPath}
        args: [ '${server}', '${join(root, 'a-exited')}' ]
    - id: mcp-b
      name: '${MCP_NAME}'
      config:
        transport: stdio
        serverName: b
        command: ${process.execPath}
        args: [ '${server}', '${join(root, 'b-exited')}' ]
`)
  const ctx = await boot({ base, patch, server })
  try {
    await new Promise((r) => setTimeout(r, 800))
    const before = await readFile(base, 'utf8')
    const target = [...ctx.loader.entries()].find((e) => e.options.id === 'mcp-a')
    assert.ok(target, '前置条件：mcp-a 必须由 include 子树物化')

    await ctx.loader.remove(target.id)
    await new Promise((r) => setTimeout(r, 300))

    const after = await readFile(base, 'utf8')
    assert.equal(
      [...ctx.loader.entries()].some((e) => e.options.id === 'mcp-a'),
      true,
      'ctx.loader.remove() 对 include 子树条目是静默 no-op——这正是不能走它的理由',
    )
    assert.notEqual(after, before, 'ctx.loader.remove() 顺带触发了 Include.write()')
    assert.match(after, /serverName: a/, 'patch 插入的条目被烙进了 base 配置')
    assert.match(after, /serverName: b/, '另一条 patch 条目也跟着被烙进去（写的是整个 root.data）')
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
