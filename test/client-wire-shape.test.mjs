import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync } from 'node:fs'

import { TYPERT } from '../lib/typert.js'

// 为什么有这条用例：真机上报 `typert gateway: mcpManager/removeServer: wire field "name"
// failed boundary validation`——市场卡片上点「移除」永远失败，而面板把这条错误显示成
// 「读取目录失败」，看上去像目录坏了。
//
// 根因是**客户端实参形状与描述符不符**。客户端代理按位置把实参映射到描述符的
// `parameters[i].wire`（dsh-api-gateway 的 ClientRemote.invoke）：
//   - 单参数 `name`（String）→ 必须传标量；传 `{ name }` 会变成 `{ name: { name } }`，
//     宿主的 zod `z.string()` 立刻拒掉；
//   - 0 参数的方法 → 一个实参都不许传，否则客户端在**发出去之前**就抛
//     `expected 0 argument(s), got 1`（skillHubCategories 就是这样把 locale 丢掉的，
//     报错还被调用处的 try/catch 吞了）。
//
// 这一类缺陷的共性是「两侧各自都对、只有拼起来才错」：宿主实现、typert 描述符、
// 面板调用点分属三个文件，单元测试各自覆盖不到。所以这里拿**出货的两份真实数据**
// （lib/typert.js 的描述符 + lib/client.js 的调用点）对撞，不维护第二份期望值。

const CLIENT = new URL('../lib/client.js', import.meta.url)

/** 去掉注释，保留字符串与行号——注释里举例写的调用形状不该参与判定。 */
function stripComments(source) {
  let out = ''
  let index = 0
  let quote = null
  while (index < source.length) {
    const char = source[index]
    if (quote !== null) {
      out += char
      if (char === '\\') {
        out += source[index + 1] ?? ''
        index += 2
        continue
      }
      if (char === quote) quote = null
      index += 1
      continue
    }
    if (char === '"' || char === "'" || char === '`') {
      quote = char
      out += char
      index += 1
      continue
    }
    if (char === '/' && source[index + 1] === '/') {
      while (index < source.length && source[index] !== '\n') {
        out += ' '
        index += 1
      }
      continue
    }
    if (char === '/' && source[index + 1] === '*') {
      while (index < source.length && !(source[index] === '*' && source[index + 1] === '/')) {
        out += source[index] === '\n' ? '\n' : ' '
        index += 1
      }
      out += '  '
      index += 2
      continue
    }
    out += char
    index += 1
  }
  return out
}

/** 从 `openParen` 起切出顶层逗号分隔的实参文本（尊重字符串、模板与嵌套括号）。 */
function splitArguments(source, openParen) {
  const args = []
  let depth = 0
  let quote = null
  let start = openParen + 1
  for (let index = openParen; index < source.length; index += 1) {
    const char = source[index]
    if (quote !== null) {
      if (char === '\\') {
        index += 1
        continue
      }
      if (char === quote) quote = null
      continue
    }
    if (char === '"' || char === "'" || char === '`') {
      quote = char
      continue
    }
    if (char === '(' || char === '[' || char === '{') {
      depth += 1
      continue
    }
    if (char === ')' || char === ']' || char === '}') {
      depth -= 1
      if (depth === 0) {
        const tail = source.slice(start, index).trim()
        if (tail !== '') args.push(tail)
        return args
      }
      continue
    }
    if (char === ',' && depth === 1) {
      args.push(source.slice(start, index).trim())
      start = index + 1
    }
  }
  throw new Error('未闭合的调用括号')
}

/**
 * 描述符索引：方法名 → 每个服务下可能的参数形状。
 *
 * 两个服务各有 `list`，所以按方法名索引时**保留两种可能**（调用点写的是哪个变量，
 * 静态上分不清 `call` / `callSkills`——两者在面板里都被当 `call` 传下去）。
 * 只要实参与其中任一服务的描述符相符就算过；都不符才报。
 */
function descriptorIndex() {
  const index = new Map()
  for (const invocation of TYPERT.invocations) {
    const shapes = index.get(invocation.method) ?? []
    shapes.push({
      service: invocation.service,
      endpoint: `${invocation.service}/${invocation.method}`,
      parameters: invocation.parameters,
    })
    index.set(invocation.method, shapes)
  }
  return index
}

const symbolOf = (parameter) => parameter.codec.typeSymbol.split('#')[1]

test('every panel call site matches its descriptor wire shape', () => {
  const source = stripComments(readFileSync(CLIENT, 'utf8'))
  const index = descriptorIndex()
  const failures = []
  const sites = []

  const callSite = /\b(call|callSkills|act)\(\s*'([A-Za-z]+)'/g
  for (const match of source.matchAll(callSite)) {
    const [, helper, method] = match
    const line = source.slice(0, match.index).split('\n').length
    const openParen = source.indexOf('(', match.index + helper.length)
    const args = splitArguments(source, openParen)
    // 第 0 个实参是方法名本身。`act(method, args, successMsg)` 的第三个是提示文案，
    // 不是 wire 实参，所以 act 最多取一个。
    const rpcArgs = helper === 'act' ? args.slice(1, 2) : args.slice(1)
    const shapes = index.get(method)
    if (shapes === undefined) {
      failures.push(`L${line} ${helper}('${method}') 在 lib/typert.js 里没有对应描述符`)
      continue
    }
    sites.push({ line, helper, method })

    const matchesArity = shapes.some((shape) => shape.parameters.length === rpcArgs.length)
    if (!matchesArity) {
      const expected = shapes.map((shape) => `${shape.endpoint} 收 ${shape.parameters.length} 个`).join('；')
      failures.push(`L${line} ${helper}('${method}') 传了 ${rpcArgs.length} 个实参，但 ${expected}`)
      continue
    }

    // 只看与实参个数相符的那份描述符：单参数且类型是 String 时，实参必须是标量。
    for (const shape of shapes) {
      if (shape.parameters.length !== rpcArgs.length) continue
      const parameter = shape.parameters[0]
      if (parameter === undefined || symbolOf(parameter) !== 'String') continue
      const [arg] = rpcArgs
      if (/^\{/.test(arg)) {
        failures.push(
          `L${line} ${helper}('${method}') 的 "${parameter.wire}" 是 String（wire 标量），却传了对象：${arg}\n` +
            `    网关会把它映射成 { ${parameter.wire}: 对象 }，被 String codec 拒成 "wire field \"${parameter.wire}\" failed boundary validation"`,
        )
      }
    }
  }

  // 反向下限：扫描器本身坏掉（正则失配、注释剥离吃掉全文）时必须红，而不是"零条违规"通过。
  assert.ok(sites.length >= 40, `只扫到 ${sites.length} 个调用点，扫描器可能已经失效`)
  assert.deepEqual(failures, [], failures.join('\n  '))
})
