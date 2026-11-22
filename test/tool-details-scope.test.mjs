import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import * as scope from '@deepseek-ai/dsh-scope'
import { McpManagerGateway } from '../lib/index.js'
import { projectToolSchema } from '../lib/mcp-registry.js'
import { canonicalWorkspacePath, entryIsActive, workspaceToolSchemas } from '../lib/workspace-runtime.js'
import { createLoaderHost, FIXTURE_SERVER, MCP_NAME, TEST_TIMEOUT_MS, waitFor } from '../test-support/loader-host.mjs'

const SERVER_NAME = 'same'
const toolPrefix = `mcp__${SERVER_NAME}__`

// 真 Loader/Include/ToolRuntime + 真 MCP stdio 服务；只替代 agent 的创建入口，
// 作用域、agent/created 派发、项目配置读取、建连与工具投射全部走生产路径。
async function createScopeFixture(t, globalTools) {
  const host = await createLoaderHost('[]\n')
  t.after(() => host.cleanup())

  const server = join(host.root, 'global-server.mjs')
  // 空集也来自一次成功握手的真实 tools/list；disabled 行不会进入 live loader，
  // 不能拿它冒充「有全局条目但没有工具」的生产形态。
  const globalSource = globalTools ? FIXTURE_SERVER : FIXTURE_SERVER.replace(/tools: \[\{[\s\S]*?\}\]/, 'tools: []')
  await writeFile(server, globalSource)
  await host.manager.add({
    name: SERVER_NAME,
    transport: 'stdio',
    command: process.execPath,
    args: [server, join(host.root, 'global-exited')],
  })
  assert.ok(await waitFor(() => host.entries().some(entry =>
    entry.options.name === MCP_NAME && entry.options.config?.serverName === SERVER_NAME && entryIsActive(entry))),
  '前置：全局 MCP 必须真的完成握手与 tools/list，并进入 ACTIVE')
  assert.equal(host.entries().filter(entry => entry.options.config?.serverName === SERVER_NAME).length, 1,
    '前置：全局同名条目必须存在，不能把无全局条目当作全局空工具集')
  const global = host.tools.schemas().filter(tool => tool.name.startsWith(toolPrefix)).map(projectToolSchema)
  assert.equal(global.length, globalTools ? 1 : 0, '前置：全局工具数来自真实运行视图')

  const workspaces = []
  const expected = []
  for (const suffix of ['a', 'b']) {
    const wsPath = join(host.root, `workspace-${suffix}`)
    const server = join(host.root, `workspace-${suffix}-server.mjs`)
    await mkdir(join(wsPath, '.dsh'), { recursive: true })
    // 同名服务器提供不同 wire 工具名，错误作用域不能因为集合碰巧相等而过关。
    await writeFile(server, FIXTURE_SERVER.replace("name: 'echo',", `name: 'workspace_${suffix}',`))
    await writeFile(join(wsPath, '.dsh', 'mcp.json'), JSON.stringify({
      mcpServers: {
        [SERVER_NAME]: { command: process.execPath, args: [server, join(host.root, `workspace-${suffix}-exited`)] },
      },
    }))

    let resolveScope
    const ready = new Promise(resolve => { resolveScope = resolve })
    const key = { toolDetailsWorkspace: suffix }
    host.ctx.inject(['tools'], toolCtx => resolveScope(scope.createScope(toolCtx, key)))
    const agentScope = await ready
    const agent = { session: { header: { cwd: wsPath } }, ctx: agentScope.ctx }
    await host.ctx.serial(host.ctx, 'agent/created', { agent, source: 'startup' })

    const canonical = canonicalWorkspacePath(wsPath)
    assert.ok(await waitFor(() => workspaceToolSchemas(host.ctx, SERVER_NAME, canonical).length === 1),
      '前置：项目 MCP 必须通过真实挂载路径完成握手')
    const project = workspaceToolSchemas(host.ctx, SERVER_NAME, canonical).map(projectToolSchema)
    assert.equal(project.length, 1)
    assert.notDeepEqual(project, global, '前置：项目工具集与全局工具集必须可区分')
    workspaces.push(wsPath)
    expected.push(project)
  }
  assert.notDeepEqual(expected[0], expected[1], '前置：两个项目的同名服务器必须提供不同工具')
  return { host, global, workspaces, expected }
}

for (const globalTools of [true, false]) {
  test(`tools(payload): 项目作用域不被全局${globalTools ? '非空' : '空'}同名条目抢答`, { timeout: TEST_TIMEOUT_MS }, async t => {
    const { host, global, workspaces, expected } = await createScopeFixture(t, globalTools)
    const listTools = payload => McpManagerGateway.prototype.tools.call(host.manager, payload)

    for (let index = 0; index < workspaces.length; index += 1) {
      await t.test(`项目 ${index + 1} 返回自己已注册的完整工具 schema`, async () => {
        const result = await listTools({ name: SERVER_NAME, wsPath: workspaces[index] })
        assert.deepEqual(result.tools, expected[index], '必须按 (wsPath, serverName) 选择真实项目工具集')
        assert.equal(result.ambiguous, false)
      })
    }
    await t.test('未挂载项目不得回退到同名全局工具或另一个项目', async () => {
      const wsPath = join(host.root, 'workspace-unmounted')
      await mkdir(wsPath)
      const result = await listTools({ name: SERVER_NAME, wsPath })
      assert.deepEqual(result.tools, [])
      assert.equal(result.ambiguous, false)
    })
    await t.test('不传 wsPath 保留全局工具集，包括全局空集', async () => {
      const result = await listTools({ name: SERVER_NAME })
      assert.deepEqual(result.tools, global)
    })

    for (const wsPath of ['', '   ', 'relative-workspace', null, 17, false]) {
      await t.test(`非法 wsPath ${JSON.stringify(wsPath)} 不得跳过 canonicalWorkspacePath 校验`, async () => {
        let expectedError
        try { canonicalWorkspacePath(wsPath) } catch (error) { expectedError = error }
        assert.ok(expectedError, '前置：非法值必须被现有路径合法化入口拒绝')
        await assert.rejects(() => listTools({ name: SERVER_NAME, wsPath }), {
          name: expectedError.name,
          message: expectedError.message,
        })
      })
    }
  })
}
