// 面板样式里三条容易静默失效的不变量。都不是风格偏好，各有具体来由：
//
//   1. prefers-reduced-motion —— 宿主官方客户端包普遍做这件事（ui-* 包 46 处 @media，
//      另有若干 JS 侧 matchMedia 判定）。本插件此前一处都没有，而它有 4 个缩放弹入动画
//      （.dsh-mcp-panel / -modal / -toast / -whatsnew）和十几处过渡。删掉不会有任何报错，
//      只会让一部分用户难受。
//      ⚠️ 故意**不**关 .dsh-mcp-dot.loading 的呼吸：它只改透明度、且是「正在连接」的状态线索。
//
//   2. 详情页签换行 —— 实测 390px 视口下 scrollWidth 431 > clientWidth 309，而滚动条是隐藏的
//      （scrollbar-width:none + ::-webkit-scrollbar{display:none}），最后一项会静默跑到屏幕外
//      且没有任何提示。作用域条用「横滚 + ⋯ 弹层」是对的（条目数不可控），详情页签固定三项，
//      换行才是正解。
//
//   3. 页签隐藏规则的级联胜负 —— 真机踩过：样式表里有**两条** .dsh-mcp-card，后面那条把它
//      定义成 display:flex；当时 .dsh-mcp-pane-off 是单类选择器，同特异性、位置更靠前，
//      于是被压掉，三个页签同时显示。组件测试只断言「类名挂上了」，DOM 树里一切正常，
//      全量用例一片绿——只有真机截图能看出来。所以这里断言的是**级联谁赢**，不是类名字符串。
//
// 断言走 scripts/theme-spec.mjs 的解析器（与主题契约同一份实现），不另写规则匹配。
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { extractPanelCss, parseRules } from '../scripts/theme-spec.mjs'

const css = extractPanelCss(readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8'))
const rules = parseRules(css)
const inMotionQuery = rules.filter((rule) => rule.at.some((at) => /prefers-reduced-motion:\s*reduce/.test(at)))
const declOf = (rule, property) => rule.declarations.find(([name]) => name === property)?.[1]

test('减少动效偏好下关掉弹入动画与过渡，且覆盖全部弹入面', () => {
  assert.ok(inMotionQuery.length > 0, '样式表里没有 prefers-reduced-motion 块——宿主官方包普遍有')

  const killed = new Set(inMotionQuery.flatMap((rule) => rule.selectors))
  for (const surface of ['.dsh-mcp-panel', '.dsh-mcp-modal', '.dsh-mcp-toast', '.dsh-mcp-whatsnew'])
    assert.ok(killed.has(surface), `${surface} 的弹入动画没有被降级规则覆盖`)

  assert.ok(inMotionQuery.some((rule) => declOf(rule, 'animation') === 'none'), '降级规则要关掉 animation')
  assert.ok(inMotionQuery.some((rule) => declOf(rule, 'transition') === 'none'), '降级规则要关掉 transition')

  // 状态线索保留：这条是刻意的例外，写死以免后人「顺手一起关掉」。
  assert.ok(
    !inMotionQuery.some((rule) => rule.selectors.includes('.dsh-mcp-dot.loading')),
    '.dsh-mcp-dot.loading 是「正在连接」的唯一动效线索，不该被降级规则关掉',
  )
})

test('详情页签在窄屏换行展示，不靠隐藏滚动条藏内容', () => {
  const strip = rules.find((rule) => rule.selectors.includes('.dsh-mcp-detail>.dsh-mcp-tabs'))
  assert.ok(strip, '找不到详情页签条的规则')
  assert.equal(declOf(strip, 'flex-wrap'), 'wrap', '页签条必须换行：横滚条在窄屏是隐藏的，最后一项会静默消失')
  assert.equal(declOf(strip, 'overflow'), 'visible', '页签条自己不该成为滚动容器')
})

test('ListFooter 的死 action 槽位连样式一起删干净', () => {
  // 曾经 ListFooter 有一个 `action` 槽位 + 四条 .dsh-mcp-foot-action 规则，而两个调用点
  // （MCP 面、技能面）都不传它——纯死代码。更糟的是 docstring 还写着这个槽是给「全部延迟」
  // 用的，与"唯一入口在过滤器行"自相矛盾，等于指示下一个往里加第二个入口。
  // 只删槽位不删 CSS 的话，那个人会发现样式居然还在，于是死代码又长回来。
  const dead = rules.filter((rule) => rule.selectors.some((selector) => selector.includes('dsh-mcp-foot-action')))
  assert.deepEqual(dead.map((rule) => rule.selectors), [], '底栏动作槽位的样式必须一起删掉')
})

test('页签隐藏规则压得过组件自身的 display', () => {
  // 一个详情页签元素身上可能同时挂着这些类，所以它们之间的 display 规则会互相竞争。
  const PANE_CLASSES = new Set(['dsh-mcp-pane-off', 'dsh-mcp-card', 'dsh-mcp-d-diag', 'dsh-mcp-detail', 'dsh-mcp-d-body'])
  const HIDER = 'dsh-mcp-pane-off'

  // 只考虑纯类选择器（可含后代/子组合符）：带标签名或伪类的规则不参与这场竞争。
  const classOnly = (selector) => /^\.\w[\w-]*(\s*[>+~]?\s*\.\w[\w-]*)*$/.test(selector.trim())
  const classesOf = (selector) => selector.match(/\.\w[\w-]*/g).map((token) => token.slice(1))
  const touchesPane = (rule) => rule.selectors.some((selector) =>
    classOnly(selector) && classesOf(selector).every((name) => PANE_CLASSES.has(name)))
  // 纯类选择器里，类数就是特异性；同特异性时才轮到位次。
  const specificity = (selector) => classesOf(selector).length
  const beats = (aSelector, aRule, bSelector, bRule) => {
    const sa = specificity(aSelector)
    const sb = specificity(bSelector)
    return sa !== sb ? sa > sb : rules.indexOf(aRule) > rules.indexOf(bRule)
  }

  let hider
  for (const rule of rules) {
    if (!rule.selectors.some((selector) => classOnly(selector) && classesOf(selector).includes(HIDER))) continue
    if (rule.declarations.some(([property, value]) => property === 'display' && value === 'none')) hider = rule
  }
  assert.ok(hider, `找不到把 ${HIDER} 设为 display:none 的规则`)

  const hiderSelector = hider.selectors.find((selector) => classesOf(selector).includes(HIDER))
  for (const rule of rules) {
    if (rule === hider || !touchesPane(rule)) continue
    if (!rule.declarations.some(([property]) => property === 'display')) continue
    for (const selector of rule.selectors) {
      if (!classOnly(selector) || !classesOf(selector).every((name) => PANE_CLASSES.has(name))) continue
      assert.ok(
        beats(hiderSelector, hider, selector, rule),
        `${selector} 会压掉 ${hiderSelector} 的 display（同特异性且更靠后，或特异性更高）——` +
        '真机上表现为几个页签同时显示，而组件测试全绿',
      )
    }
  }
})
