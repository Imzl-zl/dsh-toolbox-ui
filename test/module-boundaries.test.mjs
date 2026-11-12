import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

// R6 第 2 步：`lib/index.js` 里的职责边界。
//
// 2685 行的来历：一个文件同时是 RPC 服务层、profile patch 存储、HMR 锁、连接桥、诊断汇总、
// 更新检查、whats-new。这一组断言钉的是"每件职责只有一个文件在实现"——它们不看行为
//（行为由各自的用例守），只看**实现体到底住在哪个文件**。
//
// 为什么需要它：搬移本身没有行为变化，所以 `npm test` 全绿既可能说明"搬对了"，也可能说明
// "根本没搬"或"搬走又把旧副本留下了"。下面每条都成对：`assert.doesNotMatch(宿主)` +
// `assert.match(新文件)`——少了后一半，删掉实现就能让前一半变绿。

const read = (path) => readFile(new URL(`../${path}`, import.meta.url), 'utf8')

/** 取一个顶层函数体（从 `function name(` 到下一个顶层声明之前），用于判断实现住哪。 */
function functionBody(source, name) {
  const start = source.search(new RegExp(`^(async )?function ${name}\\(`, 'm'))
  if (start < 0) return undefined
  const rest = source.slice(start + 1)
  const next = rest.search(/^(async )?function |^const |^let |^var |^class /m)
  return next < 0 ? rest : rest.slice(0, next)
}

test('index.js 只留装配与 wire 面，业务实现住各自的模块', async () => {
  const host = await read('lib/index.js')

  // ① 更新检查：进程内 24h 缓存 + registry 查询，与 wire 面无关。
  assert.equal(functionBody(host, 'checkForUpdate'), undefined,
    'checkForUpdate 的实现应住在 lib/update-hint.js；留在 index.js 说明它又长回了装配层')
  const updateHint = await read('lib/update-hint.js')
  assert.notEqual(functionBody(updateHint, 'checkForUpdate'), undefined, 'lib/update-hint.js 必须实现 checkForUpdate')
  assert.match(updateHint, /UPDATE_CHECK_INTERVAL_MS/, '更新检查的节流常量必须与实现同住一个文件')

  // ② profile patch 存储：读-改-写 + HMR 锁。这是"唯一真值来源"那一层，与 wire 面无关。
  assert.equal(functionBody(host, 'withPatchWrite'), undefined,
    'withPatchWrite 的实现应住在 lib/patch-store.js')
  assert.equal(functionBody(host, 'managedState'), undefined,
    'managedState 的实现应住在 lib/patch-store.js')
  const patchStore = await read('lib/patch-store.js')
  assert.notEqual(functionBody(patchStore, 'withPatchWrite'), undefined, 'lib/patch-store.js 必须实现 withPatchWrite')
  assert.notEqual(functionBody(patchStore, 'managedState'), undefined, 'lib/patch-store.js 必须实现 managedState')

  // ③ 脱敏与 reveal 求值：一份"哪些字段该遮、遮了之后怎么复原"的规则，只该有一处。
  assert.equal(functionBody(host, 'restoreRedactedSpec'), undefined,
    'restoreRedactedSpec 的实现应住在 lib/mcp-projection.js')
  assert.equal(functionBody(host, 'redactMap'), undefined, 'redactMap 的实现应住在 lib/mcp-projection.js')
  const projection = await read('lib/mcp-projection.js')
  assert.notEqual(functionBody(projection, 'restoreRedactedSpec'), undefined, 'lib/mcp-projection.js 必须实现 restoreRedactedSpec')

  // ④ 反向：装配面必须还在 index.js。少了这一半，"全都搬走"也能让上面几条变绿，
  // 而 index.js 一旦不再导出 gateway，整个插件就没有 wire 面了。
  assert.match(host, /applyRemoteMethods\(this, MCP_METHODS,/, 'index.js 仍是两个 gateway 的装配点')
  assert.match(host, /applyRemoteMethods\(this, SKILL_METHODS,/, 'index.js 仍是两个 gateway 的装配点')
  assert.match(host, /export \{/, 'index.js 仍是包的入口（导出名不许改）')
})

test('搬走的符号仍然从包入口可达（导出名是契约，不是实现细节）', async () => {
  // `lib/index.js` 是 package.json 的 "." 入口，媒体/宿主方直接 import 它的导出。
  // 拆文件时最容易的破坏是"实现搬走了，re-export 忘了写"——那种错误在真宿主里表现为
  // 加载即抛 undefined is not a function，而全量用例可能一条都不红。
  const entry = await import('../lib/index.js')
  for (const name of ['McpManagerGateway', 'SkillsManagerGateway', 'checkForUpdate', 'summarizeWorkspaceRow']) {
    assert.notEqual(entry[name], undefined, `包入口必须仍导出 ${name}`)
  }
  assert.equal(entry.default, entry.McpManagerGateway, 'default 导出必须仍与具名导出是同一个类')
})

test('index.js 的行数上限是搬移式的（不是格式化的）', async () => {
  const host = await read('lib/index.js')
  const lines = host.split('\n').length
  // 这个数字的作用是"别让它再长回去"：R6 第 1 步把 2788 → 2685，第 2 步搬走前导区的
  // 三个职责块之后应当明显更低。不是精确指标，所以给一个宽松阈值——它只用来抓
  // "又把实现写回装配层"这一种形态。
  assert.ok(lines < 2100, `lib/index.js 现在 ${lines} 行：实现应当继续住在各自的模块里`)
})
