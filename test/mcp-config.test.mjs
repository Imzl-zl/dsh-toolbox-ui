import assert from 'node:assert/strict'
import test from 'node:test'
import * as mcpConfig from '../lib/mcp-config.js'
import {
  normalizeMcpImport,
  readManagedMcpServers,
  setManagedMcpDisabled,
  updateManagedMcpPatch,
} from '../lib/mcp-config.js'

test('normalizes Claude and Cursor JSON server maps into DSH config', () => {
  const result = normalizeMcpImport({
    mcpServers: {
      local: {
        command: 'npx',
        args: ['-y', 'example-mcp'],
        cwd: 'C:\\tools',
        env: { API_KEY: '${API_KEY}' },
      },
      remote: {
        type: 'http',
        url: 'https://example.test/mcp',
        headers: { Authorization: 'Bearer ${env:TOKEN}' },
      },
    },
  })

  assert.deepEqual(result.servers, [
    {
      name: 'local',
      transport: 'stdio',
      command: 'npx',
      args: ['-y', 'example-mcp'],
      cwd: 'C:\\tools',
      env: { API_KEY: '!!js (process.env.API_KEY ?? "")' },
    },
    {
      name: 'remote',
      transport: 'streamable-http',
      url: 'https://example.test/mcp',
      headers: { Authorization: '!!js "Bearer " + (process.env.TOKEN ?? "")' },
    },
  ])
  assert.deepEqual(result.warnings, [])
})

test('escapes literal text around environment interpolation without enabling arbitrary JS', () => {
  const result = normalizeMcpImport({
    mcpServers: {
      local: { command: 'node', args: ['C:\\tools\\${TOKEN}\\server.js'] },
    },
  })
  assert.equal(result.servers[0].args[0], '!!js "C:\\\\tools\\\\" + (process.env.TOKEN ?? "") + "\\\\server.js"')
  const legacy = normalizeMcpImport({ mcpServers: { safe: { type: 'http', url: 'https://example.test/mcp', headers: { Authorization: '!!js `Bearer ${process.env.TOKEN}`' } } } })
  assert.equal(legacy.servers[0].headers.Authorization, '!!js "Bearer " + (process.env.TOKEN ?? "")')
  assert.throws(
    () => normalizeMcpImport({ mcpServers: { bad: { command: 'node', env: { X: '!!js globalThis.process.exit()' } } } }),
    /!!js.*只允许.*process\.env/i,
  )
  assert.throws(
    () => normalizeMcpImport({ mcpServers: { bad: { type: 'http', url: 'https://example.test/mcp', headers: { X: 'Bearer ${TOKEN} ${globalThis.process.exit()}' } } } }),
    /不支持的变量表达式/i,
  )
})

test('rejects unsupported template values without echoing the value into the error', () => {
  const secret = 'sk-live-LEAKCHECK-9000'
  // 关键在密钥位于第一个 `${` 之后：旧实现把这一整段切片贴进错误信息，而错误信息会
  // 经 previewImport 回到浏览器；而来源导入读的是用户机器上的文件，用户并没敲过这串值。
  const value = 'Bearer ${globalThis.process.exit()} ' + secret
  assert.throws(
    () => normalizeMcpImport({ mcpServers: { bad: { type: 'http', url: 'https://example.test/mcp', headers: { X: value } } } }),
    (error) => {
      assert.equal(String(error.message).includes(secret), false, '错误信息不得回显配置值')
      return /不支持的变量表达式/.test(String(error.message))
    },
  )
})

test('an imported env reference is always total, so an unset variable cannot break the host boot', () => {
  // 实测过的事故：`!!js process.env.X` 在 X 未设置时求值为 undefined，而 mcp-client 的 Config
  // 只接受字符串——host loader 会因此**整棵插件树加载失败**（`dsh: plugin tree failed to load`）。
  // 导入的引用因此必须带 `?? ""`：变量缺失时退化为空字符串，服务器自己连不上（面板里看得见），
  // 而不是把宿主一起拖下去。
  const result = normalizeMcpImport({
    mcpServers: {
      remote: { type: 'http', url: 'https://example.test/mcp', headers: { Authorization: '${TOKEN}', 'X-Key': '${env:OTHER}' } },
      withFallback: { type: 'http', url: 'https://example.test/mcp', headers: { Authorization: '${TOKEN:-anonymous}' } },
    },
  })
  const remote = result.servers.find((server) => server.name === 'remote')
  assert.deepEqual(remote.headers, {
    Authorization: '!!js (process.env.TOKEN ?? "")',
    'X-Key': '!!js (process.env.OTHER ?? "")',
  })
  assert.equal(
    result.servers.find((server) => server.name === 'withFallback').headers.Authorization,
    '!!js (process.env.TOKEN ?? "anonymous")',
  )
  // 写回项目文件时仍可逆（`?? ""` 与裸引用都还原成 `${TOKEN}`），由 workspace-config 的
  // jsExpressionToTemplate 覆盖。
})

test('maps directTools true and false to enablement while absent preserves existing state', () => {
  const result = normalizeMcpImport({
    mcpServers: {
      enabled: { command: 'node', directTools: true },
      disabled: { command: 'node', directTools: false },
      absent: { command: 'node' },
      explicit: { command: 'node', directTools: true, disabled: true },
    },
  })

  assert.deepEqual(result.servers.map((server) => server.name), ['enabled', 'disabled', 'absent', 'explicit'])
  assert.equal(result.servers.some((server) => Object.hasOwn(server, 'directTools')), false)
  assert.equal(result.servers[0].disabled, false)
  assert.equal(result.servers[1].disabled, true)
  assert.equal(Object.hasOwn(result.servers[2], 'disabled'), false)
  assert.equal(result.servers[3].disabled, true)
  assert.deepEqual(result.warnings, [
    'enabled.directTools: true 已转换为 disabled: false（DSH 始终直接注册 MCP 工具）',
    'disabled.directTools: false 已转换为 disabled: true（DSH 不支持间接工具模式）',
    'explicit.directTools 已忽略；显式 disabled 优先',
  ])
})

test('normalizes VS Code and DSH advanced fields without dropping supported values', () => {
  const result = normalizeMcpImport({
    servers: {
      advanced: {
        type: 'stdio',
        command: 'node',
        args: ['server.js'],
        env: { COUNT: 2, EMPTY: null },
        cwd: '/tmp/server',
        toolCallTimeoutMs: 120000,
        failOnStartupError: true,
        reconnect: { enabled: false, initialDelayMs: 1000, maxDelayMs: 4000, maxAttempts: 3, jitter: true },
        description: 'client-only metadata',
        disabled: true,
      },
    },
  })

  assert.deepEqual(result.servers[0], {
    name: 'advanced',
    transport: 'stdio',
    command: 'node',
    args: ['server.js'],
    env: { COUNT: '2', EMPTY: '' },
    cwd: '/tmp/server',
    toolCallTimeoutMs: 120000,
    failOnStartupError: true,
    reconnect: { enabled: false, initialDelayMs: 1000, maxDelayMs: 4000, maxAttempts: 3 },
    disabled: true,
  })
  assert.ok(result.warnings.some((warning) => warning.includes('EMPTY')))
  assert.ok(result.warnings.some((warning) => warning.includes('description')))
  assert.ok(result.warnings.some((warning) => warning.includes('reconnect.jitter')))
})

test('rejects transports and fields DSH cannot represent', () => {
  assert.throws(
    () => normalizeMcpImport({ mcpServers: { legacy: { type: 'sse', url: 'https://example.test/sse' } } }),
    /sse.*不受/i,
  )
  assert.throws(
    () => normalizeMcpImport({ mcpServers: { broken: { command: 'node', envFile: '.env' } } }),
    /envFile.*不支持/i,
  )
  assert.throws(
    () => normalizeMcpImport({ inputs: [{ id: 'token' }], servers: { remote: { type: 'http', url: 'https://example.test/mcp', headers: { Authorization: 'Bearer ${input:token}' } } } }),
    /inputs.*不支持/i,
  )
  assert.throws(
    () => normalizeMcpImport({ mcpServers: { local: { command: 'node', cwd: '${workspaceFolder}' } } }),
    /workspaceFolder.*不支持/i,
  )
  for (const url of ['http://', 'https:// ', 'https://?token=x', 'ftp://example.test/mcp']) {
    assert.throws(
      () => normalizeMcpImport({ mcpServers: { remote: { type: 'http', url } } }),
      /HTTP.*URL|http\(s\)/i,
    )
  }
  assert.throws(
    () => normalizeMcpImport({ mcpServers: {}, servers: {} }),
    /同时包含.*mcpServers.*servers/i,
  )
})

test('entrySpec 必须读回 defer：盘上的延迟开关不能在被管理的行上丢失', () => {
  // 这个 bug 是真浏览器测试抓到的：patch 里写着 defer:true，面板详情行却显示
  // 「关闭（工具全量常驻上下文）」，「全部开启延迟」按钮也判定为未开启。
  // 根因是 entrySpec 只读 MANAGED_CONFIG_FIELDS 那一组，漏了 PLUGIN_OWN_CONFIG_FIELDS，
  // 于是 summarize() 的 `raw = managed || live` 落在没有 defer 的 managed 上。
  // 只读侧漏字段、写侧一直在用，所以功能碰巧对、只有状态显示是反的——最难发现的一类。
  const patch = `- insert:\n    - id: mcp-serena\n      name: '@deepseek-ai/dsh-mcp-client'\n      config:\n        transport: stdio\n        serverName: serena\n        command: serena\n        args: [ 'start-mcp-server' ]\n        defer: true\n`
  const parsed = readManagedMcpServers(patch)
  assert.equal(parsed.servers.length, 1)
  assert.equal(parsed.servers[0].defer, true, 'defer:true 必须被读回（否则面板显示与真实状态相反）')

  // defer:false 也要读回：省略与显式 false 是不同状态，不能都变成 undefined。
  const explicitFalse = patch.replace('defer: true', 'defer: false')
  assert.equal(readManagedMcpServers(explicitFalse).servers[0].defer, false, 'defer:false 同样要读回')

  // 没写 defer 的条目仍应是 undefined（缺省语义由配置桥决定，不能凭空造个 false）。
  const absent = patch.replace('        defer: true\n', '')
  assert.equal(readManagedMcpServers(absent).servers[0].defer, undefined, '没写 defer 时不得凭空造值')
})

test('managed 字段清单 round-trip：每个 MANAGED 字段写进 patch 再读回必须相等', () => {
  // F2 治的是"读写两份清单漂移"。曾经的形状是**一份常量 + 四处手抄**，漂移实验证明：
  // 往常量里加一个 futureField，712 个用例全绿，而 round-trip 实测"写出 v1、读回
  // undefined"——静默丢失、零测试覆盖。这条表驱动用例就是那道闸：它遍历常量本身，
  // 于是任何人往清单里加字段而忘了读侧（或写侧），这里立刻红。
  const input = {
    mcpServers: {
      stdioOne: {
        command: 'node',
        args: ['server.js', '--flag'],
        env: { TOKEN: '${TOKEN}' },
        cwd: '/tmp/server',
        toolCallTimeoutMs: 120000,
        failOnStartupError: true,
        reconnect: { enabled: false, initialDelayMs: 1000, maxDelayMs: 4000, maxAttempts: 3 },
        defer: true,
      },
      httpOne: {
        url: 'https://example.test/mcp',
        headers: { Authorization: 'Bearer ${TOKEN}' },
        toolCallTimeoutMs: 30000,
        defer: false,
      },
    },
  }
  // 期望值全部取自生产路径（normalizeMcpImport 的真实产出），不在测试里重抄常量。
  const specs = normalizeMcpImport(input).servers
  const written = updateManagedMcpPatch('[]\n', specs)
  const readBack = new Map(readManagedMcpServers(written).servers.map((server) => [server.name, server]))
  assert.deepEqual([...readBack.keys()], ['stdioOne', 'httpOne'])

  for (const spec of specs) {
    for (const field of [...mcpConfig.MANAGED_CONFIG_FIELDS, ...mcpConfig.PLUGIN_OWN_CONFIG_FIELDS]) {
      if (spec[field] === undefined) continue
      assert.deepEqual(readBack.get(spec.name)[field], spec[field], `${spec.name}.${field} 必须 round-trip（读回与写入相等）`)
    }
  }
})

test('preserves unrelated patch entries and JS expressions during managed replacement', () => {
  const original = `# keep this comment\n- insert:\n    - id: other-plugin\n      name: other-plugin\n- insert:\n    - id: mcp-old\n      name: '@deepseek-ai/dsh-mcp-client'\n      config:\n        transport: stdio\n        serverName: old\n        command: node\n        env:\n          TOKEN: !!js process.env.OLD_TOKEN\n`
  const parsed = readManagedMcpServers(original)
  assert.equal(parsed.entryIds.old, 'mcp-old')
  assert.deepEqual(parsed.servers, [{
    name: 'old',
    transport: 'stdio',
    command: 'node',
    env: { TOKEN: '!!js process.env.OLD_TOKEN' },
  }])

  const replaced = updateManagedMcpPatch(original, [{
    name: 'new',
    transport: 'streamable-http',
    url: 'https://example.test/mcp',
    headers: { Authorization: 'Bearer token' },
  }], { replace: true })
  assert.match(replaced, /# keep this comment/)
  assert.match(replaced, /id: other-plugin/)
  assert.doesNotMatch(replaced, /serverName: old/)
  assert.match(replaced, /serverName: new/)
})

test('batch defer toggle rewrites every managed entry and keeps other fields', () => {
  // 一键「全部延迟」的服务端底座：一次给多个 specs，每个条目各自的 defer 都要写对，
  // 且注释、未知字段、非 defer 配置都不能丢（updateEntry 是重建 config 节点的）。
  const original = `- insert:\n    - id: mcp-one\n      name: '@deepseek-ai/dsh-mcp-client'\n      # keep managed comment\n      futureOption: keep-me\n      config:\n        transport: stdio\n        serverName: one\n        command: node\n        args: ['-e', '']\n        futureConfig: keep-config\n    - id: mcp-two\n      name: '@deepseek-ai/dsh-mcp-client'\n      config:\n        transport: stdio\n        serverName: two\n        command: node\n`
  const specs = [
    { name: 'one', transport: 'stdio', command: 'node', args: ['-e', ''], defer: true },
    { name: 'two', transport: 'stdio', command: 'node', defer: true },
  ]
  const on = updateManagedMcpPatch(original, specs)
  assert.match(on, /id: mcp-one/)
  assert.match(on, /id: mcp-two/)
  assert.match(on, /# keep managed comment/)
  assert.match(on, /futureOption: keep-me/)
  assert.match(on, /futureConfig: keep-config/)
  assert.match(on, /command: node/)
  assert.match(on, /args:\n\s+- -e\n/)
  // 两个条目都写上 defer: true。
  assert.equal((on.match(/defer: true/g) || []).length, 2)

  // 反向：全部关掉时不留 true 残影。
  const off = updateManagedMcpPatch(on, [
    { name: 'one', transport: 'stdio', command: 'node', args: ['-e', ''], defer: false },
    { name: 'two', transport: 'stdio', command: 'node', defer: false },
  ])
  assert.doesNotMatch(off, /defer: true/)
  assert.equal((off.match(/defer: false/g) || []).length, 2)
  assert.match(off, /futureConfig: keep-config/, '关掉时同样不能丢字段')
})

test('toggles disabled in place without dropping comments or future fields', () => {
  const original = `- insert:\n    - id: mcp-one\n      name: '@deepseek-ai/dsh-mcp-client'\n      # keep managed comment\n      futureOption: keep-me\n      config:\n        transport: stdio\n        serverName: one\n        command: node\n`
  const disabled = setManagedMcpDisabled(original, 'one', true)
  assert.match(disabled, /# keep managed comment/)
  assert.match(disabled, /futureOption: keep-me/)
  assert.match(disabled, /disabled: true/)
  const enabled = setManagedMcpDisabled(disabled, 'one', false)
  assert.doesNotMatch(enabled, /disabled: true/)
  assert.match(enabled, /futureOption: keep-me/)
})

test('preserves entry identity, comments, and future fields when updating one managed MCP', () => {
  const original = `- insert:\n    - id: custom-one\n      name: '@deepseek-ai/dsh-mcp-client'\n      # keep managed comment\n      futureOption: keep-me\n      config:\n        transport: stdio\n        serverName: one\n        command: node\n        futureConfig: keep-config\n`

  const next = updateManagedMcpPatch(original, [{
    name: 'one',
    transport: 'streamable-http',
    url: 'https://example.test/mcp',
  }])

  assert.match(next, /id: custom-one/)
  assert.match(next, /# keep managed comment/)
  assert.match(next, /futureOption: keep-me/)
  assert.match(next, /futureConfig: keep-config/)
  assert.match(next, /transport: streamable-http/)
  assert.match(next, /url: https:\/\/example\.test\/mcp/)
  assert.doesNotMatch(next, /command: node/)
})

test('rejects duplicate managed server names in one profile patch', () => {
  const duplicate = `- insert:\n    - id: mcp-one-a\n      name: '@deepseek-ai/dsh-mcp-client'\n      config:\n        transport: stdio\n        serverName: one\n        command: node\n    - id: mcp-one-b\n      name: '@deepseek-ai/dsh-mcp-client'\n      config:\n        transport: stdio\n        serverName: one\n        command: other\n`
  assert.throws(() => readManagedMcpServers(duplicate), /重复.*serverName.*one/i)
})

test('tracks prototype-shaped server names as ordinary managed entry ids', () => {
  const parsed = readManagedMcpServers(`- insert:\n    - id: mcp-__proto__\n      name: '@deepseek-ai/dsh-mcp-client'\n      config:\n        transport: stdio\n        serverName: __proto__\n        command: node\n`)

  assert.equal(Object.hasOwn(parsed.entryIds, '__proto__'), true)
  assert.equal(parsed.entryIds.__proto__, 'mcp-__proto__')
})

test('preserves prototype-shaped env and header keys as ordinary map entries', () => {
  const input = JSON.parse('{"mcpServers":{"local":{"command":"node","env":{"__proto__":"env-value"}},"remote":{"type":"http","url":"https://example.test/mcp","headers":{"__proto__":"header-value"}}}}')
  const result = normalizeMcpImport(input)

  assert.equal(Object.hasOwn(result.servers[0].env, '__proto__'), true)
  assert.equal(result.servers[0].env.__proto__, 'env-value')
  assert.equal(Object.hasOwn(result.servers[1].headers, '__proto__'), true)
  assert.equal(result.servers[1].headers.__proto__, 'header-value')

  const parsed = readManagedMcpServers(`- insert:\n    - id: mcp-local\n      name: '@deepseek-ai/dsh-mcp-client'\n      config:\n        transport: stdio\n        serverName: local\n        command: node\n        env:\n          __proto__: env-value\n`)
  assert.equal(Object.hasOwn(parsed.servers[0].env, '__proto__'), true)
})

test('accepts positive finite reconnect delays supported by the current DSH MCP client', () => {
  const result = normalizeMcpImport({
    mcpServers: {
      local: { command: 'node', reconnect: { initialDelayMs: 500.5, maxDelayMs: 1000.5, maxAttempts: 3 } },
    },
  })
  assert.deepEqual(result.servers[0].reconnect, { initialDelayMs: 500.5, maxDelayMs: 1000.5, maxAttempts: 3 })
})

test('rejects reconnect settings that the installed DSH MCP client rejects', () => {
  assert.throws(
    () => normalizeMcpImport({ mcpServers: { bad: { command: 'node', reconnect: { initialDelayMs: 5000, maxDelayMs: 1000 } } } }),
    /initialDelayMs.*maxDelayMs/i,
  )
  assert.throws(
    () => normalizeMcpImport({ mcpServers: { bad: { command: 'node', reconnect: { initialDelayMs: 2147483648 } } } }),
    /2147483647/,
  )
})

test('generates a unique loader entry id when another plugin already owns the default id', () => {
  const original = `- insert:\n    - id: mcp-new\n      name: other-plugin\n`
  const next = updateManagedMcpPatch(original, [{ name: 'new', transport: 'stdio', command: 'node' }])
  assert.equal((next.match(/id: mcp-new(?:\n|-2\n)/g) || []).length, 2)
  assert.match(next, /id: mcp-new-2/)
  assert.match(next, /serverName: new/)
})

test('removes selected managed MCP entries without touching other managed entries', () => {
  const original = `- insert:\n    - id: mcp-one\n      name: '@deepseek-ai/dsh-mcp-client'\n      config:\n        transport: stdio\n        serverName: one\n        command: node\n    - id: mcp-two\n      name: '@deepseek-ai/dsh-mcp-client'\n      config:\n        transport: stdio\n        serverName: two\n        command: node\n`

  const next = updateManagedMcpPatch(original, [], { removeNames: ['one'] })
  assert.doesNotMatch(next, /serverName: one/)
  assert.match(next, /serverName: two/)
})

test('builtin catalog stays installable: keyless endpoints and unattended commands', () => {
  // 这里不穷举目录内容（那是 lib/mcp-catalog.js 的事，由 test/mcp-catalog.test.mjs 逐条校验）。
  // 这条测试只钉住**投影**不丢配置字段：目录条目 → 写进 profile 的 spec，字段必须一致。
  // 以前它把 5 条清单整个写死，目录扩到 43 条后就成了维护负担，而它真正想守的东西
  // （装上去能连、命令能无人值守跑起来）在数据里反而看不出来。
  const byId = new Map(mcpConfig.BUILTIN_MCP_SERVERS.map((server) => [server.id, server]))
  for (const builtin of mcpConfig.BUILTIN_MCP_SERVERS) {
    assert.ok(builtin.label, `${builtin.id}: 缺 label`);
    assert.ok(builtin.summary, `${builtin.id}: 缺 summary`);
    assert.ok(builtin.access, `${builtin.id}: 缺 access（用户靠它判断要不要 Key）`);
    assert.equal(builtin.name, builtin.id, `${builtin.id}: name 必须等于 id`);
    if (builtin.transport === 'streamable-http') {
      assert.match(builtin.url, /^https:\/\//, `${builtin.id}: HTTP 型必须走 https`);
      assert.equal(builtin.command, undefined, `${builtin.id}: HTTP 型不该带 command`);
    } else {
      assert.equal(builtin.transport, 'stdio', `${builtin.id}: 未知传输`);
      assert.ok(builtin.command, `${builtin.id}: stdio 型必须有 command`);
      // 目录里的 npm 调用一律带 -y：不带的话 npx 会停下来等确认，而 MCP 子进程没有 TTY，
      // 表现是「连接超时」而不是报错。这是本目录最容易踩的静默失败。
      if (builtin.command === 'npx') {
        assert.ok(builtin.args.includes('-y'), `${builtin.id}: npx 必须带 -y，否则等确认卡死`);
      }
    }
  }
  // 抽查两条最有代表性的：免密 HTTP 与无人值守浏览器命令。
  assert.match(byId.get('exa').url, /^https:\/\/mcp\.exa\.ai\/mcp$/);
  assert.deepEqual(byId.get('chrome-devtools').args, ['-y', 'chrome-devtools-mcp@latest']);
})

test('selected builtin installation appends only missing identities and never rewrites existing entries', () => {
  const original = `# user comment\n- insert:\n    - id: user-exa\n      name: '@deepseek-ai/dsh-mcp-client'\n      config:\n        serverName: private-search\n        transport: streamable-http\n        url: https://mcp.exa.ai/mcp?tools=web_search_exa\n        headers:\n          x-api-key: !!js process.env.EXA_API_KEY\n`
  const effective = [
    ...readManagedMcpServers(original).servers,
    { name: 'tavily-custom', transport: 'stdio', command: 'npx', args: ['-y', 'mcp-remote', 'https://mcp.tavily.com/mcp/?tavilyApiKey=user-key'] },
    { name: 'crawler', transport: 'stdio', command: 'npx', args: ['-y', 'firecrawl-mcp@3.23.7'] },
    { name: 'devtools-custom', transport: 'stdio', command: 'npx', args: ['-y', 'chrome-devtools-mcp@latest'] },
  ]

  const result = mcpConfig.appendSelectedBuiltinMcpServers(
    original,
    effective,
    ['exa', 'tavily', 'firecrawl', 'chrome-devtools', 'playwright'],
    { reservedIds: ['mcp-playwright'] },
  )
  const parsed = readManagedMcpServers(result.content)

  assert.deepEqual(result.added, ['playwright'])
  assert.deepEqual(result.skipped, ['exa', 'tavily', 'firecrawl', 'chrome-devtools'])
  assert.deepEqual(parsed.servers.map((server) => server.name), ['private-search', 'playwright'])
  assert.equal(parsed.entryIds.playwright, 'mcp-playwright-2')
  assert.match(result.content, /# user comment/)
  assert.match(result.content, /x-api-key: !!js process\.env\.EXA_API_KEY/)
  assert.doesNotMatch(result.content, /builtin-seed/)
})

test('a removed builtin is reinstalled only after the user selects it again', () => {
  const first = mcpConfig.appendSelectedBuiltinMcpServers('[]\n', [], ['firecrawl'])
  assert.deepEqual(first.added, ['firecrawl'])

  const withoutFirecrawl = updateManagedMcpPatch(first.content, [], { removeNames: ['firecrawl'] })
  const second = mcpConfig.appendSelectedBuiltinMcpServers(withoutFirecrawl, [], ['firecrawl'])

  assert.deepEqual(second.added, ['firecrawl'])
  assert.equal(readManagedMcpServers(second.content).servers.some((server) => server.name === 'firecrawl'), true)
})

// ── defer 字段（ToolSearch 延迟加载开关，插件自有，同 idleTimeoutMs 待遇） ──

test('normalizeMcpImport: defer 布尔解析、缺省不落键、不触发未知字段警告', () => {
  const { servers, warnings } = normalizeMcpImport({
    mcpServers: {
      jshook: { command: 'npx jshook', defer: true },
      firecrawl: { url: 'https://example.com/mcp', defer: false },
      plain: { command: 'npx plain' },
    },
  })
  assert.equal(servers.find((server) => server.name === 'jshook').defer, true)
  assert.equal(servers.find((server) => server.name === 'firecrawl').defer, false)
  assert.equal('defer' in servers.find((server) => server.name === 'plain'), false)
  assert.equal(warnings.some((warning) => warning.includes('.defer')), false)
})

test('normalizeMcpImport: defer 非布尔抛错', () => {
  assert.throws(
    () => normalizeMcpImport({ mcpServers: { a: { command: 'x', defer: 'yes' } } }),
    /a\.defer 必须是布尔值/,
  )
})
