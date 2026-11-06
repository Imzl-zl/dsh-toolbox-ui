import assert from 'node:assert/strict'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import test from 'node:test'

import { PARTS, PARTS_DIR, renderClient } from '../scripts/build-client.mjs'

// 为什么有这条用例：lib/client.js 是**产物**，源码按职责切在 lib/client/ 的分片里。
// 既有用例全都只读产物，所以「产物与分片分叉」这件事没有任何东西会喊——手改产物改得再对，
// 分片停在旧内容，下一次 `node scripts/build-client.mjs --write` 就会把手改的内容静默回滚；
// 反过来改了分片没重拼，发布物里就少了那段代码。两边都得盯住。
//
// 拼接**复用构建脚本导出的同一个 renderClient()**，这里不另写一份实现：另写一份只会在
// 两边同时改错时一起变绿，等于用第二个错误证明第一个错误没问题。
const source = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8')

/** rpc-contract 生成段的边界（与 scripts/rpc-contract.mjs 同一对标记，缩进在产物里是 4 空格）。 */
const RPC_BEGIN = '// <rpc-contract:begin> 由 scripts/rpc-contract.mjs 生成，勿手改'
const RPC_END = '// <rpc-contract:end>'

/** 字符串里出现了几次。 */
const countOf = (text, needle) => text.split(needle).length - 1

/** 第一处不同的行号（1 基）；完全相同时返回 0。 */
function firstDifferingLine(left, right) {
  const a = left.split('\n')
  const b = right.split('\n')
  for (let index = 0; index < Math.max(a.length, b.length); index += 1) {
    if (a[index] !== b[index]) return index + 1
  }
  return 0
}

/** 单行预览（截断，避免把几千字符的 CSS 行糊进报告）。 */
const preview = (line) => (line === undefined ? '（文件到此结束）' : line.length > 100 ? `${line.slice(0, 100)}…` : line)

test('lib/client.js 就是分片按 PARTS 顺序拼出来的那一份单文件', () => {
  const rendered = renderClient()
  // 不写 assert.equal(source, rendered)：两侧都是 470KB 的文本，失败时 node 会把整份内容
  // 打进报告。先自己判一次，把「第几行、两边各是什么」写清楚。
  const at = source === rendered ? 0 : firstDifferingLine(rendered, source)
  const detail = at === 0
    ? ''
    : `（第一处差异在第 ${at} 行：分片 ${preview(rendered.split('\n')[at - 1])} / 产物 ${preview(source.split('\n')[at - 1])}）`
  assert.ok(source === rendered, `lib/client.js 与分片拼接的结果不一致${detail}`)
})

test('产物仍然只有一个模块壳：window.__ModuleLoader__.load({ … })', () => {
  // 分片是**行区间**，不是独立模块：拼回来必须还是加载器认的那一个壳。多一个 factory
  // 就说明有人把某片写成了独立模块（或者拼接顺序把壳切成了两半）。
  assert.ok(source.startsWith('window.__ModuleLoader__.load({'), '产物必须以模块壳开头（首行 window.__ModuleLoader__.load({）')
  assert.equal(countOf(source, 'window.__ModuleLoader__.load('), 1, '只允许一个模块壳')
  assert.equal(countOf(source, 'factory: (require) =>'), 1, '只允许一个 factory：所有分片共享同一个工厂函数作用域')
  // 壳的结尾也必须在最后：分片按顺序拼接，最后一片负责收尾。
  assert.ok(source.trimEnd().endsWith('});'), '产物必须以模块壳的收尾行结束')
})

test('rpc-contract 生成段在产物里恰好一份，且缩进未被改动', () => {
  // 生成段是 scripts/rpc-contract.mjs 直接写进产物的字节：切分只是搬家，缩进（4 空格）
  // 和内容都不能变——变一个字符 contract:check 就红，且它会指向产物而不是分片。
  assert.equal(countOf(source, `    ${RPC_BEGIN}`), 1, 'rpc-contract 生成段的起始标记必须恰好一份（4 空格缩进）')
  assert.equal(countOf(source, `    ${RPC_END}`), 1, 'rpc-contract 生成段的结束标记必须恰好一份（4 空格缩进）')
  assert.ok(source.indexOf(RPC_BEGIN) < source.indexOf(RPC_END), '起始标记必须在结束标记之前')

  // 而且它只住在**一**个分片里：跨两个分片出现就意味着有一片被切在了生成段中间。
  const holders = PARTS.filter((name) => readFileSync(join(PARTS_DIR, name), 'utf8').includes(RPC_BEGIN))
  assert.equal(holders.length, 1, `rpc-contract 生成段只能出现在一个分片里（实际：${holders.join(', ') || '无'}）`)
})

test('分片目录与 PARTS 一一对应，且每片都自成完整行', () => {
  const onDisk = readdirSync(PARTS_DIR).filter((name) => name.endsWith('.js')).sort()
  // PARTS 之外的 .js 会被静默漏掉（等于写了代码没进产物）；PARTS 里有、磁盘上没有则拼不出来。
  assert.deepEqual(onDisk, [...PARTS].sort(), 'lib/client/ 下的 .js 必须与 PARTS 完全一致')

  let total = 0
  for (const name of PARTS) {
    const text = readFileSync(join(PARTS_DIR, name), 'utf8')
    // 分片边界必须落在行尾：没有末尾换行的分片拼起来会把下一片的第一行接在自己后面。
    assert.ok(text.endsWith('\n'), `分片 ${name} 必须以换行结尾`)
    assert.notEqual(text.trim(), '', `分片 ${name} 不能是空的`)
    total += text.split('\n').length - 1
  }
  assert.equal(total, source.split('\n').length - 1, '分片总行数必须等于产物的行数')
})
