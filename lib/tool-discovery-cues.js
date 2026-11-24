// Purpose hints use the current scoped catalog; they never register or discover tools.
// Note: Generic source quotations, never identity/version summaries — .agents/notes/implemented/2026-11-22-toolsearch-generic-purpose-hints.md

const CUE_CHAR_LIMIT = 800
const SHORT_PARAGRAPH_LIMIT = 160
const FIRST_SENTENCE_LIMIT = 240
const SENTENCES = new Intl.Segmenter('und', { granularity: 'sentence' })
const SENTENCE_END = /\p{Sentence_Terminal}[\p{Pe}\p{Pf}"']*$/u
const HEADER = '## Deferred purpose hints\n\nNon-exhaustive metadata, not schemas or permissions. Unshown tools remain searchable.'

/** Preserve a complete first nonempty paragraph before normalizing display whitespace. */
export function descriptionParagraph(description) {
  if (typeof description !== 'string') return ''
  const paragraph = description.replace(/\r\n?/g, '\n').split(/\n[ \t]*\n/).find((part) => part.trim() !== '')
  return paragraph === undefined ? '' : paragraph.replace(/\s+/g, ' ').trim()
}

/** Quote source text, never infer a purpose from its name. Browse uses the same quotation contract. */
export function descriptionPurpose(description) {
  const paragraph = descriptionParagraph(description)
  if (paragraph === '') return undefined
  if (paragraph.length <= SHORT_PARAGRAPH_LIMIT) return paragraph
  // ICU provides text boundaries, not semantic understanding or an identity check.
  const sentence = SENTENCES.segment(paragraph)[Symbol.iterator]().next().value.segment.trim()
  if (sentence.length > FIRST_SENTENCE_LIMIT || !SENTENCE_END.test(sentence)) return undefined
  return sentence
}

function purposeFor(name, description) {
  const purpose = descriptionPurpose(description)
  return purpose === undefined ? undefined : { name, purpose }
}

/**
 * @param {Map<string, object>} catalog Current, still-deferred definitions.
 * @param {{groups: {server: string, names: {name: string}[]}[], unattributed: object[]}} grouped
 * @param {(server: string) => string} [instructionsOf] Actual already-present publisher instructions.
 * @returns {{text: string, count: number, chars: number}}
 */
export function capabilityCues(catalog, grouped, instructionsOf = () => '') {
  let used = HEADER.length
  let count = 0
  const sources = [{ heading: '### Host, plugin and unattributed tools', tools: grouped.unattributed, repeat: true }]
  for (const group of grouped.groups) {
    // Presence is still conservative deduplication, not a quality assessment; browse never suppresses these.
    if (instructionsOf(group.server).trim() !== '') continue
    sources.push({ heading: `### MCP ${JSON.stringify(group.server)} — example, not exhaustive`, tools: group.names, repeat: false })
  }
  for (const source of sources) { source.iterator = source.tools[Symbol.iterator](); source.lines = [] }
  // Note: Source breadth before repeated host examples — .agents/notes/implemented/2026-11-23-toolsearch-source-browse.md
  let pending = sources
  while (pending.length > 0) {
    const next = []
    for (const source of pending) {
      for (let candidate = source.iterator.next(); !candidate.done; candidate = source.iterator.next()) {
        const tool = candidate.value
        const hint = purposeFor(tool.name, catalog.get(tool.name)?.description)
        if (!hint) continue
        const line = `- ${JSON.stringify(hint.name)} — ${JSON.stringify(hint.purpose)}`
        const cost = line.length + 1 + (source.lines.length === 0 ? source.heading.length + 2 : 0)
        if (used + cost > CUE_CHAR_LIMIT) continue
        used += cost
        count++
        source.lines.push(line)
        if (source.repeat) next.push(source)
        break // One actual fitting quote per source before another host example.
      }
    }
    pending = next
  }
  if (count === 0) return { text: '', count: 0, chars: 0 }
  // Selection order and display grouping differ: a later host quote must not appear under an MCP heading.
  const text = [HEADER, ...sources.filter((source) => source.lines.length > 0).map((source) => `${source.heading}\n${source.lines.join('\n')}`)].join('\n\n')
  return { text, count, chars: text.length }
}
