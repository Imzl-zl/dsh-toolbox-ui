// 真宿主夹具：真 Loader + 官方 `mountRootInclude` 挂的根 Include + 真 ToolRuntime + 真 mcp-client。
//
// 为什么不能手搭 include 子树：本插件的 live 变更入口是官方 `reconcileProfilePatches`，它靠
// app-boot 内部的 `bootstrapIncludes` 找到根 Include（WeakMap 以**根 ctx** 为键）。手搭一套
// 等于换掉被测语义——上一版夹具正是这么做的，于是"插件的写路径"和"产品的写路径"不是同一条。
//
// profile 目录就是 tmp 里的那一份（`cordis.yml` + `cordis.patch.yml` + `package.json`），
// `profileContext` 由夹具 provide——这正是生产启动器给插件的东西。
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import { mountRootInclude, readProfilePatches } from '@deepseek-ai/dsh-app-boot'
import ToolRuntime from '@deepseek-ai/dsh-tools'

export const TEST_TIMEOUT_MS = 60_000
export const WAIT_MS = 20_000
export const MCP_NAME = '@deepseek-ai/dsh-mcp-client'

/** 最小 MCP stdio 服务：握手 + tools/list + tools/call，退出时落哨兵文件。 */
export const FIXTURE_SERVER = `
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

/** 记录启动时环境变量的夹具：断言 `!!js` 表达式被求值成真值，而不是把字面量透给子进程。 */
export const FIXTURE_SERVER_ENV_PROBE = `
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

export async function waitFor(predicate, timeoutMs = WAIT_MS) {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const value = await predicate()
    if (value) return value
    if (Date.now() > deadline) return undefined
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
}

/**
 * @param {string} patchBody - 写进 cordis.patch.yml 的初始内容（插件只认这个文件）。
 */
export async function createLoaderHost(patchBody) {
  const root = await mkdtemp(join(tmpdir(), 'dsh-o1-loader-'))
  const patch = join(root, 'cordis.patch.yml')
  const baseConfig = join(root, 'cordis.yml')
  const home = join(root, 'home')
  await mkdir(home)
  await writeFile(patch, patchBody)
  await writeFile(baseConfig, '[]\n')
  await writeFile(join(root, 'package.json'), JSON.stringify({ name: 'dsh-profile-test', version: '0.0.0' }, null, 2))
  // profile 目录里的宿主包解析路径：真实 profile 的 node_modules 就是启动器装出来的那一份。
  // 没有它，include 子树按自己的 baseUrl（= profile 目录）解析 `@deepseek-ai/dsh-mcp-client`
  // 会失败——那是夹具缺东西，不是被测代码的问题。
  await symlink(join(import.meta.dirname, '..', '..', 'node_modules'), join(root, 'node_modules'), 'junction')
  const profileContext = {
    name: 'test',
    dir: root,
    patchPath: patch,
    installAnchor: root,
    cwd: root,
    home,
    startedBundles: [],
    overlays: [],
    telemetryDisabledEnv: undefined,
  }
  const ctx = new Context()
  await ctx.plugin(Loader)
  ctx.provide('systemPrompt', { tools: () => {}, section: () => {}, getSectionOrder: () => 0 })
  await ctx.plugin(ToolRuntime)
  const tools = ctx.get('tools')
  if (!tools) throw new Error('ToolRuntime 未激活')
  ctx.provide('profileContext', profileContext)
  await mountRootInclude(ctx, baseConfig, readProfilePatches('dsh', profileContext))
  const { McpManagerGateway } = await import('../../lib/index.js')
  await ctx.plugin(McpManagerGateway, {})
  return {
    ctx,
    tools,
    manager: ctx.get('mcpManager'),
    patch,
    baseConfig,
    root,
    profileContext,
    entries: () => [...ctx.loader.entries()],
    toolNames: () => tools.schemas().map((schema) => schema.name),
    readPatch: () => readFile(patch, 'utf8'),
    async cleanup() {
      await ctx.fiber.dispose()
      await rm(root, { recursive: true, force: true })
    },
  }
}
