import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import test from 'node:test'
import { PARTS, PARTS_DIR, PART_FORWARD_REFS } from '../scripts/build-client.mjs'

// 分片的依赖方向闸门。
//
// 为什么需要它：所有分片拼回**一个**工厂函数作用域，所以「30 里调 50 的函数」在文本上完全合法，
// 只要调用发生在渲染期就"碰巧"能跑。真出现模块求值期的后置引用时，产物在浏览器里直接
// ReferenceError（const/let 的 TDZ）白屏——而 client:check 逐字节比的是产物与分片**一致**，
// 对顺序错误一言不发，所有单元用例也都看不到。
//
// 规则：只许引用前序分片。后置引用必须登记在 PART_FORWARD_REFS 并写明原因（渲染期读）。
// 同时报「没登记的新越界」与「登记了却已不再引用」——陈旧白名单会让下一次真实越界混过去。

/** 只保留代码：注释里的符号名（"见 SORT_KEYS 的注释"）与字符串里的名字都不算依赖。 */
function codeOnly(text) {
  let out = ''
  let index = 0
  while (index < text.length) {
    const char = text[index]
    const next = text[index + 1]
    if (char === '/' && next === '/') {
      while (index < text.length && text[index] !== '\n') index += 1
      continue
    }
    if (char === '/' && next === '*') {
      index += 2
      while (index < text.length && !(text[index] === '*' && text[index + 1] === '/')) index += 1
      index += 2
      continue
    }
    if (char === '"' || char === "'" || char === '`') {
      const quote = char
      out += ' '
      index += 1
      while (index < text.length) {
        if (text[index] === '\\') { index += 2; continue }
        // 模板里的 ${...} 不展开：里面的标识符按字符串处理只会漏检、不会误报。
        if (text[index] === quote) { index += 1; break }
        index += 1
      }
      continue
    }
    out += char
    index += 1
  }
  return out
}

/** 顶层声明 = 行首无缩进。分片里的嵌套声明一律有缩进（2 空格），所以这个判据够用。 */
const TOP_LEVEL_DECL = /^(?:export\s+)?(?:async\s+)?(?:const|let|var|function|class)\s+([A-Za-z_$][\w$]*)/gm
/** 任意层级的声明：用来识别**同名局部变量**（分片内的 shadow 不是对后置分片的依赖）。 */
const ANY_DECL = /\b(?:const|let|var|function|class)\s+([A-Za-z_$][\w$]*)/g

const topLevelNames = (code) => [...code.matchAll(TOP_LEVEL_DECL)].map((match) => match[1])
const localNames = (code) => new Set([...code.matchAll(ANY_DECL)].map((match) => match[1]))

/** 这段代码引用了 names 里的哪些名字（按词边界；同名局部变量不算）。 */
function referencesOf(code, names) {
  const shadowed = localNames(code)
  return names.filter((name) => !shadowed.has(name) && new RegExp(`\\b${name.replace(/\$/g, '\\$')}\\b`).test(code))
}

const readCode = (name) => codeOnly(readFileSync(join(PARTS_DIR, name), 'utf8'))

test('scanner: 注释与字符串不算依赖，同名局部变量不算依赖', () => {
  const names = ['SORT_KEYS', 'SkillsPanel']
  // 正控：真的引用必须被看见（否则下面的"零违规"是空绿）。
  assert.deepEqual(referencesOf('const a = SORT_KEYS.map(f);', names), ['SORT_KEYS'])
  assert.deepEqual(referencesOf('h(SkillsPanel, { call })', names), ['SkillsPanel'])
  // 注释、字符串：不算。
  assert.deepEqual(referencesOf(codeOnly('// 见 SORT_KEYS 的注释\nconst a = 1'), names), [])
  assert.deepEqual(referencesOf(codeOnly("const label = 'SORT_KEYS'"), names), [])
  assert.deepEqual(referencesOf(codeOnly('/* SORT_KEYS */ const a = 1'), names), [])
  // 同名局部变量 shadow：不算（真实案例：30-skill-model.js 里有一个局部的 byName Map）。
  assert.deepEqual(referencesOf('const byName = new Map(); byName.set(1, 2)', ['byName']), [])
})

test('每个分片只能引用前序分片；后置引用必须在 PART_FORWARD_REFS 里登记', () => {
  const code = new Map(PARTS.map((name) => [name, readCode(name)]))
  const declared = new Map(PARTS.map((name) => [name, topLevelNames(code.get(name))]))
  const problems = []

  for (let from = 0; from < PARTS.length; from += 1) {
    for (let to = from + 1; to < PARTS.length; to += 1) {
      const hits = referencesOf(code.get(PARTS[from]), declared.get(PARTS[to]))
      const allowed = PART_FORWARD_REFS[PARTS[from]]?.[PARTS[to]]?.names ?? []
      const unlisted = hits.filter((name) => !allowed.includes(name))
      const stale = allowed.filter((name) => !hits.includes(name))
      if (unlisted.length) {
        problems.push(`${PARTS[from]} 引用了后置分片 ${PARTS[to]} 的 ${unlisted.join(', ')}：`
          + '要么把它挪到前序分片，要么在 PART_FORWARD_REFS 登记并写明为什么只在渲染/调用期读')
      }
      if (stale.length) {
        problems.push(`PART_FORWARD_REFS 登记了 ${PARTS[from]} -> ${PARTS[to]} 的 ${stale.join(', ')}，`
          + '但代码已经不再引用它：陈旧的白名单会掩盖下一次真实越界')
      }
    }
  }

  assert.deepEqual(problems, [])
})

test('PART_FORWARD_REFS 本身自洽：分片存在、符号真的在对方分片里声明、理由不为空', () => {
  const declared = new Map(PARTS.map((name) => [name, new Set(topLevelNames(readCode(name)))]))
  const problems = []
  for (const [from, targets] of Object.entries(PART_FORWARD_REFS)) {
    if (!PARTS.includes(from)) { problems.push(`登记表里的来源分片不存在：${from}`); continue }
    for (const [to, entry] of Object.entries(targets)) {
      if (!PARTS.includes(to)) { problems.push(`${from} 登记的目柟分片不存在：${to}`); continue }
      if (PARTS.indexOf(to) <= PARTS.indexOf(from)) problems.push(`${from} -> ${to} 不是后置引用，不该登记在这张表里`)
      if (typeof entry?.why !== 'string' || entry.why.trim() === '') problems.push(`${from} -> ${to} 缺少 why`)
      if (!Array.isArray(entry?.names) || entry.names.length === 0) { problems.push(`${from} -> ${to} 的 names 为空`); continue }
      for (const name of entry.names) {
        if (!declared.get(to).has(name)) problems.push(`${from} -> ${to} 登记的 ${name} 在 ${to} 里没有顶层声明`)
      }
    }
  }
  assert.deepEqual(problems, [])
})
