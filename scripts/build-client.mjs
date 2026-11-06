#!/usr/bin/env node
// lib/client.js 的组装器：把 lib/client/ 下的分片按固定顺序拼回**一份**浏览器 bundle。
//
//   node scripts/build-client.mjs --check   # CI：产物与分片不一致就非零退出，并指出第一处差异行
//   node scripts/build-client.mjs --write   # 用分片重写 lib/client.js
//   node scripts/build-client.mjs           # 不带参数 = --check（产物是派生物，静默重写太危险）
//
// 为什么仍然是一份单文件：宿主用 window.__ModuleLoader__ 直接求值这一份，中间没有打包器
// （见 test/client-entry.test.mjs / client-lifecycle.test.mjs / client-wire-shape.test.mjs）。
// 分片只服务于人读代码——**发布物与运行时看到的永远是这一份单文件**，所以拼出来的字节必须
// 与切分前逐字节一致：只切行区间，不重排、不重写、不美化（连注释都原样）。这条不变量由
// test/client-parts.test.mjs 直接断言（它 import 的就是这里的 renderClient）。
//
// 分片契约：
//   · PARTS 是**唯一**的顺序来源（文件名上的数字前缀只是给人看的）；
//   · 每个分片必须以换行结尾、且自成完整行——否则拼回的产物会在分片交界处丢/多一个换行；
//   · 分片之间可以自由互相引用符号：拼回单文件后它们都在同一个工厂函数作用域里。
//
// 与 scripts/rpc-contract.mjs 的分工：descriptor 生成段的**唯一来源**是 lib/rpc-contract.js，
// 而那个脚本只认识产物路径 lib/client.js。所以 --write 在重写产物之前，会先把产物里的生成段
// 搬回持有它的那个分片——否则「跑一次 contract:write、再跑一次 build:client --write」就会把
// 刚生成的方法表静默回滚。只在两者确实不同时才动分片，并明确打印改的是哪一片。
import { readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')

/** 分片目录：每个文件是一段连续的行区间。 */
export const PARTS_DIR = join(ROOT, 'lib', 'client')
/** 产物：宿主实际加载的那份单文件。 */
export const CLIENT_PATH = join(ROOT, 'lib', 'client.js')

/**
 * 分片的拼接顺序（顺序即产物里的行顺序，改文件名时只改这里）。
 *
 * 名字里的数字前缀是给人看的索引，不是排序依据——真正的顺序只有这张表。
 */
export const PARTS = [
  '00-boot.js',            // 模块壳 + __injectCss + React hooks
  '10-theme-css.js',       // 主题令牌 + MCP_CSS + SKILLS_CSS + h()
  '20-locale.js',          // 中英词典 + t() / localized()
  '30-skill-model.js',     // 技能面的纯逻辑（作用域、分组、诊断）
  '40-shared-ui.js',       // 共享工具与 UI 原子（含 MCP 预设、Schema 可读化）
  '50-mcp-panels.js',      // MCP 面：列表 / 详情 / 编辑 / 导入 / 市场 / 导出
  '60-tool-loading.js',    // 工具页：加载策略与工具表
  '70-shell.js',           // 面板外壳与入口（McpTab、悬浮按钮、更新提示）
  '80-skills-face.js',     // 技能面：列表 / 详情 / 市场
  '90-contribution.js',    // contribution 描述符 + locale 接线 + apply
]

/** rpc-contract 生成段的边界（与 scripts/rpc-contract.mjs 同一对标记）。 */
const RPC_BEGIN = '// <rpc-contract:begin> 由 scripts/rpc-contract.mjs 生成，勿手改'
const RPC_END = '// <rpc-contract:end>'

function readPart(name, partsDir) {
  const text = readFileSync(join(partsDir, name), 'utf8')
  if (!text.endsWith('\n')) {
    throw new Error(`分片 ${name} 必须以换行结尾：否则拼回的产物会在分片交界处丢一个换行`)
  }
  if (text.trim() === '') throw new Error(`分片 ${name} 是空的（PARTS 里的每一条都必须有内容）`)
  return text
}

/**
 * 按 PARTS 的顺序把分片拼成 lib/client.js 的全文。
 *
 * 每个分片以 '\n' 结尾，去掉它、汇总成行数组后再 join('\n') + 末尾换行：这与逐字节拼接
 * 等价，但保留了「行」的概念，--check 才能把差异指到具体行号（否则只能报「整个文件不同」）。
 *
 * @param {string} [partsDir] 分片目录（测试与排障时指到别处）。
 * @returns {string} 产物全文（含末尾换行，与原文件一致）。
 */
export function renderClient(partsDir = PARTS_DIR) {
  const lines = []
  for (const name of PARTS) {
    const text = readPart(name, partsDir)
    lines.push(...text.slice(0, -1).split('\n'))
  }
  return lines.join('\n') + '\n'
}

/** 产物的行数（= 最后一个换行之前的所有行）。 */
export function clientLineCount(text = renderClient()) {
  return text.split('\n').length - 1
}

/** 生成段的三元组；没有标记时返回 null。 */
function regionOf(text) {
  const start = text.indexOf(RPC_BEGIN)
  const stop = text.indexOf(RPC_END)
  if (start < 0 || stop < start) return null
  return { start, stop, body: text.slice(start + RPC_BEGIN.length, stop) }
}

/** 找到持有生成段的那个分片。 */
function partHoldingRegion(partsDir) {
  for (const name of PARTS) {
    const text = readPart(name, partsDir)
    if (text.includes(RPC_BEGIN)) return { name, text }
  }
  return null
}

/** 第一处差异（1 基行号 + 两侧的原文片段）。 */
function firstDifference(expected, actual) {
  const left = expected.split('\n')
  const right = actual.split('\n')
  const limit = Math.max(left.length, right.length)
  for (let index = 0; index < limit; index += 1) {
    if (left[index] === right[index]) continue
    // 从**共同前缀之后**截一段：产物的行普遍很长（CSS 一行几千字符），从头截 120 个字符
    // 只会得到两行看起来一模一样的文本，等于没报差异。
    const common = commonPrefixLength(left[index] ?? '', right[index] ?? '')
    const from = Math.max(0, common - 12)
    return {
      line: index + 1,
      expected: preview(left[index], from),
      actual: preview(right[index], from),
    }
  }
  return null
}

function commonPrefixLength(left, right) {
  const limit = Math.min(left.length, right.length)
  let index = 0
  while (index < limit && left[index] === right[index]) index += 1
  return index
}

function preview(line, from) {
  if (line === undefined) return '（文件到此结束）'
  if (line === '') return '（空行）'
  const shown = line.slice(from, from + 120)
  return `${from > 0 ? '…' : ''}${shown}${from + shown.length < line.length ? '…' : ''}`
}

/**
 * 分片集合与 PARTS 的一致性：多出来的分片会被静默忽略（等于改了代码却没进产物），
 * 少掉的分片则直接读不到。两种情况都必须在 --check 里红。
 */
function checkPartSet(partsDir) {
  const problems = []
  let onDisk
  try {
    onDisk = readdirSync(partsDir).filter((name) => name.endsWith('.js')).sort()
  } catch {
    return [`读不到分片目录 ${partsDir}`]
  }
  const missing = PARTS.filter((name) => !onDisk.includes(name))
  const unlisted = onDisk.filter((name) => !PARTS.includes(name))
  if (missing.length) problems.push(`缺少分片：${missing.join(', ')}`)
  if (unlisted.length) problems.push(`未登记的分片（PARTS 里没有，拼进产物时会被漏掉）：${unlisted.join(', ')}`)
  return problems
}

/**
 * rpc-contract 生成段必须由分片持有同一份字节。
 * 产物先被 contract:write 改过、分片还停在旧内容时，这里就是唯一的判据。
 */
function checkGeneratedRegion(partsDir, artifactText) {
  const artifactRegion = regionOf(artifactText)
  const holder = partHoldingRegion(partsDir)
  if (!artifactRegion || !holder) {
    return [`找不到 rpc-contract 生成段标记（${RPC_BEGIN} … ${RPC_END}）`]
  }
  if (regionOf(holder.text).body !== artifactRegion.body) {
    return [`分片 ${holder.name} 的 rpc-contract 生成段与 lib/client.js 不一致（跑 --write 把生成段搬回分片）`]
  }
  return []
}

/** --check：产物的字节必须等于分片拼接的字节。 */
function check(partsDir) {
  const problems = checkPartSet(partsDir)
  // 分片集合不齐时拼接没有意义（缺一片就会读不到），只报集合问题。
  const expected = problems.length ? null : renderClient(partsDir)
  if (expected !== null) {
    const actual = readFileSync(CLIENT_PATH, 'utf8')
    problems.push(...checkGeneratedRegion(partsDir, actual))
    if (expected !== actual) {
      const diff = firstDifference(expected, actual)
      problems.unshift([
        `lib/client.js 与分片拼接的结果不一致（第一处差异在 第 ${diff.line} 行）`,
        `   分片：${diff.expected}`,
        `   产物：${diff.actual}`,
      ].join('\n'))
    }
  }
  if (problems.length) {
    for (const problem of problems) console.error(`✖ ${problem}`)
    // 分片拼不出来时退回报产物自己的行数：摘要里总得有一个数，才显得出「差多少」。
    const lines = clientLineCount(expected ?? readFileSync(CLIENT_PATH, 'utf8'))
    console.error(`✖ 分片与产物不一致：${PARTS.length} 个分片 / ${lines} 行（跑 node scripts/build-client.mjs --write）`)
    process.exitCode = 1
    return
  }
  console.log(`✔ lib/client.js 与分片拼接一致：${PARTS.length} 个分片 / ${clientLineCount(expected)} 行`)
}

/** --write：把产物里最新的生成段搬回分片，再用分片重写产物。 */
function write(partsDir) {
  const current = readFileSync(CLIENT_PATH, 'utf8')
  const synced = syncGeneratedRegion(partsDir, current)
  const next = renderClient(partsDir)
  if (next !== current) writeFileSync(CLIENT_PATH, next)
  if (synced) console.log(`↻ 已把 lib/client.js 的 rpc-contract 生成段同步进分片 ${synced}`)
  console.log(`${next === current ? '✔ 产物无需改动' : '✔ 已重写 lib/client.js'}：${PARTS.length} 个分片 / ${clientLineCount(next)} 行`)
}

/** 把产物里的生成段写回持有它的分片；已经一致时返回 null（什么都不做）。 */
function syncGeneratedRegion(partsDir, artifactText) {
  const artifactRegion = regionOf(artifactText)
  const holder = partHoldingRegion(partsDir)
  if (!artifactRegion || !holder) return null
  const partRegion = regionOf(holder.text)
  if (partRegion && partRegion.body === artifactRegion.body) return null
  const next = holder.text.slice(0, partRegion.start + RPC_BEGIN.length)
    + artifactRegion.body
    + holder.text.slice(partRegion.stop)
  writeFileSync(join(partsDir, holder.name), next)
  return holder.name
}

function main() {
  const args = new Set(process.argv.slice(2))
  const allowed = new Set(['--check', '--write'])
  const unknown = [...args].filter((arg) => !allowed.has(arg))
  if (unknown.length) {
    console.error(`用法：node scripts/build-client.mjs [--check|--write]（未知参数：${unknown.join(' ')}）`)
    process.exitCode = 2
    return
  }
  if (args.has('--write')) write(PARTS_DIR)
  else check(PARTS_DIR)
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) main()
