/* Generated for dsh-toolbox-ui — do not edit. */
import { z } from 'zod'

const $any = z.unknown()
const $name = z.string()

// strict codec 的形状由宿主校验，而宿主在两个渠道上查**不同的键**：
//   0.1.5-rc.x（= 当时 latest/next，npx 默认装到的那条）查 `schema` 必须是 zod v4 实例；
//   0.1.6-alpha.2 起改查 `create()` 工厂，不再看 `schema`（registry 用
//   `record.value ??= record.create()` 在进程内 realm 物化 schema）。
// 两边都忽略对方的键，所以**两个都写**是唯一同时满足基线与 alpha 的形状：少写 `schema`
// 会在最新 RC 上加载即拒，少写 `create` 会在 alpha 上加载即拒（`mode: 'src-json'` 不是出路
// ——loader 强制 invocation 的 codec 必须是 strict）。实测形状矩阵见 docs/design.md「版本
// 范围怎么定」。lib/client.js 有一份同形状的副本，两处必须一起改。
const codec = (symbol, schema) => ({
  mode: 'strict',
  typeSymbol: `dsh-toolbox-ui/typert#${symbol}`,
  schema,
  create: () => schema,
})

const mv = (method, params, resultSym) => ({
  id: `dsh-toolbox-ui#mcpManager/${method}`,
  service: 'mcpManager',
  namespace: 'mcpManager',
  method,
  invocation: { kind: 'direct' },
  parameters: params,
  result: codec(resultSym, $any),
  sourceLocation: { file: 'dsh-toolbox-ui/lib/typert.js', line: 7, column: 1 },
})

/**
 * skills 服务的条目工厂。
 *
 * 为什么不复用 mv()：mv() 把 id/service/namespace 三处都写死成 mcpManager（三处必须一致，
 * 所以留一个工厂一种形态是刻意的）。两个服务的 serviceKey 与 wire namespace 都不同
 * （mcpManager / skillsManager），硬套 mv() 只会得到 id 与实际 endpoint 不符的条目——
 * 那种错误在结构上完全合法，只在调用时静默打到错的服务上。故参数化 service/namespace。
 *
 * @param {string} method - 方法名（与 gateway 上的 @Remote 名一致）。
 * @param {object[]} params
 * @param {string} resultSym - 结果 codec 的 typeSymbol 后缀。
 */
const mvs = (method, params, resultSym) => ({
  id: `dsh-toolbox-ui#skillsManager/${method}`,
  service: 'skillsManager',
  namespace: 'skillsManager',
  method,
  invocation: { kind: 'direct' },
  parameters: params,
  result: codec(resultSym, $any),
  sourceLocation: { file: 'dsh-toolbox-ui/lib/typert.js', line: 7, column: 1 },
})

const nameParam = { name: 'name', wire: 'name', source: 'json', codec: codec('String', $name) }
const specParam = { name: 'spec', wire: 'spec', source: 'json', codec: codec('Spec', $any) }
const payloadParam = { name: 'payload', wire: 'payload', source: 'json', codec: codec('ImportPayload', $any) }
const builtinInstallParam = { name: 'payload', wire: 'payload', source: 'json', codec: codec('BuiltinInstallPayload', $any) }
// setDeferAll 的载荷与结果。符号名与 lib/client.js 的 descriptor 必须逐字一致——
// 三边契约（index.js @Remote / typert.js / client.js）比对的就是 typeSymbol。
const deferAllParam = { name: 'payload', wire: 'payload', source: 'json', codec: codec('DeferAllPayload', $any) }
// skills 侧统一走单个 payload 对象（方法签名就是 (payload) => …）：面板传的是
// 「作用域 + 技能名 + 根目录」这类复合参数，逐字段展开会让 wire 形状与实现签名容易走偏。
const skillPayloadParam = { name: 'payload', wire: 'payload', source: 'json', codec: codec('SkillPayload', $any) }

export const TYPERT = {
  package: 'dsh-toolbox-ui',
  face: 'host',
  schemas: [],
  invocations: [
    mv('list', [], 'ListResult'),
    mv('status', [nameParam], 'StatusResult'),
    mv('enable', [nameParam], 'NoteResult'),
    mv('disable', [nameParam], 'NoteResult'),
    mv('reconnect', [nameParam], 'NoteResult'),
    mv('tools', [payloadParam], 'ToolsResult'),
    mv('builtins', [], 'BuiltinCatalogResult'),
    mv('installBuiltins', [builtinInstallParam], 'BuiltinInstallResult'),
    mv('add', [specParam], 'NoteResult'),
    mv('update', [specParam], 'NoteResult'),
    mv('removeServer', [nameParam], 'NoteResult'),
    mv('setDeferAll', [deferAllParam], 'DeferAllResult'),
    mv('reveal', [payloadParam], 'RevealResult'),
    mv('previewImport', [payloadParam], 'ImportPreview'),
    mv('importJson', [payloadParam], 'ImportResult'),
    mv('scanImportSources', [payloadParam], 'ImportSourcesResult'),
    mv('previewImportSource', [payloadParam], 'ImportPreview'),
    mv('importSource', [payloadParam], 'ImportResult'),
    mv('listWorkspaces', [], 'WorkspaceListResult'),
    mv('getWorkspaceView', [payloadParam], 'WorkspaceViewResult'),
    mv('addWorkspaceServer', [payloadParam], 'NoteResult'),
    mv('updateWorkspaceServer', [payloadParam], 'NoteResult'),
    mv('removeWorkspaceServer', [payloadParam], 'NoteResult'),
    mv('setWorkspaceExclude', [payloadParam], 'NoteResult'),
    mv('installWorkspaceBuiltins', [builtinInstallParam], 'BuiltinInstallResult'),
    mv('previewWorkspaceImport', [payloadParam], 'ImportPreview'),
    mv('importWorkspaceJson', [payloadParam], 'ImportResult'),
    mv('copyWorkspaceServers', [payloadParam], 'WorkspaceCopyResult'),
    mv('previewWorkspaceCopy', [payloadParam], 'WorkspaceCopyPreview'),
    mv('exportWorkspaceJson', [payloadParam], 'WorkspaceExportResult'),
    mv('revealWorkspaceServer', [payloadParam], 'RevealResult'),
    mv('projectConnections', [], 'ProjectConnectionsResult'),
    mv('reconnectWorkspaceServer', [payloadParam], 'NoteResult'),
    mv('updateHint', [], 'UpdateHintResult'),
    mv('whatsNew', [], 'WhatsNewResult'),
    // ---- skillsManager（技能能力面）----
    // 顺序与 SkillsManagerGateway 的 @Remote 声明顺序一致；完整性由
    // test/typert-manifest.test.mjs 用 remoteMethods(实例) 自动比对，不靠人工维护。
    mvs('list', [skillPayloadParam], 'SkillListResult'),
    mvs('detail', [skillPayloadParam], 'SkillDetailResult'),
    mvs('setEnabled', [skillPayloadParam], 'SkillMutationResult'),
    mvs('setModelInvocable', [skillPayloadParam], 'SkillMutationResult'),
    mvs('setUserInvocable', [skillPayloadParam], 'SkillMutationResult'),
    // ⚠️ 不能叫 `remove`：客户端适配器（dsh-api-gateway 的 RemoteNamespaceService）自己就有原型
    // 方法 `remove(kind, method, token)`，`ctx.remote.$mount` 会把「与命名空间服务自身成员重名」
    // 的 endpoint 直接拒掉——报 `client api: method "skillsManager/remove" conflicts with its
    // namespace service`，客户端 apply() 随即抛错、fiber 变 FAILED、整页 boot 停在
    // "Failed to load plugins"。MCP 面同样绕开了这个名字（用 `removeServer`）。
    // 同类保留名还有 ctx/empty/has/install/methods/name/namespace。回归闸见
    // test/client-admission.test.mjs（用真网关跑我们的真 bundle）。
    mvs('removeSkill', [skillPayloadParam], 'SkillMutationResult'),
    mvs('importSkill', [skillPayloadParam], 'SkillMutationResult'),
    mvs('skillTargets', [skillPayloadParam], 'SkillTargetsResult'),
    mvs('skillHubSearch', [skillPayloadParam], 'SkillHubSearchResult'),
    mvs('skillHubDetail', [skillPayloadParam], 'SkillHubDetailResult'),
    mvs('skillHubCategories', [], 'SkillHubCategoriesResult'),
    mvs('skillHubInstall', [skillPayloadParam], 'SkillMutationResult'),
    mvs('conflictingManager', [], 'SkillConflictResult'),
  ],
  model: { services: [], events: [], objects: [] },
}