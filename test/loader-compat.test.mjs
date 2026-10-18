import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

// 宿主 loader 的两处行为在 0.2 内部变过：0.2.0 装的是 `cordis-plugin-loader@1.0.3`，
// 0.2.1 装的是 `1.0.6`（`@deepseek-ai/dsh@0.2.1-rc.2` 自己声明 `~1.0.6`）。真宿主用例只有
// 在装着对应版本时才跑得到，所以这里把 **1.0.6 的两条语义**固化成常驻守卫——任何一条矩阵
// （含默认的 0.2.0 开发基线）都能发现回退：
//
//   ① 创建条目时启动失败：1.0.3 在 `Entry.update()` 里 `throw updateError("apply", …)`，
//      所以 create 自己就 reject；1.0.6 把那套 throw 换成 `logger.error/warn`，
//      `Loader.create()` **总是 resolve**，启动错误只挂在 fiber 上（`fiber.await()` 才重抛）。
//
//   ② 条目 dispose 时的 unload 处理器：1.0.3 有一道 `if (fiber.entry._disposing) return;`
//      早退守卫，1.0.6 把它删了，于是 `fiber.entry.parent.tree.write()` 会真的执行——对
//      include 子树条目就是 `Include.write()`，写回去的是 `root.data`（base 条目 + **其余
//      patch 行**）→ 删一台服务器会把兄弟服务器的 patch 行烙进 base 配置，下次启动
//      base 一份 + patch insert 一份 = 重复条目。该处理器里唯一还能早退的判据是
//      `fiber.entry.disabled`。
//
// 这两条都不该靠"跑另一套宿主矩阵"才发现：CI 的漂移任务是周跑的，本地默认基线永远装 0.2.0。

const MCP_NAME = '@deepseek-ai/dsh-mcp-client'
const BASE_CONFIG = "- id: base-group\n  name: cordis:group\n  config: []\n"

/**
 * 最小夹具：真文件（base + patch）、假 loader（可指定 create 出来的 fiber 行为）。
 *
 * `group.remove` 复刻 1.0.6 的 unload 处理器：条目没被标记 `disabled` 就把
 * 「base 条目 + 其余 patch 行」写回 base 配置文件；标记了就什么都不写。
 */
async function createFixture({ patchContent = '[]\n', liveEntries = [], fiberFor } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'dsh-loader-compat-'))
  const rootConfig = join(root, 'cordis.yml')
  const patchPath = join(root, 'cordis.patch.yml')
  await writeFile(rootConfig, BASE_CONFIG)
  await writeFile(patchPath, patchContent)
  const include = { options: { id: 'include', name: 'cordis:include', config: { path: pathToFileURL(rootConfig).href } } }
  include.parent = { remove: async () => {} }
  const entries = [include, ...liveEntries]
  const removed = []
  const group = {
    async remove(id) {
      const index = entries.findIndex((entry) => entry.options.id === id)
      if (index < 0) return
      const [entry] = entries.splice(index, 1)
      // 1.0.6 的 unload 处理器等价物：没被标记 disabled 就会把 root.data 写回 base。
      if (entry.options.disabled !== true) await writeFile(rootConfig, BASE_CONFIG + "- id: mcp-sibling\n  name: '" + MCP_NAME + "'\n")
      removed.push(entry)
    },
  }
  for (const entry of liveEntries) entry.parent = group
  const loader = {
    entries: () => entries,
    async create(options) {
      const entry = {
        options: { ...options },
        parent: group,
        fiber: fiberFor ? fiberFor(options) : { await: async () => {} },
        async update(next) { Object.assign(entry.options, next ?? {}) },
      }
      entries.push(entry)
      return options.id
    },
    async remove(id) { await group.remove(id) },
  }
  const ctx = {
    loader,
    tools: { schemas: () => [] },
    logger: { warn: () => {}, error: () => {}, info: () => {} },
    get: () => undefined,
  }
  return {
    root,
    rootConfig,
    patchPath,
    entries,
    removed,
    ctx,
    cleanup: () => rm(root, { recursive: true, force: true }),
  }
}

const PATCH_ONE_ROW = "- insert:\n    - id: mcp-a\n      name: '" + MCP_NAME + "'\n      config:\n        transport: stdio\n        serverName: a\n        command: node\n"

test('add() rolls back when the host swallows the startup error and only fiber.await() rethrows it', async () => {
  const { McpManagerGateway } = await import('../lib/index.js')
  // 1.0.6 的 create 已经 resolve，失败只挂在 fiber 上——正是 0.2.1 上的形状。
  const fixture = await createFixture({
    fiberFor: () => ({ await: async () => { throw new Error(`mcp-client(broken): initial connection or tool synchronization failed`) } }),
  })
  try {
    await assert.rejects(
      () => McpManagerGateway.prototype.add.call({ ctx: fixture.ctx }, { name: 'broken', transport: 'stdio', command: process.execPath }),
      /initial connection or tool synchronization failed/,
      '启动错误必须冒到调用方（否则 add 的半套状态不会被回滚）',
    )
    assert.equal(await readFile(fixture.patchPath, 'utf8'), '[]\n', '失败的 add 必须把 patch 写回原样')
    assert.deepEqual(
      fixture.entries.filter((entry) => entry.options.config?.serverName === 'broken'),
      [],
      '失败的条目不得留在 loader 里',
    )
  } finally {
    await fixture.cleanup()
  }
})

test('removeServer() keeps the base config out of the host unload write', async () => {
  const { McpManagerGateway } = await import('../lib/index.js')
  const live = { options: { id: 'mcp-a', name: MCP_NAME, config: { transport: 'stdio', serverName: 'a', command: 'node' } } }
  const fixture = await createFixture({ patchContent: PATCH_ONE_ROW, liveEntries: [live] })
  try {
    const result = await McpManagerGateway.prototype.removeServer.call({ ctx: fixture.ctx }, 'a')
    assert.match(result.note, /停止运行中的连接/)
    assert.equal(fixture.removed.length, 1, '条目必须真的从 loader 里移除')
    assert.equal(
      await readFile(fixture.rootConfig, 'utf8'),
      BASE_CONFIG,
      'base 配置必须原样：1.0.6 的 unload 处理器会把 root.data（base + 其余 patch 行）写回 base，先置 disabled 才能让它早退',
    )
    assert.doesNotMatch(await readFile(fixture.patchPath, 'utf8'), /serverName: a/, 'patch 行也要删掉')
  } finally {
    await fixture.cleanup()
  }
})

/** 1.0.6 的重启形状：`entry.update()` 自己 resolve，重连/启用的结果只落在新 fiber 上。 */
function restartedEntryFiber(failure) {
  const entry = {
    options: { id: 'mcp-a', name: MCP_NAME, config: { transport: 'stdio', serverName: 'a', command: 'node', args: ['--old'] }, disabled: false },
    fiber: { await: async () => {} },
    // 真 Entry 上 `disabled` 是读 options 的 getter；setDisabled 的判定依赖它。
    get disabled() { return this.options.disabled === true },
  }
  entry.update = async function update(next) {
    Object.assign(this.options, next ?? {})
    // 改连接字段会重启、启用会启动：两种都发生在新 fiber 上，失败只落在那里。
    if (next?.config !== undefined || next?.disabled === false) this.fiber = failure
    return undefined
  }
  return entry
}

test('update() rolls back when the restarted fiber fails and only fiber.await() rethrows it', async () => {
  const { McpManagerGateway } = await import('../lib/index.js')
  const live = restartedEntryFiber({ await: async () => { throw new Error(`mcp-client(a): initial connection or tool synchronization failed`) } })
  const fixture = await createFixture({ patchContent: PATCH_ONE_ROW, liveEntries: [live] })
  try {
    await assert.rejects(
      () => McpManagerGateway.prototype.update.call({ ctx: fixture.ctx }, {
        name: 'a', transport: 'stdio', command: 'node', args: ['--new'],
      }),
      /initial connection or tool synchronization failed/,
      '重连失败必须冒到调用方，否则 patch 已改成新配置而连接没起来',
    )
    assert.equal(await readFile(fixture.patchPath, 'utf8'), PATCH_ONE_ROW, '失败的 update 必须把 patch 写回原样')
  } finally {
    await fixture.cleanup()
  }
})

test('enabling rolls back when the activation after re-enabling fails', async () => {
  const { McpManagerGateway } = await import('../lib/index.js')
  const live = restartedEntryFiber({ await: async () => { throw new Error(`mcp-client(a): initial connection or tool synchronization failed`) } })
  live.options.disabled = true
  const disabledRow = PATCH_ONE_ROW.replace('        command: node\n', '        command: node\n        disabled: true\n')
  const fixture = await createFixture({ patchContent: disabledRow, liveEntries: [live] })
  // enable() 只是 setDisabled(false) 的别名，且它内部走 this.setDisabled——所以这里给一个
  // 与真网关同形状的 receiver，而不是裸 { ctx }。
  const gateway = { ctx: fixture.ctx, setDisabled: McpManagerGateway.prototype.setDisabled }
  try {
    await assert.rejects(
      () => McpManagerGateway.prototype.enable.call(gateway, 'a'),
      /initial connection or tool synchronization failed/,
      '启用失败必须冒到调用方，否则 patch 已改成启用而连接没起来',
    )
    assert.equal(await readFile(fixture.patchPath, 'utf8'), disabledRow, '失败的 enable 必须把 patch 写回原样')
  } finally {
    await fixture.cleanup()
  }
})
