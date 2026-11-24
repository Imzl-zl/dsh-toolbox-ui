// Read-only capability exploration. This module never loads, executes or persists discoveries.
import { createHash } from 'node:crypto'
import { searchCatalog } from './tool-search-index.js'
import { descriptionPurpose } from './tool-discovery-cues.js'

export const BROWSE_PROTOCOL = 'dsh-tool-browse/v1'
const ARGUMENT_NAME_LIMIT = 10
const CURSOR_ERROR = 'Invalid or stale browse cursor: restart browse without cursor in the current scope.'
const compareNames = (a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0

function offsetOf(cursor, identity, total) {
  if (cursor === undefined) return 0
  let decoded
  try {
    if (typeof cursor !== 'string' || cursor.length === 0 || cursor.length > 1024) throw new Error(CURSOR_ERROR)
    decoded = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'))
  } catch {
    throw new Error(CURSOR_ERROR)
  }
  if (!Array.isArray(decoded) || decoded.length !== 2 || decoded[0] !== identity
    || !Number.isSafeInteger(decoded[1]) || decoded[1] < 0 || decoded[1] > total) throw new Error(CURSOR_ERROR)
  return decoded[1]
}

/** Only declared top-level input fields; object branches are metadata, not a reconstructed calling schema. */
function declaredArgumentNames(schema) {
  const names = new Set()
  const seen = new Set()
  const pending = [schema]
  while (pending.length > 0) {
    const node = pending.pop()
    if (!node || typeof node !== 'object' || seen.has(node)) continue
    seen.add(node)
    for (const name of Object.keys(node.properties ?? {})) names.add(name)
    for (const kind of ['allOf', 'anyOf', 'oneOf']) if (Array.isArray(node[kind])) pending.push(...node[kind])
    for (const kind of ['if', 'then', 'else']) if (node[kind] && typeof node[kind] === 'object') pending.push(node[kind])
    if (node.dependentSchemas) pending.push(...Object.values(node.dependentSchemas))
    if (typeof node.$ref === 'string' && node.$ref.startsWith('#/')) {
      let target = schema
      for (const part of node.$ref.slice(2).split('/').map((part) => part.replace(/~1/g, '/').replace(/~0/g, '~'))) {
        target = target && Object.hasOwn(target, part) ? target[part] : undefined
      }
      if (target) pending.push(target)
    }
  }
  return [...names]
}

/**
 * @param {Map<string, object>} catalog Current managed definitions, including already loaded ones.
 * @param {{ownerOf: Map<string,string>, revision: string, scopeIdentity: string, query?: string,
 *   server?: string, limit: number, cursor?: string, stem: boolean, toolName: string}} options
 * The cursor is only a locator. Every call applies the current admitted catalog and owner filter again.
 */
export function browseCatalog(catalog, { ownerOf, revision, scopeIdentity, query = '', server, limit, cursor, stem, toolName }) {
  if (typeof query !== 'string') throw new Error('browse query must be a string')
  const words = query.trim()
  if (server !== undefined && (typeof server !== 'string' || server.trim() === '')) throw new Error('browse server must be an exact nonempty server name')
  if (!Number.isSafeInteger(limit) || limit < 1) throw new Error('browse max_results must be a positive integer')
  const candidates = words === ''
    ? [...catalog.values()].sort(compareNames)
    : searchCatalog(catalog, words, Math.max(1, catalog.size), stem, { ownerOf })
      .filter((match) => match.found).map((match) => catalog.get(match.name))
  const filtered = server === undefined ? candidates : candidates.filter((entry) => ownerOf.get(entry.name) === server)
  // A content revision alone cannot distinguish peers with identical inventories, or a runtime reload.
  const identity = createHash('sha256').update(JSON.stringify([scopeIdentity, revision, words, server ?? null])).digest('hex')
  const offset = offsetOf(cursor, identity, filtered.length)
  const entries = filtered.slice(offset, offset + limit).map((entry) => {
    const names = declaredArgumentNames(entry.parameters)
    return {
      name: entry.name,
      server: ownerOf.get(entry.name) ?? null,
      purpose: descriptionPurpose(entry.description) ?? null,
      argumentNames: names.slice(0, ARGUMENT_NAME_LIMIT),
      argumentCount: names.length,
    }
  })
  const next = offset + entries.length
  const nextCursor = next < filtered.length ? Buffer.from(JSON.stringify([identity, next])).toString('base64url') : null
  return {
    protocol: BROWSE_PROTOCOL,
    mode: 'browse',
    entries,
    total: filtered.length,
    nextCursor,
    instruction: `Metadata only: this browse operation has not loaded any schemas. Null purpose means the source has no fitting whole quotation; argumentCount counts declared field names across object branches, not dynamic keys or validation; only the first ten are displayed. Once a capability fits, load its definition with ${toolName} query "select:<exact name>" before using it. Use nextCursor only if you still need more information; do not enumerate every page before acting.`,
  }
}
