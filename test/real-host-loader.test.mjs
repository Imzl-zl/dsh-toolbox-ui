import assert from 'node:assert/strict'
import test from 'node:test'
import { existsSync } from 'node:fs'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { DEFAULTS } from '../lib/tool-search-runtime.js'
import { readToolSearchSettingsFromPatch } from '../lib/tool-search-settings.js'
import { readManagedMcpServers } from '../lib/mcp-config.js'
import {
  createLoaderHost,
  FIXTURE_SERVER,
  FIXTURE_SERVER_ENV_PROBE,
  MCP_NAME,
  TEST_TIMEOUT_MS,
  waitFor,
} from './helpers/loader-host.mjs'

// 这一组用例打的是 **O1 的生产形状**：真 cordis Context + 真 Loader + **官方 mountRootInclude**
// 挂的根 Include + 真 ToolRuntime + 真 mcp-client 连**真 stdio 子进程**。
//
// 为什么不能用手写夹具：条目的生命周期契约（谁建、谁删、删除时宿主的卸载钩子会写什么）
// 全在 loader 与 include 内部，桩上给 loader 补一个 create/remove 只能证明"插件调用了它"。
// 前两轮用真金白银换来的教训就在 docs/mcp-tool-search-design.md §12.1：夹具全绿、真宿主炸。

test('real loader host: add() applies the new row through the profile composition, so the server connects without a host restart', { timeout: TEST_TIMEOUT_MS }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-o1-add-'))
  const server = join(root, 'fixture-server.mjs')
  const sentinel = join(root, 'beta-exited')
  await writeFile(server, FIXTURE_SERVER)
  // 开局：patch 里只有 fixture 一台，根 Include 按 profile 组合把它挂起来（= 生产形状）。
  const host = await createLoaderHost(
    `- insert:\n    - id: mcp-fixture\n      name: '${MCP_NAME}'\n      config:\n        transport: stdio\n        serverName: fixture\n        command: ${process.execPath}\n        args: [ '${server}', '${join(root, 'fixture-exited')}' ]\n`,
  )
  try {
    const connected = await waitFor(() => host.toolNames().includes('mcp__fixture__echo'))
    assert.ok(connected, '前置条件：patch 行里的条目必须真的连上')

    const result = await host.manager.add({ name: 'beta', transport: 'stdio', command: process.execPath, args: [server, sentinel] })
    // 结构化结果：盘上与运行中**同一事实**，两半都要如实报。
    assert.equal(result.persisted, 'applied', 'add 必须报"盘上已写"')
    assert.equal(result.live, 'applied', 'add 必须报"运行中已生效"（not skipped/failed）')
    assert.match(result.note, /开始连接/)
    assert.doesNotMatch(result.note, /重启后生效/, '连上了就不该再让用户重启')

    // 1. 组合应用之后条目在 loader 里，且 id 与 patch 行一致（resolveManagedEntry 靠它认人）。
    const created = host.entries().filter((entry) => entry.options.config?.serverName === 'beta')
    assert.equal(created.length, 1, 'add 必须让条目真的进 loader')
    assert.equal(created[0].options.id, 'mcp-beta', '条目 id 必须与 patch 行一致（resolveManagedEntry 靠它认人）')

    // 2. 工具真的进了活视图（不需要重启进程）。
    assert.ok(
      await waitFor(() => host.toolNames().includes('mcp__beta__echo')),
      'add 之后新服务器的工具必须立刻可见',
    )

    // 3. 面板必须把它认成"自己管的、连上了"——否则用户既不能改也不能卸。
    const row = (await host.manager.list()).servers.find((server) => server.serverName === 'beta')
    assert.equal(row.managed, true, 'patch 行里的条目不得被划成 external')
    assert.equal(row.phase, 'connected')
    assert.equal(row.toolCount, 1)

    // 4. 只有一份配置行，而且 **base 配置一个字节都不该动**：reconcile 走的是 include 的
    //    patch 层，不是把已应用树写回 cordis.yml（那会造成下次启动 base 一份 + insert 一份）。
    assert.equal((await readFile(host.patch, 'utf8').then((text) => text.match(/serverName: beta/g) || [])).length, 1)
    assert.equal(await readFile(host.baseConfig, 'utf8'), '[]\n', '应用 patch 不得把行烙进 base 配置')
  } finally {
    await host.cleanup()
    await rm(root, { recursive: true, force: true })
  }
})

test('real loader host: patch 行由 profile 组合挂载，base 配置全程不被写回', { timeout: TEST_TIMEOUT_MS }, async () => {
  // 这条守的是 rc.5（loader 1.0.6）的一个真实陷阱：插件卸载时 `entry.parent.tree.write()`
  // 对 include 子树条目就是 `Include.write()`，写的是**已应用树**（base + patch 行）。于是
  // "删一台服务器"可能把兄弟服务器的 patch 行烙进 base 配置，下次启动重复插入。
  // 断言方向：任何一次行变更之后，base 都还是原样。
  const root = await mkdtemp(join(tmpdir(), 'dsh-o1-rootwrite-'))
  const server = join(root, 'fixture-server.mjs')
  await writeFile(server, FIXTURE_SERVER)
  const host = await createLoaderHost(
    `- insert:\n    - id: mcp-fixture\n      name: '${MCP_NAME}'\n      config:\n        transport: stdio\n        serverName: fixture\n        command: ${process.execPath}\n        args: [ '${server}', '${join(root, 'fixture-exited')}' ]\n`,
  )
  try {
    assert.ok(await waitFor(() => host.toolNames().includes('mcp__fixture__echo')), '前置条件：条目必须真的连上')
    assert.equal(await readFile(host.baseConfig, 'utf8'), '[]\n')

    await host.manager.setDisabled('fixture', true)
    assert.equal(await readFile(host.baseConfig, 'utf8'), '[]\n', '禁用不得写回 base 配置')
    await host.manager.setDisabled('fixture', false)
    assert.equal(await readFile(host.baseConfig, 'utf8'), '[]\n', '启用不得写回 base 配置')
    await host.manager.add({ name: 'extra', transport: 'stdio', command: process.execPath, args: [server, join(root, 'extra-exited')] })
    await new Promise((resolve) => setTimeout(resolve, 300))
    assert.equal(await readFile(host.baseConfig, 'utf8'), '[]\n', '新增不得写回 base 配置')
    await host.manager.removeServer('extra')
    await new Promise((resolve) => setTimeout(resolve, 300))
    assert.equal(await readFile(host.baseConfig, 'utf8'), '[]\n', '移除不得把其余 patch 行烙进 base 配置')
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
  const host = await createLoaderHost('[]\n')
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
  // 环境变量表达式是**生产契约**（`${VAR}` 必须求值，不能原样透传给子进程）。期望值必须来自
  // 进程环境本身，而不是复述实现或依赖某台机器恰好有 HOME：
  // 旧写法用 `${HOME}` + `process.env.HOME.replace(...)`，在 Windows 上 HOME 未定义，
  // 断言先炸在测试自己身上——那是环境依赖，不是被测行为。这里用测试专有的随机变量：
  // 值由本进程环境给（边界输入），子进程 dump 出来（真实结果），随机串让"原样透传"无从蒙对。
  const marker = randomUUID()
  process.env.DSH_TEST_ENV_MARKER = marker
  const host = await createLoaderHost('[]\n')
  try {
    // 归一化把 `${VAR}` 变成内部 `!!js (process.env.VAR ?? "")`。
    await host.manager.add({
      name: 'withenv',
      transport: 'stdio',
      command: process.execPath,
      args: [server, join(root, 'unused'), dump],
      env: { MARKER: '${DSH_TEST_ENV_MARKER}' },
    })
    assert.ok(await waitFor(() => existsSync(dump)), '新服务器必须真的连上')
    assert.match(await readFile(dump, 'utf8'), new RegExp(`MARKER=${marker}`),
      'env 表达式必须被求值：loader 只对 { __jsExpr } 求值，raw 字符串原样透传给子进程')
  } finally {
    delete process.env.DSH_TEST_ENV_MARKER
    await host.cleanup()
    await rm(root, { recursive: true, force: true })
  }
})

test('real loader host: installBuiltins() appends live loader entries for the selected builtins', { timeout: TEST_TIMEOUT_MS }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-o1-builtins-'))
  const host = await createLoaderHost('[]\n')
  try {
    const result = await host.manager.installBuiltins({ ids: ['exa'] })
    assert.deepEqual(result.added, ['exa'])
    assert.equal(result.live, 'applied', '内置条目必须由组合真的挂起来（不是只写盘）')
    assert.match(result.note, /开始连接/)

    // 追加的条目必须真的进 loader（旧行为只写盘，点完"安装"连不上也没工具）。
    const created = host.entries().filter((entry) => entry.options.config?.serverName === 'exa')
    assert.equal(created.length, 1, 'installBuiltins 必须在 loader 里创建条目')
    assert.equal(created[0].options.id, 'mcp-exa', '条目 id 必须与 patch 行一致')
    // 行的归属由 profile 组合决定（include 子树），插件不再自己在 loader 根部造条目。
    const includeTree = host.ctx.loader.resolve('include').subtree
    assert.ok([...includeTree.entries()].includes(created[0]), '条目必须由 include 组合持有（不是插件手搭的根条目）')
    assert.equal(created[0].options.config.url, 'https://mcp.exa.ai/mcp')

    // 连接本身不在这里断言（要打真实网络）：连什么、怎么连由 add 那条用例的真夹具覆盖，
    // 这条只钉"条目进了 loader"这件新发生的事。
    assert.match(await readFile(host.patch, 'utf8'), /serverName: exa/)
  } finally {
    await host.cleanup()
    await rm(root, { recursive: true, force: true })
  }
})

// 真实安装形态（`dsh plugin add` → 进 bundles）：那条 insert 住在**包自己的** cordis.patch.yml
// （bundle 层），用户 profile 的 patch 里根本没有我们这条。早期实现要求它存在，于是主安装路径下
// 行内单台延迟开关（1.8.1）：面板行上那颗「延迟 / 全量」芯片直接调 setDefer。
// 这条钉三件真机才有的事：① 只改被点的那一台（不误伤旁边那台）；② 磁盘上新值、内存活条目
// 也同步（deferServersOf 读的是 entry.options.config.defer，只写盘不改内存 = 改了不生效）；
// ③ 名字对不上时必须**报错**，不能静默 no-op。
test('real loader host: 单台延迟开关只改那一台，并同步内存活条目', { timeout: TEST_TIMEOUT_MS }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-o1-setdefer-'))
  const server = join(root, 'fixture-server.mjs')
  await writeFile(server, FIXTURE_SERVER)
  const patchBody = [
    '- insert:',
    '  - id: mcp-alpha',
    `    name: '${MCP_NAME}'`,
    '    config:',
    '      transport: stdio',
    '      serverName: alpha',
    `      command: ${process.execPath}`,
    `      args: [ '${server}', '${join(root, 'alpha-exited')}' ]`,
    '  - id: mcp-beta',
    `    name: '${MCP_NAME}'`,
    '    config:',
    '      transport: stdio',
    '      serverName: beta',
    `      command: ${process.execPath}`,
    `      args: [ '${server}', '${join(root, 'beta-exited')}' ]`,
    '      defer: true',
    '',
  ].join('\n')
  const host = await createLoaderHost(patchBody)
  try {
    await waitFor(() => host.toolNames().includes('mcp__beta__echo'))
    const deferOf = async (name) => (await host.manager.list()).servers.find((row) => row.serverName === name)?.defer
    assert.equal(await deferOf('beta'), true, '前置：beta 已在延迟')
    assert.notEqual(await deferOf('alpha'), true, '前置：alpha 未延迟（没写 defer 时是 undefined，语义上等同不延迟）')

    const result = await host.manager.setDefer({ name: 'alpha', defer: true })
    assert.equal(result.changed, 1, '只该改一台')
    assert.match(result.note, /alpha/)

    // ① 盘上：alpha 变 true，beta 原样。用**生产解析器**读回来（正则会被长路径撑破，
    //    而且断言的是"面板读到的配置"，不是 YAML 文本长什么样）。
    const written = await readFile(host.patch, 'utf8')
    const parsedRows = readManagedMcpServers(written).servers
    assert.equal(parsedRows.find((row) => row.name === 'alpha').defer, true, 'alpha 的 defer 必须落盘')
    assert.equal(parsedRows.find((row) => row.name === 'beta').defer, true, 'beta 本来就在延迟，不该被这次操作带成别的值')
    assert.equal(await deferOf('alpha'), true)
    assert.equal(await deferOf('beta'), true, 'beta 本来就在延迟，不该被这次操作带成别的值')

    // ② 内存活条目同步：deferServersOf 读的正是它，只写盘不改内存 = 运行中的会话读旧值。
    const alphaEntry = host.entries().find((entry) => entry.options.config?.serverName === 'alpha')
    assert.equal(alphaEntry.options.config.defer, true)

    // ③ 名字不存在：明确报错，不静默 no-op。
    await assert.rejects(host.manager.setDefer({ name: 'ghost', defer: true }), /没有这个 MCP/)
    // 反向再切回来，别把 beta 一起带走。
    await host.manager.setDefer({ name: 'alpha', defer: false })
    assert.notEqual(await deferOf('alpha'), true)
    assert.equal(await deferOf('beta'), true)
  } finally {
    await host.cleanup()
    await rm(root, { recursive: true, force: true })
  }
})

// 面板保存必然失败——而 `call()` 不抛错，失败还被 UI 当成成功（真机点一次才发现）。
test('real loader host: 插件按 bundle 安装（patch 里没有自己的条目）时，保存追加 id 定向覆盖并当场生效', { timeout: TEST_TIMEOUT_MS }, async () => {
  const patchBody = [
    '# 用户自己的 patch：只有别的插件的配置',
    '- id: ui-settings-general',
    '  name: "@deepseek-ai/dsh-client-ui-settings-general"',
    '  config:',
    '    welcomeNoticeVersion: 2026-09-28.1',
    '',
  ].join('\n')
  const host = await createLoaderHost(patchBody)
  try {
    const registered = () => host.tools.schemas().find((schema) => schema.name === 'tool_search')
    assert.match(registered().parameters.properties.max_results.description, /\(1-10\)/)

    const saved = await host.manager.updateToolSearchSettings({ settings: { maxResults: 6 } })
    // 目录预算写**字面** undefined：跟 DEFAULTS 比等于自己跟自己比，默认值哪天被改回数字也测不出来。
    assert.deepEqual(saved.settings, { maxResults: 6, maxCatalogChars: undefined, maxDiscovered: DEFAULTS.maxDiscovered })

    const written = await readFile(host.patch, 'utf8')
    assert.match(written, /welcomeNoticeVersion/, '别人的条目不受影响')
    assert.match(written, /- id: mcp-manager-ui/, '必须追加一条 id 定向覆盖（宿主的 patch 语义会把它合并进 bundle 层那条）')
    assert.doesNotMatch(written, /name: dsh-toolbox-ui/, '不能 insert 第二个插件实例——那会把面板挂两遍')
    assert.deepEqual(
      readToolSearchSettingsFromPatch(written, { name: 'dsh-toolbox-ui', id: 'mcp-manager-ui' }),
      { maxResults: 6 },
    )
    assert.match(registered().parameters.properties.max_results.description, /\(1-6\)/, '同一进程里当场生效')
  } finally {
    await host.cleanup()
  }
})

// ── C2：延迟加载参数（面板表单 → 插件自己的 patch 行 → 运行中生效）──
//
// 为什么必须在这一组里：C2 的落点是**插件自己那条 patch 条目的 config**，而"改配置怎么生效"
// 完全取决于真实 loader 的形状——patch 文件不会被热加载，所以"只写盘"等于改了没反应。
// 夹具里给一个假 loader 只能证明"插件调用了写盘函数"，那正是设计文档 §12.1 记过的坑。
// 这一条覆盖的是**手写 insert 条目**的形态（条目就在用户 patch 里）。
// 变更型 RPC 的共同结果契约：写盘事实与运行中事实分开报。面板据此显示"已保存但未生效"，
// 所以这组字段不是装饰——缺一个就分不清"写了没生效"与"根本没写"。
// 这里逐个真调（真 loader + 真 mcp-client），断言在**真实返回形状**上，而不是 describe 一份文档。
test('每个变更型 RPC 都返回 persisted / live / diagnostics', { timeout: TEST_TIMEOUT_MS }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-o1-results-'))
  const server = join(root, 'fixture-server.mjs')
  const sentinel = join(root, 'a-exited')
  await writeFile(server, FIXTURE_SERVER)
  const host = await createLoaderHost(
    `- insert:\n    - id: mcp-a\n      name: '${MCP_NAME}'\n      config:\n        transport: stdio\n        serverName: a\n        command: ${process.execPath}\n        args: [ '${server}', '${sentinel}' ]\n`,
  )
  const assertResult = (label, result) => {
    assert.ok(['applied', 'unchanged', 'rolled-back', 'failed'].includes(result.persisted), `${label}.persisted=${result.persisted}`)
    assert.ok(['applied', 'unchanged', 'skipped', 'failed'].includes(result.live), `${label}.live=${result.live}`)
    assert.ok(Array.isArray(result.diagnostics), `${label}.diagnostics 必须是数组`)
    for (const entry of result.diagnostics) {
      assert.equal(typeof entry.code, 'string', `${label} 的诊断必须带 code`)
      assert.equal(typeof entry.message, 'string', `${label} 的诊断必须带 message`)
    }
    // note 是可选的人类文案（读类字段不需要）；三字段才是契约。
  }
  try {
    assert.ok(await waitFor(() => host.toolNames().includes('mcp__a__echo')), '前置条件：行必须真的连上')
    assertResult('add', await host.manager.add({ name: 'b', transport: 'stdio', command: process.execPath, args: [server, join(root, 'b-exited')] }))
    assertResult('disable', await host.manager.disable('b'))
    assertResult('enable', await host.manager.enable('b'))
    assertResult('update', await host.manager.update({ name: 'b', transport: 'stdio', command: process.execPath, args: [server, join(root, 'b-exited')], directTools: true }))
    assertResult('setDefer', await host.manager.setDefer({ name: 'b', defer: true }))
    assertResult('setDeferAll', await host.manager.setDeferAll({ defer: false }))
    assertResult('reconnect', await host.manager.reconnect('b'))
    assertResult('importJson', await host.manager.importJson({ mode: 'merge', json: { mcpServers: {} } }))
    assertResult('updateToolSearchSettings', await host.manager.updateToolSearchSettings({ settings: { maxResults: 12 } }))
    // 同一份值再存一次：盘上不该再写（persisted=unchanged），运行值已经等于目标（live=unchanged）。
    // 这条比"字段齐全"更硬：它钉住的是这两个字段的**语义**，而不只是形状。
    const repeatSettings = await host.manager.updateToolSearchSettings({ settings: { maxResults: 12 } })
    assert.equal(repeatSettings.persisted, 'unchanged', '内容没变的保存不得再写一次盘')
    assert.equal(repeatSettings.live, 'unchanged', '运行值已等于目标时必须报 unchanged，而不是 applied')
    assertResult('updateToolLoadingSettings', await host.manager.updateToolLoadingSettings({ policy: { tools: { read: 'deferred' } } }))
    const repeatPolicy = await host.manager.updateToolLoadingSettings({ policy: { tools: { read: 'deferred' } } })
    assert.equal(repeatPolicy.live, 'unchanged', '策略没变的保存同样不得报"已生效"')
    assertResult('removeServer', await host.manager.removeServer('b'))
  } finally {
    await host.cleanup()
    await rm(root, { recursive: true, force: true })
  }
})

test('real loader host: 面板改延迟参数 → 写进 plugin patch 并当场重装运行时（不重启）', { timeout: TEST_TIMEOUT_MS }, async () => {
  // 行必须连**真**夹具服务器：只写 `command: node` 时子进程会把 MCP 的 stdin 当脚本读，
  // 于是它既不握手也不退出——rc.1 的 mcp-client 在 dispose 时会等子进程收尾，测试就在
  // cleanup 上卡到超时（rc.5 那边恰好提前失败，所以没暴露）。夹具必须是能握手的进程。
  const root = await mkdtemp(join(tmpdir(), 'dsh-o1-settings-'))
  const server = join(root, 'fixture-server.mjs')
  await writeFile(server, FIXTURE_SERVER)
  const patchBody = [
    '# profile patch：注释必须原样保留',
    '- insert:',
    '  - id: mcp-manager-ui',
    '    name: dsh-toolbox-ui',
    '  - id: mcp-filesystem',
    "    name: '@deepseek-ai/dsh-mcp-client'",
    '    config:',
    '      transport: stdio',
    '      serverName: fs',
    `      command: ${process.execPath}`,
    `      args: [ '${server}', '${join(root, 'fs-exited')}' ]`,
    '',
  ].join('\n')
  const host = await createLoaderHost(patchBody)
  try {
    const DEFAULT_SETTINGS = {
      maxResults: DEFAULTS.maxResults,
      maxCatalogChars: DEFAULTS.maxCatalogChars,
      maxDiscovered: DEFAULTS.maxDiscovered,
    }
    const registered = () => host.tools.schemas().find((schema) => schema.name === 'tool_search')

    // 1) 读：没有配置时就是默认值（面板照这个渲染）。
    const initial = await host.manager.toolSearchSettings()
    assert.deepEqual(initial.settings, DEFAULT_SETTINGS)
    assert.deepEqual(initial.defaults, DEFAULT_SETTINGS)
    assert.match(registered().parameters.properties.max_results.description, new RegExp(`\\(1-${DEFAULTS.maxResults}\\)`))

    // 2) 写：三个都改，落盘是稀疏的（都≠默认，所以三个都写）。
    const saved = await host.manager.updateToolSearchSettings({ settings: { maxResults: 25, maxCatalogChars: 120, maxDiscovered: 25 } })
    assert.deepEqual(saved.settings, { maxResults: 25, maxCatalogChars: 120, maxDiscovered: 25 })
    const written = await readFile(host.patch, 'utf8')
    assert.match(written, /# profile patch：注释必须原样保留/, '注释不得被写丢')
    assert.match(written, /serverName: fs/, '别的条目一个字都不该动')
    assert.deepEqual(readToolSearchSettingsFromPatch(written, { name: 'dsh-toolbox-ui' }), {
      maxResults: 25,
      maxCatalogChars: 120,
      maxDiscovered: 25,
    })

    // 3) 生效：**同一个宿主进程**里注册的工具定义已换成新上限。
    //    这是 C2 的核心断言——只写盘不重装的话，运行值已是 25 而模型看到的上限还是 10，
    //    也就是"文件对了、行为没变"。
    assert.match(registered().parameters.properties.max_results.description, /\(1-25\)/,
      '改完参数后模型可见的工具定义必须跟着变：否则面板说生效了、模型看到的还是旧上限')
    assert.equal(host.tools.schemas().filter((schema) => schema.name === 'tool_search').length, 1,
      '重装不得留下两份 tool_search（先拆后装）')

    // 4) 回到默认 → 键被删掉，而不是写回 10/300/20。
    const reset = await host.manager.updateToolSearchSettings({ settings: DEFAULT_SETTINGS })
    assert.deepEqual(reset.settings, DEFAULT_SETTINGS)
    assert.doesNotMatch(await readFile(host.patch, 'utf8'), /toolSearch/, '等于默认的值不得落盘（将来调默认值才不会被老数字钉住）')
    assert.match(registered().parameters.properties.max_results.description, new RegExp(`\\(1-${DEFAULTS.maxResults}\\)`))

    // 5) 非法值：明确报错，且**盘上不动**（先校验再写）。
    const before = await readFile(host.patch, 'utf8')
    await assert.rejects(host.manager.updateToolSearchSettings({ settings: { maxResults: 0 } }), /maxResults/)
    assert.equal(await readFile(host.patch, 'utf8'), before, '非法值不得写进配置')
  } finally {
    await host.cleanup()
    await rm(root, { recursive: true, force: true })
  }
})

test('real loader host: 工具加载面板读到的是真实工具与理由（不是空列表）', { timeout: TEST_TIMEOUT_MS }, async () => {
  // 面板读的是"当前进程可见的工具 + 每个工具的决策"。这里曾经有一个真实缺陷：
  // 读取时没有 agent，决策回退成空工具表，于是面板永远显示"当前没有可管理的工具"。
  const patchBody = '- insert:\n  - id: mcp-manager-ui\n    name: dsh-toolbox-ui\n'
  const host = await createLoaderHost(patchBody)
  try {
    host.tools.register({
      name: 'read',
      description: 'read a file',
      parameters: { type: 'object', properties: {} },
      output: { schema: { type: 'object', additionalProperties: true }, render: (_a, value) => [{ type: 'text', text: JSON.stringify(value) }] },
      async execute() { return { ok: true }; },
    })

    const view = await host.manager.toolLoadingSettings()
    assert.equal(view.policy.mode, 'legacy', '面板不再写整体模式：legacy = MCP 仍由每台服务器自己的开关决定')
    assert.ok(view.tools.length >= 2, `必须列出真实工具（实际 ${view.tools.length}）`)
    const read = view.tools.find((row) => row.name === 'read')
    assert.ok(read, '注册过的工具要出现在列表里')
    assert.equal(read.kind, 'builtin', '非 MCP 工具归到 builtin 组')
    assert.equal(read.policy, 'resident', '默认常驻')
    assert.equal(read.reason, 'default-resident')
    assert.equal(view.tools.find((row) => row.name === 'tool_search').reason, 'protected', '搜索入口永远受保护')

    // 逐个把它点成"可搜索"：这才是这个功能唯一的开关。
    await host.manager.updateToolLoadingSettings({ policy: { tools: { read: 'deferred' } } })
    const after = await host.manager.toolLoadingSettings()
    assert.equal(after.tools.find((row) => row.name === 'read').policy, 'deferred')
    assert.equal(after.tools.find((row) => row.name === 'read').reason, 'global-tool')
    assert.equal(after.tools.find((row) => row.name === 'read').inheritedPolicy, read.policy, '删除本层覆盖后的结果必须与原始默认决策一致')

    // 再点回常驻：显式 resident 覆盖。
    await host.manager.updateToolLoadingSettings({ policy: { tools: { read: 'resident' } } })
    const back = await host.manager.toolLoadingSettings()
    assert.equal(back.tools.find((row) => row.name === 'read').policy, 'resident')
  } finally {
    await host.cleanup()
  }
})

test('real loader host: 拼错的参数键拒绝而不是被静默当成"恢复默认"', { timeout: TEST_TIMEOUT_MS }, async () => {
  // 加载期的 config schema 一直是 strict 的（拼错键当场报错），而保存走的 RPC 载荷
  // 只按已知键摘值——于是 `maxResutls` 这种拼写会**静默**变成 {}，把用户此前的设置
  // 一并当作"回默认"写掉。同一条配置的两条入口必须用同一套严格口径。
  const patchBody = '- insert:\n  - id: mcp-manager-ui\n    name: dsh-toolbox-ui\n'
  const host = await createLoaderHost(patchBody)
  try {
    await host.manager.updateToolSearchSettings({ settings: { maxResults: 30 } })
    const before = await readFile(host.patch, 'utf8')

    await assert.rejects(host.manager.updateToolSearchSettings({ settings: { maxResutls: 25 } }), /maxResutls/)
    await assert.rejects(host.manager.updateToolSearchSettings({ settings: { threshold: 15 } }), /threshold/)
    await assert.rejects(host.manager.updateToolSearchSettings({}), /settings/)
    await assert.rejects(host.manager.updateToolSearchSettings({ settings: [] }), /settings/)

    assert.equal(await readFile(host.patch, 'utf8'), before, '被拒的保存一个字都不该写')
    assert.equal((await host.manager.toolSearchSettings()).settings.maxResults, 30, '运行值也必须保持不变')
  } finally {
    await host.cleanup()
  }
})

test('real loader host: 并发保存后，运行值与盘上配置一致（不得只生效一半）', { timeout: TEST_TIMEOUT_MS }, async () => {
  // 复现过的缺陷：`live` 快照在等写锁之前取，锁后仍拿它判断 changed。两个标签页几乎同时
  // 保存时，后来的那次可能用过期快照判出"没变化"，于是盘上写成了 B，运行时却停在 A。
  const patchBody = '- insert:\n  - id: mcp-manager-ui\n    name: dsh-toolbox-ui\n'
  const host = await createLoaderHost(patchBody)
  try {
    const registered = () => host.tools.schemas().find((schema) => schema.name === 'tool_search')
    await Promise.all([
      host.manager.updateToolSearchSettings({ settings: { maxResults: 25 } }),
      host.manager.updateToolSearchSettings({ settings: { maxResults: 7 } }),
    ])

    const persisted = readToolSearchSettingsFromPatch(await readFile(host.patch, 'utf8'), { name: 'dsh-toolbox-ui' })
    // 不钉"哪一次最后写"（那是调度顺序，不是我们要的性质）：钉的是三方一致。
    assert.ok(persisted.maxResults === 25 || persisted.maxResults === 7, `盘上必须是两次保存之一，实际：${persisted.maxResults}`)
    const live = (await host.manager.toolSearchSettings()).settings.maxResults
    assert.equal(live, persisted.maxResults, '运行值必须等于盘上的值')
    assert.match(registered().parameters.properties.max_results.description, new RegExp(`\\(1-${persisted.maxResults}\\)`),
      '模型可见的上限也必须等于盘上的值')
  } finally {
    await host.cleanup()
  }
})
