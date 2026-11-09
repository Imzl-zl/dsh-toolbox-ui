import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import test from 'node:test'

const { McpManagerGateway } = await import('../lib/index.js')
const { readManagedMcpServers } = await import('../lib/mcp-config.js')

const SECRET = 'sk-live-LEAKCHECK-9000'

const CODEX_TOML = `[mcp_servers.api]
url = "https://mcp.example.test/mcp"
bearer_token_env_var = "COMPANY_TOKEN"
http_headers = { "X-Api-Key" = "${SECRET}" }
tool_timeout_sec = 30

[mcp_servers.files]
command = "npx"
args = ["-y", "server-filesystem", "/data"]
env = { LOG_LEVEL = "debug" }
enabled = false

[mcp_servers.tools]
command = "npx"
enabled_tools = ["read_file"]

# 不可转换的条目：只影响它自己，不影响同文件其余条目。
[mcp_servers.bad]
command = "node"
url = "https://example.test/mcp"
`

const CLAUDE_JSON = JSON.stringify({
  mcpServers: { files: { command: 'node', args: ['server.js'] } },
  projects: { 'C:\\somewhere-else': { mcpServers: { ignored: { command: 'node' } } } },
})

/** profile patch fixture：与 host-import.test.mjs 同构，保证写盘走真实路径。 */
async function createProfileFixture(content) {
  const root = await mkdtemp(join(tmpdir(), 'dsh-mcp-sources-'))
  const rootConfig = join(root, 'cordis.yml')
  const patchPath = join(root, 'cordis.patch.yml')
  await writeFile(rootConfig, '[]\n')
  await writeFile(patchPath, content)
  const entries = [{ options: { id: 'include', name: 'cordis:include', config: { path: pathToFileURL(rootConfig).href } } }]
  // 项目级写路径要求目标是**已注册**的工作区（真实宿主里项目标签就是注册表的内容）。夹具显式
  // 登记，而不是让测试假装没有这道门：忘记登记的用例会收到与真实宿主一样的报错。
  const openWorkspaces = []
  const registry = { list: () => openWorkspaces.map((path) => ({ path })) }
  return {
    root,
    patchPath,
    openWorkspace: (path) => openWorkspaces.push(path),
    ctx: {
      loader: { entries: () => entries },
      tools: { schemas: () => [] },
      get: (name) => (name === 'workspaceRegistry' ? registry : undefined),
    },
    async cleanup() {
      await rm(root, { recursive: true, force: true })
    },
  }
}

/**
 * 把每个客户端配置文件的落点都指向临时目录，让扫描完全离线：既覆盖 HOME 派生的
 * 路径，也覆盖各客户端自己的环境变量覆盖（CODEX_HOME / CLAUDE_CONFIG_DIR）。
 */
async function withSourceEnvironment(files, run, extraEnv = () => ({})) {
  const root = await mkdtemp(join(tmpdir(), 'dsh-mcp-env-'))
  const home = join(root, 'home')
  const appData = join(root, 'appdata')
  const configHome = join(root, 'config')
  await mkdir(home, { recursive: true })
  await mkdir(appData, { recursive: true })
  await mkdir(configHome, { recursive: true })
  for (const [relative, text] of Object.entries(files)) {
    const path = join(root, relative)
    await mkdir(join(path, '..'), { recursive: true })
    await writeFile(path, text)
  }
  const previous = {}
  const overrides = {
    HOME: home,
    USERPROFILE: home,
    APPDATA: appData,
    XDG_CONFIG_HOME: configHome,
    CODEX_HOME: join(root, 'codex-home'),
    ...extraEnv(root),
  }
  for (const [key, value] of Object.entries(overrides)) {
    previous[key] = process.env[key]
    process.env[key] = value
  }
  try {
    return await run({ root, home, appData, configHome })
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
    await rm(root, { recursive: true, force: true })
  }
}

test('scan reports names, transports and masked field names without leaking any value', async () => {
  await withSourceEnvironment(
    {
      'codex-home/config.toml': CODEX_TOML,
      'home/.claude.json': CLAUDE_JSON,
    },
    async () => {
      const fixture = await createProfileFixture('[]\n')
      try {
        const result = await McpManagerGateway.prototype.scanImportSources.call({ ctx: fixture.ctx }, {})
        const serialized = JSON.stringify(result)
        assert.equal(serialized.includes(SECRET), false, '扫描结果不得包含字面密钥')
        assert.equal(serialized.includes('server-filesystem'), false, 'args 的值不出 Host')

        const codex = result.sources.find((source) => source.key === 'codex:global')
        assert.deepEqual(codex.entries.map((entry) => entry.name), ['api', 'files', 'tools', 'bad'])
        const api = codex.entries.find((entry) => entry.name === 'api')
        // 投影的键集就是这条功能的对外契约（也是泄密面），钉死它：多一个键就意味着
        // 多一份可能把用户主目录里的东西送到浏览器上的数据。
        assert.deepEqual(Object.keys(codex).sort(), ['displayPath', 'entries', 'error', 'key', 'label', 'scope', 'sourceId', 'warnings'])
        assert.deepEqual(Object.keys(api).sort(), ['error', 'maskedFields', 'missingEnv', 'name'])
        // 掩码规则与列表投影一致：只有带凭据/查询串的 URL 才会被掩码。
        assert.deepEqual(api.maskedFields, ['headers'])
        assert.equal(api.error, null)
        assert.match(codex.entries.find((entry) => entry.name === 'bad').error, /同时配置了 command 和 url/)
        assert.equal(codex.entries.find((entry) => entry.name === 'files').maskedFields.includes('args'), true)
        // 只回变量名：远程条目引用的 COMPANY_TOKEN 在测试进程里没值。
        assert.deepEqual(api.missingEnv, ['COMPANY_TOKEN'])
        assert.ok(codex.warnings.some((warning) => warning.includes('enabled_tools')))
        assert.equal(codex.displayPath.endsWith(join('codex-home', 'config.toml')), true, 'CODEX_HOME 覆盖生效')

        // 走 HOME 默认位置的来源把用户名换回 `~` 再送出。
        const claude = result.sources.find((source) => source.key === 'claude-code:global')
        assert.equal(claude.displayPath, '~/.claude.json')
        assert.equal('spec' in api, false, '扫描投影不得携带条目本体')
        assert.equal('path' in codex, false, '只暴露脱敏后的 displayPath')
        assert.deepEqual(claude.entries.map((entry) => entry.name), ['files'])
        assert.equal(claude.warnings.some((warning) => warning.includes('ignored')), false, '用户级文件只取顶层 mcpServers')
      } finally {
        await fixture.cleanup()
      }
    },
  )
})

test('import from a source reuses the profile write path and rejects a stale preview', async () => {
  await withSourceEnvironment({ 'codex-home/config.toml': CODEX_TOML }, async () => {
    const fixture = await createProfileFixture('[]\n')
    try {
      const payload = { sourceId: 'codex', scope: 'global', names: ['api', 'files'] }
      const preview = await McpManagerGateway.prototype.previewImportSource.call({ ctx: fixture.ctx }, payload)
      assert.deepEqual(preview.preview.added, ['api', 'files'])
      assert.deepEqual(preview.preview.conflicts, [])
      assert.ok(preview.preview.warnings.some((warning) => warning.includes('COMPANY_TOKEN')), '预览应提示变量缺值')
      assert.equal(JSON.stringify(preview).includes('Bearer'), false, '缺值提示不得带回表达式内容')
      assert.equal(preview.source.label, 'Codex')
      assert.equal(JSON.stringify(preview).includes(SECRET), false, '预览不得包含字面密钥')

      await assert.rejects(
        McpManagerGateway.prototype.importSource.call({ ctx: fixture.ctx }, { ...payload, contentHash: 'stale' }),
        /发生了变化/,
      )
      assert.equal(await readFile(fixture.patchPath, 'utf8'), '[]\n', '指纹不符时不得落盘')

      const result = await McpManagerGateway.prototype.importSource.call(
        { ctx: fixture.ctx },
        { ...payload, mode: 'merge', contentHash: preview.contentHash },
      )
      assert.deepEqual(result.added, ['api', 'files'])
      const written = await readFile(fixture.patchPath, 'utf8')
      assert.match(written, /serverName: api/)
      assert.match(written, /Authorization: !!js .*process\.env\.COMPANY_TOKEN/)
      assert.match(written, new RegExp(`X-Api-Key: ${SECRET}`))
      assert.match(written, /disabled: true/)
      // 提示只跟选中的条目走：tools 的 enabled_tools 提示不应出现在只导 api 的预览里。
      const apiOnly = await McpManagerGateway.prototype.previewImportSource.call(
        { ctx: fixture.ctx },
        { sourceId: 'codex', scope: 'global', names: ['api'] },
      )
      assert.deepEqual(apiOnly.preview.warnings.filter((warning) => warning.includes('enabled_tools')), [])
      const toolsOnly = await McpManagerGateway.prototype.previewImportSource.call(
        { ctx: fixture.ctx },
        { sourceId: 'codex', scope: 'global', names: ['tools'] },
      )
      assert.ok(toolsOnly.preview.warnings.some((warning) => warning.includes('enabled_tools')))
      // 复用既有校验：来源里不可转换的条目（bad）不能被选中导入。
      await assert.rejects(
        McpManagerGateway.prototype.previewImportSource.call({ ctx: fixture.ctx }, { ...payload, names: ['api', 'bad'] }),
        /没有可导入的 MCP/,
      )
      await assert.rejects(
        McpManagerGateway.prototype.previewImportSource.call({ ctx: fixture.ctx }, { ...payload, names: ['nope'] }),
        /来源中没有可导入的 MCP/,
      )
      await assert.rejects(
        McpManagerGateway.prototype.previewImportSource.call({ ctx: fixture.ctx }, { sourceId: 'nope', scope: 'global' }),
        /未知的导入来源/,
      )
    } finally {
      await fixture.cleanup()
    }
  })
})

test('a workspace target imports from the same sources into the project file', async () => {
  await withSourceEnvironment({ 'codex-home/config.toml': CODEX_TOML }, async () => {
    const fixture = await createProfileFixture('[]\n')
    const ws = join(fixture.root, 'repo')
    try {
      await mkdir(join(ws, '.codex'), { recursive: true })
      const wsPath = await realpath(ws)
      fixture.openWorkspace(wsPath)
      await writeFile(join(ws, '.codex', 'config.toml'), `
[mcp_servers.project-local]
command = "npx"
args = ["-y", "server-filesystem", "/data"]

[mcp_servers.project-api]
url = "https://mcp.example.test/proj"
bearer_token_env_var = "PROJ_TOKEN"
`)

      // 项目标签只列该项目的项目级来源：连 `codex-home` 里那份全局配置都不出现。
      const scanned = await McpManagerGateway.prototype.scanImportSources.call({ ctx: fixture.ctx }, { wsPath })
      assert.deepEqual(scanned.sources.map((source) => source.key), ['codex:project'])
      assert.deepEqual(scanned.sources[0].entries.map((entry) => entry.name), ['project-local', 'project-api'])

      const payload = { sourceId: 'codex', scope: 'project', names: ['project-local', 'project-api'], wsPath }
      const preview = await McpManagerGateway.prototype.previewImportSource.call({ ctx: fixture.ctx }, payload)
      assert.deepEqual(preview.preview.added, ['project-local', 'project-api'])

      const result = await McpManagerGateway.prototype.importSource.call(
        { ctx: fixture.ctx },
        { ...payload, mode: 'merge', contentHash: preview.contentHash },
      )
      assert.deepEqual(result.added, ['project-local', 'project-api'])
      const written = JSON.parse(await readFile(join(ws, '.dsh', 'mcp.json'), 'utf8'))
      assert.deepEqual(Object.keys(written.mcpServers), ['project-local', 'project-api'])
      assert.equal(written.mcpServers['project-api'].type, 'http')
      // 项目文件里写的是 `${VAR}` 模板（可逆、与其他工具兼容），不是 `!!js`。
      assert.equal(written.mcpServers['project-api'].headers.Authorization, 'Bearer ${PROJ_TOKEN}')
      assert.deepEqual(written.mcpServers['project-local'].args, ['-y', 'server-filesystem', '/data'])
      assert.equal(await readFile(fixture.patchPath, 'utf8'), '[]\n', '项目目标不得写全局 profile')
    } finally {
      await fixture.cleanup()
    }
  })
})

test('the source layer must match the import target, and the Host enforces it (not just the UI)', async () => {
  await withSourceEnvironment({ 'codex-home/config.toml': CODEX_TOML }, async () => {
    const fixture = await createProfileFixture('[]\n')
    const ws = join(fixture.root, 'repo')
    try {
      await mkdir(ws, { recursive: true })
      const wsPath = await realpath(ws)
      // 项目标签下想导全局来源、全局标签下想导项目来源：两边都拒。UI 不列不等于别人调不到。
      await assert.rejects(
        McpManagerGateway.prototype.previewImportSource.call({ ctx: fixture.ctx }, { sourceId: 'codex', scope: 'global', wsPath }),
        /项目标签只能导入该项目的项目级来源/,
      )
      await assert.rejects(
        McpManagerGateway.prototype.importSource.call({ ctx: fixture.ctx }, { sourceId: 'codex', scope: 'global', wsPath }),
        /项目标签只能导入该项目的项目级来源/,
      )
      await assert.rejects(
        McpManagerGateway.prototype.previewImportSource.call({ ctx: fixture.ctx }, { sourceId: 'codex', scope: 'project' }),
        /全局标签只能导入全局来源/,
      )
      await assert.rejects(
        McpManagerGateway.prototype.previewImportSource.call({ ctx: fixture.ctx }, { sourceId: 'codex', wsPath }),
        /来源层级与导入目标不一致/,
      )
      assert.equal(await readFile(fixture.patchPath, 'utf8'), '[]\n')
    } finally {
      await fixture.cleanup()
    }
  })
})

test('OpenCode (jsonc) and pi are importable through the same RPC path', async () => {
  await withSourceEnvironment(
    {
      'opencode.jsonc': `{
  // OpenCode 的真实配置就长这样：mcp 键、type 判别、command 是数组、{env:} 插值
  "mcp": {
    "oc-local": { "type": "local", "command": ["npx", "-y", "demo-mcp"], "environment": { "TOKEN": "{env:OC_TOKEN}" }, },
    "oc-remote": { "type": "remote", "url": "https://mcp.example.test/oc", "headers": { "Authorization": "Bearer {env:OC_PAT}" } },
  },
}`,
      'pi-agent/mcp.json': JSON.stringify({ mcpServers: { 'pi-docs': { command: 'node', args: ['d.js'], lifecycle: 'lazy' } } }),
    },
    async () => {
      const fixture = await createProfileFixture('[]\n')
      try {
        const scanned = await McpManagerGateway.prototype.scanImportSources.call({ ctx: fixture.ctx }, {})
        const opencode = scanned.sources.find((source) => source.key === 'opencode:global')
        assert.deepEqual(opencode.entries.map((entry) => entry.name), ['oc-local', 'oc-remote'])
        assert.equal(opencode.displayPath.endsWith('opencode.jsonc'), true, '回退到 .jsonc 并报出真读的文件')
        assert.deepEqual(opencode.entries.find((entry) => entry.name === 'oc-remote').missingEnv, ['OC_PAT'])

        const payload = { sourceId: 'opencode', scope: 'global' }
        const preview = await McpManagerGateway.prototype.previewImportSource.call({ ctx: fixture.ctx }, payload)
        assert.deepEqual(preview.preview.added, ['oc-local', 'oc-remote'])
        await McpManagerGateway.prototype.importSource.call(
          { ctx: fixture.ctx },
          { ...payload, mode: 'merge', contentHash: preview.contentHash },
        )
        const written = await readFile(fixture.patchPath, 'utf8')
        assert.match(written, /command: npx/)
        assert.match(written, /args: \[-y, demo-mcp\]/, 'OpenCode 的 command 数组要拆成 command + args')
        assert.match(written, /TOKEN: !!js .*process\.env\.OC_TOKEN/)
        assert.match(written, /Authorization: !!js .*process\.env\.OC_PAT/)

        const piOnly = { sourceId: 'pi', scope: 'global' }
        const piPreview = await McpManagerGateway.prototype.previewImportSource.call({ ctx: fixture.ctx }, piOnly)
        assert.deepEqual(piPreview.preview.added, ['pi-docs'])
        assert.ok(piPreview.preview.warnings.some((warning) => warning.includes('lifecycle')))
      } finally {
        await fixture.cleanup()
      }
    },
    (root) => ({
      OPENCODE_CONFIG: join(root, 'opencode.jsonc'),
      PI_CODING_AGENT_DIR: join(root, 'pi-agent'),
    }),
  )
})

test('a path sent by the client is ignored: the Host only reads its own source table', async () => {
  await withSourceEnvironment({ 'codex-home/config.toml': CODEX_TOML }, async ({ home }) => {
    const fixture = await createProfileFixture('[]\n')
    try {
      // 假装浏览器指定了一个任意文件：Host 必须只认 sourceId + scope。
      const decoy = join(home, '.claude.json')
      await writeFile(decoy, JSON.stringify({ mcpServers: { decoy: { command: 'node' } } }))
      const preview = await McpManagerGateway.prototype.previewImportSource.call(
        { ctx: fixture.ctx },
        { sourceId: 'codex', scope: 'global', path: decoy },
      )
      assert.deepEqual(preview.preview.added, ['api', 'files', 'tools'])
      assert.equal(preview.source.label, 'Codex')
    } finally {
      await fixture.cleanup()
    }
  })
})

test('a source whose file is gone is reported instead of silently importing nothing', async () => {
  await withSourceEnvironment({}, async () => {
    const fixture = await createProfileFixture('[]\n')
    try {
      await assert.rejects(
        McpManagerGateway.prototype.previewImportSource.call({ ctx: fixture.ctx }, { sourceId: 'codex', scope: 'global' }),
        /来源文件不存在/,
      )
      await assert.rejects(
        McpManagerGateway.prototype.importSource.call({ ctx: fixture.ctx }, { sourceId: 'codex', scope: 'global' }),
        /来源文件不存在/,
      )
    } finally {
      await fixture.cleanup()
    }
  })
})

// 两个不同客户端键名归一化成同一个 serverName（`"a"` 与 `" a"`；也等于某条自带 name 字段的
// 条目撞上兄弟键名）。旧的粘贴路径在 normalizeMcpImport 里整批拒绝，来源路径则逐条目调用它、
// 于是那份查重整体失效：profile 会写出两个同 serverName 的 mcp-client 条目（宿主下次加载时
// mcp-client 直接抛，面板自己也读不出配置），项目文件则被对象键静默覆盖、丢条目。
// 现在的规则两条路径一致：**保留先出现的那条、跳过其余、把跳过的名字说清楚**——一条重名不该
// 把同批其余条目挡在门外。
const DUPLICATE_NAMES_JSON = JSON.stringify({
  mcpServers: {
    a: { command: 'node', args: ['first'] },
    ' a': { command: 'node', args: ['second'] },
    ok: { command: 'node' },
  },
})

test('a duplicate serverName is skipped and reported instead of failing the whole import', async () => {
  await withSourceEnvironment({ 'home/.cursor/mcp.json': DUPLICATE_NAMES_JSON }, async () => {
    const fixture = await createProfileFixture('[]\n')
    const ws = join(fixture.root, 'repo')
    try {
      await mkdir(ws, { recursive: true })
      const wsPath = await realpath(ws)
      // 全局：预览就写明跳过了哪条（导之前提示），其余照常导入。
      const payload = { sourceId: 'cursor', scope: 'global' }
      const preview = await McpManagerGateway.prototype.previewImportSource.call({ ctx: fixture.ctx }, payload)
      assert.deepEqual(preview.preview.added, ['a', 'ok'], '重名不该影响同批其余条目')
      assert.deepEqual(preview.preview.conflicts, [])
      assert.ok(preview.preview.warnings.some((warning) => warning.includes('同名条目只保留先出现的那条，已跳过：a')))

      const result = await McpManagerGateway.prototype.importSource.call(
        { ctx: fixture.ctx },
        { ...payload, mode: 'merge', contentHash: preview.contentHash },
      )
      assert.deepEqual(result.added, ['a', 'ok'])
      assert.match(result.note, /跳过 1 条同名条目：a/, '导入结果也要说清楚')
      const written = await readFile(fixture.patchPath, 'utf8')
      assert.equal((written.match(/serverName: a\b/g) || []).length, 1, '落盘不能有两个同 serverName 的条目')
      assert.match(written, /first/, '保留先出现的那条')
      assert.equal(written.includes('second'), false, '被跳过的那条不得落盘')
      // 插件自己读得回来：旧行为写出两个同 serverName 的条目后，这一步会抛
      // 「当前 profile 中存在重复 serverName」，面板的 list/builtins 全都跟着失败。
      assert.deepEqual(readManagedMcpServers(written).servers.map((server) => server.name).sort(), ['a', 'ok'])

      // 粘贴路径走同一条规则（此前是整批拒绝）。
      const pasted = await McpManagerGateway.prototype.importJson.call(
        { ctx: fixture.ctx },
        { mode: 'merge', json: { mcpServers: { p: { command: 'node' }, ' p': { command: 'node' } } } },
      )
      assert.deepEqual(pasted.added, ['p'])
      assert.match(pasted.note, /跳过 1 条同名条目：p/)

      // 项目：同一份内容，同样"跳过 + 提示 + 不重名落盘"（旧行为是静默只留最后一条）。
      await mkdir(join(ws, '.dsh'), { recursive: true })
      await writeFile(join(ws, '.dsh', 'mcp.json'), '{"mcpServers":{}}\n')
      await writeFile(join(ws, '.mcp.json'), DUPLICATE_NAMES_JSON)
      fixture.openWorkspace(wsPath)
      const projectPayload = { sourceId: 'claude-code', scope: 'project', wsPath }
      const projectPreview = await McpManagerGateway.prototype.previewImportSource.call({ ctx: fixture.ctx }, projectPayload)
      assert.ok(projectPreview.preview.warnings.some((warning) => warning.includes('已跳过：a')))
      const projectResult = await McpManagerGateway.prototype.importSource.call(
        { ctx: fixture.ctx },
        { ...projectPayload, mode: 'merge', contentHash: projectPreview.contentHash },
      )
      assert.deepEqual(projectResult.added, ['a', 'ok'])
      const projectFile = JSON.parse(await readFile(join(ws, '.dsh', 'mcp.json'), 'utf8'))
      assert.deepEqual(Object.keys(projectFile.mcpServers), ['a', 'ok'])
      assert.deepEqual(projectFile.mcpServers.a.args, ['first'])
    } finally {
      await fixture.cleanup()
    }
  })
})

test('a source that already contains a bare !!js expression cannot smuggle it into the profile', async () => {
  // 这正是 P0 的形状：裸引用在变量缺失时求值为 undefined，而 mcp-client 的 Config 只接受字符串。
  // 修复只覆盖了"由 `${VAR}` 生成"的那一侧；来源文件里现成的 `!!js` 值必须同样归一成总值形式。
  const toml = `[mcp_servers.legacy]
url = "https://mcp.example.test/mcp"
http_headers = { Authorization = "!!js process.env.DSH_BOOT_TOKEN" }
`
  await withSourceEnvironment({ 'codex-home/config.toml': toml }, async () => {
    const fixture = await createProfileFixture('[]\n')
    try {
      const payload = { sourceId: 'codex', scope: 'global', names: ['legacy'] }
      const preview = await McpManagerGateway.prototype.previewImportSource.call({ ctx: fixture.ctx }, payload)
      const result = await McpManagerGateway.prototype.importSource.call(
        { ctx: fixture.ctx },
        { ...payload, mode: 'merge', contentHash: preview.contentHash },
      )
      assert.deepEqual(result.added, ['legacy'])
      const written = await readFile(fixture.patchPath, 'utf8')
      assert.match(written, /Authorization: !!js \(process\.env\.DSH_BOOT_TOKEN \?\? ""\)/)
      assert.equal(/!!js process\.env\./.test(written), false, '不得留下裸引用')
      // 预览里"会得到空值"这句现在与落盘形式一致（写下去的就是带 `?? ""` 的值）。
      assert.ok(preview.preview.warnings.some((warning) => warning.includes('DSH_BOOT_TOKEN')))
    } finally {
      await fixture.cleanup()
    }
  })
})

test('replace reports exactly what it deletes, in both layers', async () => {
  await withSourceEnvironment(
    {
      'codex-home/config.toml': '[mcp_servers.fresh]\ncommand = "node"\n',
      'repo/.pi/mcp.json': JSON.stringify({ mcpServers: { fresh: { command: 'node' } } }),
      'repo/.dsh/mcp.json': JSON.stringify({ mcpServers: { keepme: { command: 'node' }, obsolete: { command: 'node' } } }),
    },
    async ({ root }) => {
      const managed = [
        '- insert:',
        '    - id: mcp-old',
        "      name: '@deepseek-ai/dsh-mcp-client'",
        '      config: { serverName: old, transport: stdio, command: node }',
        '    - id: mcp-keep',
        "      name: '@deepseek-ai/dsh-mcp-client'",
        '      config: { serverName: keep, transport: stdio, command: node }',
        '',
      ].join('\n')
      const fixture = await createProfileFixture(managed)
      const ws = join(root, 'repo')
      try {
        const wsPath = await realpath(ws)
        fixture.openWorkspace(wsPath)
        // 全局：替换会删掉未出现在来源里的 keep（old 不在来源里，也会没）。
        const globalPayload = { sourceId: 'codex', scope: 'global', mode: 'replace' }
        const globalPreview = await McpManagerGateway.prototype.previewImportSource.call({ ctx: fixture.ctx }, globalPayload)
        assert.deepEqual(globalPreview.preview.removed, ['old', 'keep'])
        const globalResult = await McpManagerGateway.prototype.importSource.call(
          { ctx: fixture.ctx },
          { ...globalPayload, contentHash: globalPreview.contentHash },
        )
        assert.deepEqual(globalResult.removed, ['old', 'keep'])
        const patch = await readFile(fixture.patchPath, 'utf8')
        assert.equal(patch.includes('serverName: old'), false)
        assert.equal(patch.includes('serverName: keep'), false)
        assert.match(patch, /serverName: fresh/)

        // 项目：预览与结果都必须说出真正被删的条目（旧实现恒报"移除：无"却在真删）。
        const projectPayload = { sourceId: 'pi', scope: 'project', wsPath, mode: 'replace' }
        const projectPreview = await McpManagerGateway.prototype.previewImportSource.call({ ctx: fixture.ctx }, projectPayload)
        assert.deepEqual(projectPreview.preview.removed, ['keepme', 'obsolete'])
        const projectResult = await McpManagerGateway.prototype.importSource.call(
          { ctx: fixture.ctx },
          { ...projectPayload, contentHash: projectPreview.contentHash },
        )
        assert.deepEqual(projectResult.removed, ['keepme', 'obsolete'])
        assert.deepEqual(Object.keys(JSON.parse(await readFile(join(ws, '.dsh', 'mcp.json'), 'utf8')).mcpServers), ['fresh'])
        assert.equal(await readFile(fixture.patchPath, 'utf8'), patch, '项目目标不得再动全局 profile')
      } finally {
        await fixture.cleanup()
      }
    },
  )
})

test('a source import without the preview fingerprint is rejected', async () => {
  await withSourceEnvironment({ 'codex-home/config.toml': '[mcp_servers.a]\ncommand = "node"\n' }, async () => {
    const fixture = await createProfileFixture('[]\n')
    try {
      for (const contentHash of [undefined, null, '', 0]) {
        await assert.rejects(
          McpManagerGateway.prototype.importSource.call({ ctx: fixture.ctx }, { sourceId: 'codex', scope: 'global', contentHash }),
          /缺少来源内容指纹/,
        )
      }
      assert.equal(await readFile(fixture.patchPath, 'utf8'), '[]\n')
    } finally {
      await fixture.cleanup()
    }
  })
})
