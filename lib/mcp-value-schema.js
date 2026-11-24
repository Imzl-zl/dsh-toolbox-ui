// Field ownership and literal types are shared by Host projection and controlled update admission.
// This module never evaluates expressions or stringifies unknown objects.
const both = Object.freeze(['stdio', 'streamable-http'])
const stdio = Object.freeze(['stdio'])
const http = Object.freeze(['streamable-http'])
const field = (kind, scope, transports = both, redaction) => Object.freeze({ kind, scope, transports, ...(redaction === undefined ? {} : { redaction }) })

export const MCP_FIELD_SCHEMA = Object.freeze(Object.assign(Object.create(null), {
  transport: field('text', 'managed'),
  command: field('text', 'managed', stdio),
  args: field('stringList', 'managed', stdio, 'list'),
  env: field('stringMap', 'managed', stdio, 'map'),
  cwd: field('text', 'managed', stdio),
  url: field('text', 'managed', http, 'url'),
  headers: field('stringMap', 'managed', http, 'map'),
  toolCallTimeoutMs: field('positiveInteger', 'managed'),
  failOnStartupError: field('boolean', 'managed'),
  reconnect: field('reconnect', 'managed'),
  defer: field('boolean', 'plugin'),
  idleTimeoutMs: field('nonnegativeInteger', 'workspace'),
  readyTimeoutMs: field('nonnegativeInteger', 'workspace'),
  disabled: field('boolean', 'lifecycle'),
}))

export const MANAGED_VALUE_FIELDS = Object.freeze(Object.keys(MCP_FIELD_SCHEMA).filter((name) => MCP_FIELD_SCHEMA[name].scope === 'managed'))
export const PLUGIN_VALUE_FIELDS = Object.freeze(Object.keys(MCP_FIELD_SCHEMA).filter((name) => MCP_FIELD_SCHEMA[name].scope === 'plugin'))
export const MASKED_FIELDS = Object.freeze(Object.keys(MCP_FIELD_SCHEMA).filter((name) => MCP_FIELD_SCHEMA[name].redaction !== undefined))
export const MCP_REDACTED_VALUE = '__DSH_MCP_REDACTED__'

export function fieldKind(fieldName) { return MCP_FIELD_SCHEMA[fieldName]?.kind }
export function fieldApplies(fieldName, transport, scope = 'global') {
  const schema = MCP_FIELD_SCHEMA[fieldName]
  return schema !== undefined && schema.transports.includes(transport) && (schema.scope !== 'workspace' || scope === 'workspace')
}

export function expressionText(value) {
  const source = typeof value === 'string' && value.startsWith('!!js ')
    ? value.slice(5)
    : value !== null && typeof value === 'object' && !Array.isArray(value)
      && Object.hasOwn(value, '__jsExpr') && typeof value.__jsExpr === 'string' ? value.__jsExpr : undefined
  return typeof source === 'string' && source.trim() !== '' ? `!!js ${source}` : undefined
}

const plainMap = (value) => value !== null && typeof value === 'object' && !Array.isArray(value) && expressionText(value) === undefined
const textValue = (value) => typeof value === 'string' || expressionText(value) !== undefined
export function literalValueValid(fieldName, value) {
  switch (fieldKind(fieldName)) {
    case 'text': return typeof value === 'string'
    case 'boolean': return typeof value === 'boolean'
    case 'positiveInteger': return Number.isSafeInteger(value) && value > 0
    case 'nonnegativeInteger': return Number.isSafeInteger(value) && value >= 0
    case 'stringList': return Array.isArray(value) && value.every(textValue)
    case 'stringMap': return plainMap(value) && Object.values(value).every(textValue)
    case 'reconnect': return plainMap(value) && Object.entries(value).every(([key, item]) =>
      expressionText(item) !== undefined || (key === 'enabled' ? typeof item === 'boolean'
        : key === 'maxAttempts' ? Number.isSafeInteger(item) && item >= 1
          : ['initialDelayMs', 'maxDelayMs'].includes(key) && Number.isFinite(item) && item > 0))
    default: return false
  }
}

/** Creation/import must not smuggle an update reference or an existing-value sentinel. */
export function assertNewMcpValues(value) {
  const seen = new WeakSet()
  const visit = (item) => {
    if (item === MCP_REDACTED_VALUE) throw new Error('新增/导入 MCP 不能包含保留原值标记')
    if (!item || typeof item !== 'object' || seen.has(item)) return
    seen.add(item)
    if (Array.isArray(item)) { item.forEach(visit); return }
    Object.values(item).forEach(visit)
  }
  if (value && Object.hasOwn(value, 'preserveFields')) throw new Error('preserveFields 只允许用于当前 MCP 的更新保留')
  visit(value)
}

// The first argument is never authoritative: this map can only be supplied by the Host update boundary.
export const preservedPathKey = (path) => JSON.stringify(path)
export function isPreservedAt(preservedValues, path, value) {
  const key = preservedPathKey(path)
  return preservedValues?.has(key) === true && Object.is(preservedValues.get(key), value)
}
