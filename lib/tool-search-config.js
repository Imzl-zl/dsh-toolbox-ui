// ToolSearch 的配置桥：把插件的配置状态译成运行时的活输入。
//
// 两个来源：
//   - loader 条目（allMcpEntries）：每个 mcp-client 实例的 options.config——全局 profile 条目
//     与项目级共享连接都在里面，`defer` 字段由 mcp-config.normalizeEntry 归一化后落在这里。
//   - 进程环境：DSH_MCP_TOOL_SEARCH=off 一键回退全量注入（设计文档 §8 全局开关）。
//
// 之所以是**函数**而不是快照 Set：工具集与配置都会在会话生命周期内变化（服务器晚连、
// 用户在面板改开关），运行时的每次视图重建都重新读一遍（视图按 revision 判失效）。

import { allMcpEntries } from './mcp-registry.js'
import { projectMcpServers } from './workspace-runtime.js'

/** 全局开关：置 off 时所有服务器视同 defer=false，本功能整体短路。 */
export function toolSearchDisabled() {
  return String(process.env.DSH_MCP_TOOL_SEARCH ?? '').trim().toLowerCase() === 'off'
}

/**
 * 全部已知 MCP 服务器 → defer 标志。**唯一来源表**，两个族各贡献一半：
 *   - 全局族：loader 条目（profile patch 里的 mcp 条目）
 *   - 项目族：共享连接（connectionCtx.plugin 建出来的，不在 loader 树里）
 *
 * 归属只能按 serverName——工具名只编码它。所以同名的任一条目 defer，该名字就 defer
 * （DSH 0.1.5 起各注册作用域允许同名，这不是冲突，是命字）。
 */
export function serverDeferTable(ctx) {
  const table = new Map()
  for (const entry of allMcpEntries(ctx)) {
    const serverName = entry.options?.config?.serverName
    if (typeof serverName === 'string' && serverName !== '') table.set(serverName, entry.options.config.defer === true)
  }
  for (const server of projectMcpServers(ctx)) {
    if (typeof server?.name !== 'string' || server.name === '') continue
    table.set(server.name, table.get(server.name) === true || server.defer === true)
  }
  return table
}

/** 全部已知 MCP 服务器名。uniqueOwner 的归属判定需要这份全集。 */
export function serverNamesOf(ctx) {
  return [...serverDeferTable(ctx).keys()]
}

/** 当前标记 defer=true 的服务器名。总开关置 off 时返回空（功能短路）。 */
export function deferServersOf(ctx) {
  if (toolSearchDisabled()) return []
  return [...serverDeferTable(ctx)].filter(([, defer]) => defer).map(([name]) => name)
}
