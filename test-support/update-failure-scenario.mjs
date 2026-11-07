// 子进程场景：`update()` 把一条已连上的 MCP 改成起不来的配置。
//
// 为什么必须单开一个进程：这一条会触发**宿主缺陷**——cordis 4.0.5 的 `Fiber.update()` 在
// 插件重启失败时把 `restart()` 的 rejection 丢掉（`internal/update` 里 `this.restart()` 没有
// await），于是进程里会漏一个 unhandled rejection；真宿主装了 fail-loud，那意味着进程退出。
// node:test 会把同进程里的 unhandled rejection 记成用例失败，所以把它放到子进程里跑：
// 父测试断言"我们自己报了错、盘上回滚了、子进程确实收到了那一个 rejection"三件事。
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createLoaderHost, FIXTURE_SERVER, MCP_NAME, waitFor } from './loader-host.mjs'

const rejections = []
process.on('unhandledRejection', (reason) => { rejections.push(String(reason?.message ?? reason)) })

// 这一条同时记录**宿主代次差异**：cordis 4.0.5（0.2.1 宿主）会在重启失败时漏一个
// unhandled rejection（`Fiber.update()` 里 `this.restart()` 没有被 await），
// 4.1.0（0.2.2 宿主）修掉了。把版本一起带出去，父测试按代次断言，而不是按"永远 1 个"。
const require_ = createRequire(import.meta.url)
const cordisVersion = JSON.parse(require_('fs').readFileSync(require_.resolve('@deepseek-ai/cordis/package.json'), 'utf8')).version

const root = await mkdtemp(join(tmpdir(), 'dsh-compat-update-child-'))
const server = join(root, 'fixture-server.mjs')
await writeFile(server, FIXTURE_SERVER)
const patchBody = `- insert:\n    - id: mcp-a\n      name: '${MCP_NAME}'\n      config:\n        transport: stdio\n        serverName: a\n        command: ${process.execPath}\n        args: [ '${server}', '${join(root, 'a-exited')}' ]\n`
const host = await createLoaderHost(patchBody)
const report = { connected: false, error: null, patchRestored: false, rejections, cordisVersion }
try {
  report.connected = Boolean(await waitFor(() => host.toolNames().includes('mcp__a__echo')))
  try {
    await host.manager.update({
      name: 'a',
      transport: 'stdio',
      command: process.execPath,
      args: ['--eval', 'process.exit(3)'],
      failOnStartupError: true,
    })
    report.error = { name: 'none', message: 'update resolved unexpectedly' }
  } catch (error) {
    report.error = {
      name: error?.name,
      message: String(error?.message ?? error),
      persisted: error?.result?.persisted,
      live: error?.result?.live,
    }
  }
  report.patchRestored = (await readFile(host.patch, 'utf8')) === patchBody
  // 等宿主把那个 rejection 抛出来（它来自 fiber.restart() 的 promise）。
  await new Promise((resolve) => setTimeout(resolve, 400))
} finally {
  await host.cleanup()
  await rm(root, { recursive: true, force: true })
}
process.stdout.write(`${JSON.stringify(report)}\n`)
// 让 node 认为自己处理了那个 rejection：否则进程以非零码退出，父测试拿不到 JSON。
process.exitCode = 0
