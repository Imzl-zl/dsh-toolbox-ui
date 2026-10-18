// YAML 节点读取原语——全仓**唯一**一份实现。
//
// 为什么单独成模块：`mcp-config.js`（MCP 条目）与 `tool-search-settings.js`（插件自身配置）
// 都在改同一批 profile patch 文件，两边都需要"从 Document 节点读出 JS 值"这一层。抄两份的
// 后果不是风格问题：`!!js` 标签的读法一旦有一边落后，另一边就会把表达式节点读成 `[object
// Object]`，而那正是 1.6.x 修过的「点眼睛看到 [object Object]」那个缺陷的形状。
//
// 与领域无关，所以既不属于 mcp-config（会让插件配置面为了一个读取原语去依赖整张 MCP 目录
// 表），也不属于 index.js（那是 RPC 层）。
import { isMap, isSeq } from 'yaml'
import { setOwn } from './own-property.js'

/** `!!js` 表达式的 tag。loader 保留原始表达式节点，apply 前才求值（见 index.js 的 reveal）。 */
export const JS_TAG = 'tag:yaml.org,2002:js'

export function scalarValue(node) {
  if (node === undefined) return undefined
  if (node.tag === JS_TAG) return `!!js ${String(node.value)}`
  return node.value
}

export function nodeValue(node) {
  if (node === undefined) return undefined
  if (isMap(node)) {
    const value = {}
    for (const pair of node.items) setOwn(value, String(scalarValue(pair.key)), nodeValue(pair.value))
    return value
  }
  if (isSeq(node)) return node.items.map(nodeValue)
  return scalarValue(node)
}

export function getNode(map, key) {
  return isMap(map) ? map.get(key, true) : undefined
}

export function getValue(map, key) {
  return nodeValue(getNode(map, key))
}
