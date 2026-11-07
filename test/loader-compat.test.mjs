import assert from 'node:assert/strict'
import test from 'node:test'
import { existsSync } from 'node:fs'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createLoaderHost, FIXTURE_SERVER, MCP_NAME, TEST_TIMEOUT_MS, waitFor } from '../test-support/loader-host.mjs'

// 这一组钉的是**行生命周期失败时的语义**：行没起来 / 没禁用成功 / 没移除成功，都必须
// 冒到调用方、并且把盘上的内容写回原样。
//
// 历史：这里曾用假 loader 复刻 `cordis-plugin-loader@1.0.3 → 1.0.6` 的两处行为差异
// （create 总是 resolve、卸载钩子会写回 base）。0.2.2 改由官方 `reconcileProfilePatches`
// 承担实现之后，"插件自己怎么弥补这两处"已经不存在了——但**这两处行为仍然存在**，所以
// 论断改成直接打真宿主：真 Loader + 官方 mountRootInclude + 真 mcp-client。桩上复刻
// 宿主行为的做法（本轮之前）证明不了任何真机结论，正是 design §12.1 记过的坑。

const ONE_ROW = (serverName, extra = '') =>
  `- insert:\n    - id: mcp-${serverName}\n      name: '${MCP_NAME}'\n      config:\n        transport: stdio\n        serverName: ${serverName}\n        command: node\n${extra}`

test('update() 改了连接字段但重连失败：报错并把 patch 写回原样', { timeout: TEST_TIMEOUT_MS }, async () => {
  // 跑在子进程里：这一条会同时暴露一个**宿主缺陷**——cordis 4.0.5 的 `Fiber.update()` 在插件
  // 重启失败时把 `restart()` 的 rejection 丢掉（`internal/update` 里 `this.restart()` 没有
  // await），进程里因此漏一个 unhandled rejection；真宿主装了 fail-loud，那意味着进程退出。
  // 任何走 `Entry.update()` 的路径都中招（官方设置界面同样如此），插件层修不了，所以这里
  // 把它**显式断言**下来，免得它日后悄悄变成"点一下保存就崩"。
  const { spawn } = await import('node:child_process')
  const scenario = join(import.meta.dirname, '..', 'test-support', 'update-failure-scenario.mjs')
  const child = spawn(process.execPath, [scenario], { stdio: ['ignore', 'pipe', 'pipe'] })
  let stdout = ''
  let stderr = ''
  child.stdout.setEncoding('utf8').on('data', (chunk) => { stdout += chunk })
  child.stderr.setEncoding('utf8').on('data', (chunk) => { stderr += chunk })
  const code = await new Promise((resolve) => child.on('exit', resolve))
  assert.equal(code, 0, `子进程必须正常结束（实际 ${code}）：${stderr}`)
  const report = JSON.parse(stdout.trim().split('\n').at(-1))
  assert.equal(report.connected, true, '前置条件：行必须真的连上')
  assert.equal(report.error.name, 'ProfileMutationError', '重连失败必须冒到调用方（并带上事务结果）')
  assert.equal(report.error.persisted, 'rolled-back', '失败必须如实报"已回滚"')
  assert.equal(report.error.live, 'failed')
  assert.equal(report.patchRestored, true, '失败的 update 必须把 patch 写回原样')
  // 宿主代次差异（这是**记录**，不是放宽断言）：
  //   cordis 4.0.5（0.2.1 宿主）`Fiber.update()` 里 `this.restart()` 没有被 await，
  //   重启失败会漏一个 unhandled rejection → 真宿主的 fail-loud 会**退出进程**；
  //   cordis 4.1.0（0.2.2 宿主）已修。版本从子进程里实测读出，不猜。
  const [cordisMajor, cordisMinor] = report.cordisVersion.split('.').map(Number)
  const leaksRejection = cordisMajor === 4 && cordisMinor < 1
  assert.equal(report.rejections.length, leaksRejection ? 1 : 0,
    `cordis ${report.cordisVersion} 的期望泄漏次数是 ${leaksRejection ? 1 : 0}，实际 ${report.rejections.length}`)
  if (leaksRejection) assert.match(report.rejections[0], /initial connection or tool synchronization failed/)
})

test('enable() 启用后起不来：报错并把 patch 写回 disabled 原样', { timeout: TEST_TIMEOUT_MS }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-compat-enable-'))
  const patchBody = `- insert:\n    - id: mcp-a\n      name: '${MCP_NAME}'\n      disabled: true\n      config:\n        transport: stdio\n        serverName: a\n        command: ${process.execPath}\n        args: [ '--eval', 'process.exit(3)' ]\n        failOnStartupError: true\n`
  const host = await createLoaderHost(patchBody)
  try {
    // 前置：禁用行不启动（patch 里 disabled: true）。
    assert.equal(host.toolNames().includes('mcp__a__echo'), false)
    await assert.rejects(
      () => host.manager.enable('a'),
      /initial connection or tool synchronization failed/,
      '启用失败必须冒到调用方，否则 patch 已改成启用而连接没起来',
    )
    assert.equal(await readFile(host.patch, 'utf8'), patchBody, '失败的 enable 必须把 patch 写回原样')
  } finally {
    await host.cleanup()
    await rm(root, { recursive: true, force: true })
  }
})

test('removeServer() 不把已应用的 patch 行写回 base 配置（1.0.6 卸载钩子的陷阱）', { timeout: TEST_TIMEOUT_MS }, async () => {
  // 1.0.6 的卸载钩子会 `fiber.entry.parent.tree.write()`；对 include 子树条目就是
  // `Include.write()`，写的是**已应用树**（base + 其余 patch 行）。所以"删一台服务器"
  // 有可能把兄弟服务器的 patch 行烙进 base 配置，下次启动 base 一份 + insert 一份。
  // 本插件在 reconcile 之前先把要消失的行标成 disabled（该钩子唯一的早退判据）。
  const root = await mkdtemp(join(tmpdir(), 'dsh-compat-remove-'))
  const server = join(root, 'fixture-server.mjs')
  await writeFile(server, FIXTURE_SERVER)
  const patchBody = `- insert:\n    - id: mcp-a\n      name: '${MCP_NAME}'\n      config:\n        transport: stdio\n        serverName: a\n        command: ${process.execPath}\n        args: [ '${server}', '${join(root, 'a-exited')}' ]\n    - id: mcp-b\n      name: '${MCP_NAME}'\n      config:\n        transport: stdio\n        serverName: b\n        command: ${process.execPath}\n        args: [ '${server}', '${join(root, 'b-exited')}' ]\n`
  const host = await createLoaderHost(patchBody)
  try {
    assert.ok(await waitFor(() => host.toolNames().includes('mcp__a__echo')), '前置条件：a 必须连上')
    assert.ok(await waitFor(() => host.toolNames().includes('mcp__b__echo')), '前置条件：b 必须连上')
    const result = await host.manager.removeServer('a')
    assert.equal(result.live, 'applied')
    assert.match(result.note, /停止运行中的连接/)
    assert.equal(host.toolNames().includes('mcp__a__echo'), false, '工具必须从活视图里消失')
    assert.ok(await waitFor(() => existsSync(join(root, 'a-exited'))), 'stdio 子进程必须退出（哨兵文件为证）')
    assert.ok(host.toolNames().includes('mcp__b__echo'), '兄弟服务器不受影响')
    assert.equal(await readFile(host.baseConfig, 'utf8'), '[]\n', 'base 配置必须原样（不得烙进 patch 行）')
    assert.doesNotMatch(await readFile(host.patch, 'utf8'), /serverName: a\n/, 'patch 行也要删掉')
  } finally {
    await host.cleanup()
    await rm(root, { recursive: true, force: true })
  }
})

test('update() 只翻 defer 时不重启连接（遮罩不是生命周期变化）', { timeout: TEST_TIMEOUT_MS }, async () => {
  // 分开写的理由：把 defer 也丢给 reconcile 会让 mcp-client 重启（serena 冷启动实测 1-1.5 分钟），
  // 而用户只是把一个显示开关翻过来。证据用**子进程哨兵**：翻 defer 不该让子进程退出。
  const root = await mkdtemp(join(tmpdir(), 'dsh-compat-defer-'))
  const server = join(root, 'fixture-server.mjs')
  const sentinel = join(root, 'a-exited')
  await writeFile(server, FIXTURE_SERVER)
  const host = await createLoaderHost(ONE_ROW('a').replace('command: node\n', `command: ${process.execPath}\n        args: [ '${server}', '${sentinel}' ]\n`))
  try {
    assert.ok(await waitFor(() => host.toolNames().includes('mcp__a__echo')), '前置条件：行必须真的连上')
    const result = await host.manager.update({ name: 'a', transport: 'stdio', command: process.execPath, args: [server, sentinel], defer: true })
    assert.equal(result.live, 'applied')
    await new Promise((resolve) => setTimeout(resolve, 300))
    assert.equal(existsSync(sentinel), false, '翻 defer 不该重启连接（子进程还活着）')
    const row = (await host.manager.list()).servers.find((server) => server.serverName === 'a')
    assert.equal(row.defer, true, '遮罩必须落到运行中的条目上')
    assert.match(await readFile(host.patch, 'utf8'), /defer: true/)
  } finally {
    await host.cleanup()
    await rm(root, { recursive: true, force: true })
  }
})

