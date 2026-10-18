import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import * as cordis from '@deepseek-ai/cordis'

const { Context } = cordis

// 为什么单独有这条用例：**离线 450 条用例全绿，真机却整页打不开**。
//
// 真实故障（2026-10，包名改为 dsh-toolbox-ui 之后）：
//   Error: web boot: 1 entry did not activate
//     dsh-toolbox-ui: failed
// 根因不在宿主、也不在 MCP 面，而在**客户端** apply() 的第一步
// `ctx.remote.$mount(MCP_CONTRIBUTION)`：宿主客户端适配器校验 descriptor 时会拒绝
// 「与命名空间服务自身成员重名」的方法，而 skills 面正好登记了 `remove` ——
// `RemoteNamespaceService`（dsh-api-gateway 的客户端侧）自己就有原型方法 `remove`
// （卸载某个已在服务上安装的方法），于是校验抛：
//   client api: method "skillsManager/remove" conflicts with its namespace service
// 客户端 apply() 抛错 ⇒ 该 fiber 变 FAILED ⇒ 客户端启动审计 `web boot: N entry did not
// activate` ⇒ 整页停在 "Failed to load plugins"。宿主侧看不见原因：本插件是 optional entry，
// 启动告警的 sink 被有意传成空函数（`auditStartupEntries(ctx, "dsh web", () => {})`），
// 且客户端审计只对「模块导入失败」附带 message，fiber 状态 failed 只报状态名。
//
// 为什么既有用例全都盖不住（这是本条存在的理由）：
//   test/client-lifecycle.test.mjs 与 test/skills-client.test.mjs 用的都是**假 remote**——
//   `{ $mount(value) { contribution = value; return async () => {} } }`。假 $mount 只把
//   contribution 记下来，从不执行宿主自己的准入校验，所以「我们的 descriptor 名字是否被宿主
//   接受」这件事**从来没有被验证过**：产物自洽、两侧一致、宿主 loader 也验过（typert-manifest
//   用真 loader 验的是 **lib/typert.js 那一半**），但客户端那一半无人校验。
//
// 所以这条用例不再伪造 $mount：它把**真实**的 dsh-api-gateway 客户端 bundle 挂进一个真 cordis
// Context，再让**真实**的 lib/client.js 对着它跑 apply()。宿主改了保留名规则、或我们新增了
// 一个撞名的 endpoint，这里都会以宿主自己的诊断变红。
const require = createRequire(import.meta.url)

/**
 * 客户端适配器里那条规则的权威位置（真机 app.asar 中同一份实现）。
 *
 * ⚠️ 必须按 `browser` 条件取件，不能用 `require.resolve('@deepseek-ai/dsh-api-gateway/client')`：
 * 0.2.1 起 `./client` 是条件导出（`node` → `client.node.js`，`browser` → `client.browser.js`），
 * `require.resolve` 在 Node 下命中 `node` 条件，拿到的是 **Node 构建**——那一份不自注册
 * `window.__ModuleLoader__`，`loadBundle` 于是永远等不到注册，用例会以"bundle 没有调用
 * window.__ModuleLoader__.load"这种与被测行为无关的理由红掉。0.2.0 的 `./client` 只有
 * `default`，回落到它即可（那一份就是浏览器 bundle）。
 */
const GATEWAY_PACKAGE = require.resolve('@deepseek-ai/dsh-api-gateway/package.json')
const GATEWAY_EXPORTS = JSON.parse(readFileSync(GATEWAY_PACKAGE, 'utf8')).exports['./client']
const GATEWAY_CLIENT = join(dirname(GATEWAY_PACKAGE), GATEWAY_EXPORTS.browser ?? GATEWAY_EXPORTS.default)

/**
 * 载入一个浏览器 bundle（`window.__ModuleLoader__.load({ id, factory })` 形态）。
 *
 * 客户端 bundle 不是 ESM：模块体唯一的副作用就是调用 `window.__ModuleLoader__.load`。
 * 所以必须先装好 facade 再 import，且每次用不同 query 拿一份新实例（模块缓存会串味）。
 *
 * @param {string} url - 待载入的 bundle 文件 URL。
 * @param {(name: string) => unknown} resolve - bundle 内 `require` 的解析器。
 * @returns {Promise<{ id: string, exports: object, definition: object }>}
 */
async function loadBundle(url, resolve) {
  let definition
  const previous = globalThis.window
  globalThis.window = { __ModuleLoader__: { load(value) { definition = value } } }
  try {
    await import(url)
  } finally {
    globalThis.window = previous
  }
  assert.notEqual(definition, undefined, `bundle 没有调用 window.__ModuleLoader__.load：${url}`)
  return { id: definition.id, definition, exports: definition.factory(resolve) }
}

/** 与 lib/client.js 的 __injectCss 打交道所需的最小 document。 */
function createFakeDocument() {
  const styles = []
  return {
    styles,
    head: { appendChild(node) { styles.push(node) } },
    createElement(tag) {
      assert.equal(tag, 'style')
      return { dataset: {}, textContent: '', remove() { styles.splice(styles.indexOf(this), 1) } }
    },
    querySelector() { return null },
  }
}

/** 真 cordis Context + 真客户端网关；返回挂好 `ctx.remote` 的上下文与清理函数。 */
async function createClientHost(tag) {
  const gateway = await loadBundle(pathToFileURL(GATEWAY_CLIENT).href + '?admission-test-gateway-' + tag, (name) => {
    // bundle 的 require 要的是整个 cordis 命名空间（Service 等），不是单个 Context。
    if (name === '@deepseek-ai/cordis') return cordis
    throw new Error('dsh-api-gateway 客户端 bundle 出现了未预期的 require：' + name)
  })

  const ctx = new Context()
  // 客户端网关在构造期就要 connection 的这五个成员（generation/rpc/isLoopback/
  // registerGenerationSource/start）；这里只顶替传输层，不顶替**校验层**——校验发生在
  // ClientRemote.$mount 内部，正是被测对象。
  ctx.provide('connection', {
    rpc: { open: () => undefined, call: async () => ({ ok: true, value: null }) },
    generation: { getSnapshot: () => ({ host: { home: '/home/u' } }) },
    isLoopback: true,
    registerGenerationSource: () => () => {},
    start: () => ({ stop() {} }),
  })
  ctx.provide('typert', { remotes: { register: () => () => {} } })
  ctx.provide('loader', { await: async () => {} })
  await ctx.plugin(gateway.exports)

  const remote = ctx.get('remote')
  assert.notEqual(remote, undefined, '真网关应提供 ctx.remote（校验入口）')
  assert.equal(typeof remote.$mount, 'function')
  return { ctx, remote, dispose: () => ctx.fiber.dispose() }
}

/** 载入我们真实的 lib/client.js（用真 React 形态的替身，只顶替 DOM 与 react）。 */
async function loadOurClient(tag) {
  const url = new URL('../lib/client.js', import.meta.url).href + '?admission-test-client-' + tag
  return await loadBundle(url, (name) => {
    if (name !== 'react') throw new Error('lib/client.js 出现了未预期的 require：' + name)
    return {
      Fragment: Symbol('Fragment'),
      createElement: (type, props, ...children) => ({ type, props: props ?? {}, children }),
      useCallback: (fn) => fn,
      useEffect: () => {},
      useMemo: (fn) => fn(),
      useRef: (value) => ({ current: value }),
      useState: (value) => [typeof value === 'function' ? value() : value, () => {}],
    }
  })
}

test('the real client gateway admits every descriptor our client bundle mounts', async () => {
  // 这条就是那次真机故障的回归闸：apply() 的第一句是 `await ctx.remote.$mount(...)`，
  // 它一旦抛错，客户端 fiber 就是 FAILED，整页 boot 失败——症状与模块导入失败不同，
  // 但结果一样：面板完全不存在。
  const document = createFakeDocument()
  const previousDocument = globalThis.document
  globalThis.document = document
  const host = await createClientHost('admits')
  const { ctx } = host
  ctx.provide('slots', { inject() {}, register() { return () => {} } })

  try {
    const client = await loadOurClient('admits')
    // 直接传真 ctx：生产里 apply() 拿到的就是注入了 remote 的客户端上下文，
    // 请求路径 `ctx.remote.$mount` / `ctx.get('remote.<namespace>')` 都走真服务。
    const dispose = await client.exports.apply(ctx)
    assert.equal(typeof dispose, 'function', 'apply() 应返回清理函数')

    // 反向下限：真 $mount 确实把两个 namespace 装上了，否则「没抛错」可能只是空跑。
    assert.notEqual(ctx.get('remote.mcpManager'), undefined, 'mcpManager 命名空间应已挂载')
    assert.notEqual(ctx.get('remote.skillsManager'), undefined, 'skillsManager 命名空间应已挂载')
    await dispose()
  } finally {
    globalThis.document = previousDocument
    await host.dispose()
  }
})

test('the gateway rejects an endpoint that collides with its own namespace service', async () => {
  // 为什么还要单独钉一条：上面那条用例只在**我们**的方法名撞车时变红；若哪天网关的校验被
  // 放宽（或这条通路被换掉），它会一直绿而**不再守任何东西**——那是假绿。
  // 这里用一个必然撞名的探针证明「校验确实在跑、确实会拒」，使上面那条的绿色有意义。
  //
  // `remove` 不是随手挑的：它正是本次真机故障的名字——RemoteNamespaceService 的原型上就有
  // `remove(kind, method, token)`（卸载已在服务上安装的方法），所以任何 `@Remote("remove")`
  // 都会在 $mount 阶段被拒。同类保留名还有 ctx/empty/has/install/methods/name/namespace。
  const host = await createClientHost('rejects')
  try {
    const contribution = (method) => ({
      package: 'dsh-admission-probe-' + method,
      descriptors: [{
        id: 'dsh-admission-probe#skillsManager/' + method,
        service: 'skillsManager',
        namespace: 'skillsManager',
        method,
        invocation: { kind: 'direct' },
        parameters: [],
        result: { mode: 'strict', typeSymbol: 'probe/result', parse: (v) => v, schema: { parse: (v) => v }, create: () => ({ parse: (v) => v }) },
      }],
    })

    await assert.rejects(
      () => host.remote.$mount(contribution('remove')),
      /conflicts with its namespace service/,
      '宿主必须拒绝与命名空间服务自身成员重名的 endpoint（本次故障的规则）',
    )
    // 同一形状换个不撞名的名字必须能挂上：证明上一条的拒绝来自**重名**而不是形状非法。
    const dispose = await host.remote.$mount(contribution('removeSkill'))
    assert.equal(typeof dispose, 'function')
    await dispose()
  } finally {
    await host.dispose()
  }
})
