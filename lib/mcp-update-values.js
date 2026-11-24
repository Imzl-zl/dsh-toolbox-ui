// Updates may retain existing values by reference; they may never grant new JavaScript execution.
// The trusted paths are built only from the current server inside the Host write transaction.
import { normalizeMcpImport } from './mcp-config.js'
import { isSafeExpression } from './env-expression.js'
import { MCP_FIELD_SCHEMA, MASKED_FIELDS, MCP_REDACTED_VALUE, expressionText, fieldApplies, literalValueValid, preservedPathKey } from './mcp-value-schema.js'
import { setOwn } from './own-property.js'

const record = (value) => value !== null && typeof value === 'object' && !Array.isArray(value)
const own = (value, key) => value !== null && value !== undefined && Object.hasOwn(value, key)
const canonicalTransport = (value) => ['http', 'streamableHttp'].includes(value) ? 'streamable-http' : value

function existingExpression(field, value, scope) {
  const text = expressionText(value)
  if (text === undefined) return false
  if (scope === 'workspace' && !isSafeExpression(text)) throw new Error(`项目字段 ${field} 只能保留现有环境变量模板`)
  return true
}

function validateExisting(field, value, scope) {
  if (existingExpression(field, value, scope)) return
  if (!literalValueValid(field, value)) throw new Error(`字段 ${field} 的当前值无效，不能保留；请提供新值或手工修复`)
  if (scope === 'workspace' && (record(value) || Array.isArray(value))) {
    for (const child of Object.values(value)) existingExpression(field, child, scope)
  }
}

export function admitMcpUpdate(input, current, { scope = 'global' } = {}) {
  if (!record(input) || !record(current) || typeof current.name !== 'string') throw new Error('MCP 更新需要当前条目与对象输入')
  if (scope !== 'global' && scope !== 'workspace') throw new Error('MCP 更新 scope 必须为 global 或 workspace')
  if (own(input, 'preservedValues')) throw new Error('preservedValues 不是可接受的更新字段；请使用原值引用')
  const candidate = { ...input }
  // Updates target one already locked source. Import coercions must not choose another entry or transport later.
  for (const field of ['name', 'serverName', 'type', 'transport']) {
    if (own(candidate, field) && (typeof candidate[field] !== 'string' || candidate[field].trim() === '')) throw new Error(`更新字段 ${field} 必须是非空字符串`)
  }
  const requested = typeof candidate.name === 'string' ? candidate.name.trim() : ''
  if (requested !== current.name) throw new Error('保留原值的更新只能引用同一当前 MCP 名称')
  const target = own(candidate, 'serverName') ? candidate.serverName.trim() : requested
  const rename = target !== requested
  const selected = ['transport', 'type'].filter((field) => own(candidate, field)).map((field) => canonicalTransport(candidate[field].trim()))
  if (selected.length === 2 && selected[0] !== selected[1]) throw new Error('更新 type 与 transport 的传输方式冲突')
  const urls = ['url', 'serverUrl', 'server_url'].filter((field) => own(candidate, field))
  for (const field of urls) if (typeof candidate[field] !== 'string') throw new Error(`更新字段 ${field} 必须是字符串 URL`)
  if (urls.some((field) => candidate[field] !== candidate[urls[0]])) throw new Error('更新 URL 别名值冲突')
  if (urls.length) candidate.url = candidate[urls[0]]
  delete candidate.serverUrl
  delete candidate.server_url
  const inheritedTransport = current.transport ?? (current.command !== undefined ? 'stdio' : current.url !== undefined ? 'streamable-http' : candidate.command !== undefined ? 'stdio' : candidate.url !== undefined ? 'streamable-http' : undefined)
  const transport = selected[0] ?? canonicalTransport(inheritedTransport)
  candidate.name = target
  delete candidate.serverName
  candidate.transport = transport
  delete candidate.type
  const refs = candidate.preserveFields === undefined ? [] : candidate.preserveFields
  if (!Array.isArray(refs) || refs.some((field) => typeof field !== 'string') || new Set(refs).size !== refs.length) throw new Error('preserveFields 必须是不同根字段名的数组')
  if (rename && (scope === 'global' || refs.length > 0)) throw new Error('MCP 改名不能携带原值保留引用')
  delete candidate.preserveFields
  const preserved = new Map()
  const retain = (field, value, key) => {
    if (!fieldApplies(field, transport, scope)) throw new Error(`保留字段 ${field} 不适用于当前传输或作用域`)
    if (rename) throw new Error('MCP 改名不能携带原值保留引用')
    if (key === undefined) validateExisting(field, value, scope)
    else if (!existingExpression(`${field}.${key}`, value, scope) && typeof value !== 'string') throw new Error(`字段 ${field}.${key} 的当前值无效，不能保留`)
    preserved.set(preservedPathKey(key === undefined ? [field] : [field, key]), value)
    return value
  }
  for (const field of refs) {
    const schema = MCP_FIELD_SCHEMA[field]
    if (!schema || schema.scope === 'lifecycle' || field === 'transport') throw new Error(`保留引用 ${field} 不是可保留的配置根字段`)
    if (own(candidate, field)) throw new Error(`保留字段 ${field} 不能同时提供新值`)
    if (!own(current, field) || current[field] === undefined) throw new Error(`字段 ${field} 没有可保留的当前值`)
    candidate[field] = retain(field, current[field])
  }
  // Existing leaf sentinels retain only the original same-key value, never sibling authorization.
  for (const field of MASKED_FIELDS) {
    const value = candidate[field]
    const redaction = MCP_FIELD_SCHEMA[field].redaction
    if (value === MCP_REDACTED_VALUE || redaction === 'list' && Array.isArray(value) && value.includes(MCP_REDACTED_VALUE)) {
      if (redaction === 'list' && (value.length !== 1 || value[0] !== MCP_REDACTED_VALUE)) throw new Error('敏感参数的保留原值标记不能与新参数混合；请完整重填参数')
      if (!own(current, field) || current[field] === undefined) throw new Error(`字段 ${field} 没有可保留的当前值`)
      candidate[field] = retain(field, current[field])
    } else if (redaction === 'map' && record(value) && expressionText(value) === undefined) {
      const restored = {}
      for (const [key, child] of Object.entries(value)) {
        if (child !== MCP_REDACTED_VALUE) setOwn(restored, key, child)
        else {
          if (!record(current[field]) || expressionText(current[field]) !== undefined || !own(current[field], key)) throw new Error(`${field}.${key} 没有可保留的现有值`)
          setOwn(restored, key, retain(field, current[field][key], key))
        }
      }
      candidate[field] = restored
    }
  }
  // Unrendered preferences/lifecycle are owned by their source, not by an effective UI boolean.
  for (const field of ['defer', 'disabled']) {
    if (own(candidate, field) || !own(current, field) || field === 'disabled' && typeof candidate.directTools === 'boolean') continue
    const value = current[field]
    if (rename) {
      if (expressionText(value) !== undefined) throw new Error('MCP 改名不能复制旧生命周期或加载表达式')
      validateExisting(field, value, scope)
      candidate[field] = value
    } else candidate[field] = retain(field, value)
  }
  const result = normalizeMcpImport({ mcpServers: { [requested]: candidate } }, { preservedValues: new Map([[requested, preserved]]) })
  const spec = result.servers[0]
  if (spec.name !== target || spec.transport !== transport || preserved.size > 0 && spec.name !== current.name) throw new Error('MCP 更新归一化改变了锁定名称或传输方式')
  return { spec, preserveFields: [...refs] }
}
