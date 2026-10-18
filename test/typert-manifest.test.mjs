import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { validateTypertManifest } from '@deepseek-ai/dsh-typert-loader'
import { remoteMethods } from '@deepseek-ai/dsh-typert-protocol'
import { TYPERT } from '../lib/typert.js'
import { SkillsManagerGateway } from '../lib/index.js'

// 为什么单独有这条用例：`lib/typert.js` 是**宿主 loader 的输入**，它的形状由宿主校验，不由我们
// 校验。既有用例只保证 `lib/typert.js` 与 `lib/client.js` 两份产物彼此一致
// （client-lifecycle.test.mjs），宿主改了要求（例如 master 上 strict codec 从 `schema:`
// 改成 `create()`）不会让任何用例变红——后果却是用户升级 DSH 后面板整个不可用。
// 所以这里**用宿主自己的校验器验自己的产物**：形状要求一变，这里就红。
//
// `@deepseek-ai/dsh-typert-loader` 是 dev-only 依赖，不进 peer 列表：校验发生在宿主进程里，
// 插件运行时不 import 它。
test('lib/typert.js passes the host loader own validator', () => {
  // 校验器是公开导出（不是私有字段）。它若改名或搬走，本用例会以导入期错误失败——那表示
  // “去核对宿主新的校验面”，不一定表示插件坏了。
  assert.equal(typeof validateTypertManifest, 'function')
  const packageName = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).name
  // 直接调用而不包 doesNotThrow：失败时抛出的就是宿主校验器自己的诊断
  // （例如 `invocation "..." result codec has no create() factory`）。
  validateTypertManifest(packageName, TYPERT)
})

// 为什么还要额外钉一条：本地 devDependency 的 loader 是**开发基线**，而它只校验两个渠道里
// 的**一个**键，看不见另一个——上面那条用例因此在基线 loader 上永远盖不住缺口：
//   · 基线 ≤ 0.1.5-rc.x：只校验 `schema`，看不见 `create()`（2026-09-21 就是这样红的）
//   · 基线 ≥ 0.1.6-alpha.2（含现在的 0.1.7-rc.2）：只校验 `create()`，看不见 `schema`——
//     而 `schema` 正是 0.1.5-rc.x 那条线（peer 范围仍允许，见下）要的。所以 bump 基线
//     反而把「缺 `schema`」换成了本地测不出的那一半。
// 这里把「strict codec 同时带 schema 与 create()」这条双渠道契约直接钉住：不依赖装了哪个
// 版本的 loader，也不等 CI。取舍理由见 docs/design.md「版本范围怎么定」。
test('the typed contract covers every skill method that the gateway declares Remote', async () => {
  // 契约与实现**必须是同一组方法**，而且这条要由机器推导、不能靠人手抄一份清单：
  // 手抄的清单会在「新增一个 @Remote 方法却忘了补 TYPERT」时保持绿色，而真实后果是
  // 客户端调不通那个方法（wire 上没有它的 descriptor）——正是最晚才发现的那类缺陷。
  //
  // remoteMethods() 读的是类原型上由 @Remote 写入的标记（dsh-typert-protocol）。
  // ⚠️ 它要的是**活实例**，不是 prototype：标记由类的静态初始化块安装，原型上取不到
  // （实测 `remoteMethods(SkillsManagerGateway.prototype)` 返回空数组，会静默把这条用例
  // 变成「两边都是空数组 → 通过」的假绿）。所以这里用真 cordis Context 起一个实例。
  const { Context } = await import('@deepseek-ai/cordis')
  const ctx = new Context()
  await ctx.plugin({
    name: 'skills-stub',
    apply(inner) {
      inner.provide('skills', { async list() { return [] }, async get() { return undefined } })
    },
  })
  await ctx.plugin(SkillsManagerGateway, {})
  const instance = ctx.get('skillsManager')
  assert.notEqual(instance, undefined, 'skillsManager 应已激活')

  const declared = remoteMethods(instance)
    .map((marker) => marker.exportName ?? marker.method)
    .sort()

  // 契约里的 skills 条目：namespace 为 skillsManager（MCP 那些的 namespace 是 mcpManager）。
  const contracted = TYPERT.invocations
    .filter((invocation) => invocation.namespace === 'skillsManager')
    .map((invocation) => invocation.method)
    .sort()

  assert.ok(declared.length > 0, 'gateway 上应至少有若干 @Remote 方法（空数组说明取标记的方式错了）')
  assert.deepEqual(contracted, declared,
    `契约与实现不一致：实现标了 ${JSON.stringify(declared)}，契约登记了 ${JSON.stringify(contracted)}`)
})

test('reading Remote markers from a prototype yields nothing, so the contract test must use an instance', () => {
  // 这条记录一个**真实踩过的假绿**：remoteMethods() 要活实例，原型上返回空数组。
  // 若契约用例写成「原型 vs 契约」且两侧都为空，它会以 deepEqual([], []) 通过——
  // 看起来在守「契约覆盖实现」，其实什么都没守。这里把这个行为钉住，让后来改回原型的人
  // 立刻看到原因，而不是拿到一条永远绿的用例。
  assert.deepEqual(remoteMethods(SkillsManagerGateway.prototype), [],
    '原型上取不到 Remote 标记（标记由静态初始化块装在实例路径上），故契约用例必须用实例')
})

test('every skills invocation is namespaced, correctly identified and self-consistent', () => {
  const skills = TYPERT.invocations.filter((invocation) => invocation.namespace === 'skillsManager')
  assert.ok(skills.length > 0, 'skills 的方法应登记进 TYPERT')
  // MCP 的条目一个都不能少（加 skills 不该挤掉既有契约）。
  // 数字精确，所以少登记一条依旧会红；这里只跟着真实的 MCP 面走，不是放宽成 >=。
  //
  // ⚠️ 这个数字曾经把「setDeferAll 整个方法没接上」这件事**固化成了正确值**：那次
  // index.js 漏写 @Remote、typert.js 漏登记、client.js 漏 descriptor，三边全缺，
  // 于是 manifest 里恰好还是 34 条，这条断言安之若素。真正该守的是「三边同组」，
  // 已由 package-contract.test.mjs 的「the three contract faces list the same methods
  // in the same order」逐项比对（含顺序）。这里保留精确计数，作为第三道闸：
  // 它回答的是"manifest 里到底有几条"，与那道比对互为冗余。
  const mcp = TYPERT.invocations.filter((invocation) => invocation.namespace === 'mcpManager')
  // 35 → 37（1.8.0 的 C2）：新增 toolSearchSettings / updateToolSearchSettings 两个方法。
  assert.equal(mcp.length, 37, `MCP 的方法数应保持 37，实际 ${mcp.length}`)

  for (const invocation of skills) {
    const where = `skills 调用 ${invocation.method}`
    // service 与 namespace 必须都是 skillsManager：serviceKey 同时是 Cordis 服务键与
    // 默认 wire namespace，两侧不一致客户端就发不到。
    assert.equal(invocation.service, 'skillsManager', `${where}: service 必须是 skillsManager`)
    assert.equal(invocation.namespace, 'skillsManager', `${where}: namespace 必须是 skillsManager`)
    // id 里嵌了 namespace，改名漏一处就会出现 id 与实际 endpoint 不符。
    assert.equal(invocation.id, `dsh-toolbox-ui#skillsManager/${invocation.method}`,
      `${where}: id 必须由 namespace+method 构成`)
    assert.equal(invocation.invocation.kind, 'direct', `${where}: 必须是 direct 调用`)
    assert.equal(typeof invocation.sourceLocation?.file, 'string', `${where}: 缺 sourceLocation.file`)
    assert.equal(typeof invocation.sourceLocation?.line, 'number', `${where}: 缺 sourceLocation.line`)
  }
  // id 全局唯一：两个 namespace 共用一份 invocations，重名会让 registry 去重掉一条。
  const ids = TYPERT.invocations.map((invocation) => invocation.id)
  assert.equal(new Set(ids).size, ids.length, 'TYPERT.invocations 的 id 必须唯一')
})

test('the skills namespace is separate from the MCP namespace in the wire contract', () => {
  // 这条守住「两个服务各自独立」：混用 namespace 会让 MCP 的调用打到 skills 上（或反之）。
  // descriptor 校验只按 endpoint（namespace/method）与 id 去重，所以一个 manifest 天然支持
  // 多 namespace——但也因此，写错 namespace 不会有任何结构性错误，只会静默调错服务。
  const byNamespace = new Map()
  for (const invocation of TYPERT.invocations) {
    byNamespace.set(invocation.namespace, (byNamespace.get(invocation.namespace) ?? 0) + 1)
  }
  assert.deepEqual([...byNamespace.keys()].sort(), ['mcpManager', 'skillsManager'],
    `manifest 应恰好含两个 namespace，实际：${JSON.stringify([...byNamespace.keys()])}`)
  // 每个 endpoint（namespace/method）唯一。
  const endpoints = TYPERT.invocations.map((invocation) => `${invocation.namespace}/${invocation.method}`)
  assert.equal(new Set(endpoints).size, endpoints.length, 'endpoint（namespace/method）必须唯一')
})

test('every strict codec carries both the schema value and the create() factory', () => {
  const codecs = []
  for (const invocation of TYPERT.invocations) {
    if (invocation.invocation.codec !== undefined) codecs.push([invocation.id + ' receiver', invocation.invocation.codec])
    for (const parameter of invocation.parameters) codecs.push([invocation.id + ' parameter ' + parameter.wire, parameter.codec])
    codecs.push([invocation.id + ' result', invocation.result])
  }
  assert.ok(codecs.length > 0)
  for (const [subject, codec] of codecs) {
    assert.equal(codec.mode, 'strict', subject + ' 必须是 strict codec')
    // 0.1.5-rc.x 的 loader/registry 走这条（`latest` 已在 2026-09-24 推进到 0.1.7-rc.2，
    // 但 peer 范围 >=0.1.5-rc.1 <0.2.0 仍允许旧版装上，所以这半边不能省）。
    assert.equal(typeof codec.schema?.parse, 'function', subject + ' 缺少 schema（0.1.5-rc.x 那条线会加载即拒）')
    // 0.1.6-alpha.2 起的 loader/registry 走这条（含当前基线 0.1.7-rc.2 与 `next`）。
    assert.equal(typeof codec.create, 'function', subject + ' 缺少 create() 工厂（0.1.6-alpha.2 起会加载即拒）')
    assert.equal(typeof codec.create().parse, 'function', subject + ' 的 create() 没有返回可用的 schema')
  }
})
