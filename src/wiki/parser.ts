// ============================================================================
// Wiki page parser — frontmatter + body + wikilink extraction.
//
// Tolerant: only `title` is required (derived from slug if missing). Unknown
// frontmatter fields are ignored. Sequence values (sources/related/tags) accept
// either a YAML block list (- foo) or an inline list ([a, b]).
//
// Also extracts slugs referenced from wiki/index.md so the registry can warm
// the cache.
// ============================================================================

import type { WikiPage, WikiPageFrontmatter } from './types.ts'

const FRONTMATTER_RE = /^---\s*\r?\n([\s\S]*?)\r?\n---\s*\r?\n?/
const WIKILINK_RE = /\[\[([^\]\n|]+?)(?:\|[^\]\n]+)?\]\]/g

const slugFromPath = (path: string): string => {
  // "wiki/concepts/foo.md" → "foo"
  const file = path.split('/').pop() ?? path
  return file.endsWith('.md') ? file.slice(0, -3) : file
}

interface ParsedFrontmatter {
  readonly fields: Record<string, string | string[]>
  readonly raw: string
}

const parseFrontmatter = (text: string): { fm?: ParsedFrontmatter; body: string } => {
  const match = FRONTMATTER_RE.exec(text)
  if (!match) return { body: text }
  const raw = match[1] ?? ''
  const body = text.slice(match[0].length)
  const fields: Record<string, string | string[]> = {}

  const lines = raw.split(/\r?\n/)
  let currentKey: string | undefined
  let currentList: string[] | undefined

  for (const line of lines) {
    if (!line.trim()) continue

    // Block-list continuation: "  - value"
    const listItem = /^\s+-\s*(.*)$/.exec(line)
    if (listItem && currentKey && currentList) {
      currentList.push(stripQuotes(listItem[1] ?? ''))
      continue
    }

    // key: value or key: [a, b] or key: (block follows)
    const kv = /^([A-Za-z_][A-Za-z0-9_-]*)\s*:\s*(.*)$/.exec(line)
    if (!kv) continue
    const key = kv[1] ?? ''
    const rawVal = (kv[2] ?? '').trim()

    if (rawVal === '') {
      // Block list follows.
      currentKey = key
      currentList = []
      fields[key] = currentList
      continue
    }

    // Inline list?
    if (rawVal.startsWith('[') && rawVal.endsWith(']')) {
      const inner = rawVal.slice(1, -1).trim()
      const items = inner ? inner.split(',').map((s) => stripQuotes(s.trim())) : []
      fields[key] = items
      currentKey = undefined
      currentList = undefined
      continue
    }

    fields[key] = stripQuotes(rawVal)
    currentKey = undefined
    currentList = undefined
  }

  return { fm: { fields, raw }, body }
}

const stripQuotes = (s: string): string => {
  const t = s.trim()
  if ((t.startsWith('"') && t.endsWith('"')) || (t.startsWith("'") && t.endsWith("'"))) {
    return t.slice(1, -1)
  }
  return t
}

const asStringArray = (v: string | string[] | undefined): ReadonlyArray<string> | undefined => {
  if (v === undefined) return undefined
  if (typeof v === 'string') return v.length > 0 ? [v] : []
  return v.filter((s) => s.length > 0)
}

const asConfidence = (v: string | string[] | undefined): WikiPageFrontmatter['confidence'] => {
  const s = typeof v === 'string' ? v.toLowerCase() : ''
  if (s === 'high' || s === 'medium' || s === 'low') return s
  return undefined
}

const extractWikilinks = (body: string): ReadonlyArray<string> => {
  const out = new Set<string>()
  let m: RegExpExecArray | null
  WIKILINK_RE.lastIndex = 0
  while ((m = WIKILINK_RE.exec(body)) !== null) {
    const target = (m[1] ?? '').trim()
    if (target) out.add(target)
  }
  return [...out]
}

export const parseWikiPage = (path: string, text: string, fetchedAt: number = Date.now()): WikiPage => {
  const { fm, body } = parseFrontmatter(text)
  const fields = fm?.fields ?? {}
  const slug = slugFromPath(path)
  const titleRaw = fields.title
  const title = typeof titleRaw === 'string' && titleRaw.length > 0 ? titleRaw : slug

  const frontmatter: WikiPageFrontmatter = {
    title,
    ...(typeof fields.type === 'string' ? { type: fields.type } : {}),
    ...(asStringArray(fields.sources) ? { sources: asStringArray(fields.sources) } : {}),
    ...(asStringArray(fields.related) ? { related: asStringArray(fields.related) } : {}),
    ...(asStringArray(fields.tags) ? { tags: asStringArray(fields.tags) } : {}),
    ...(asConfidence(fields.confidence) ? { confidence: asConfidence(fields.confidence) } : {}),
    ...(typeof fields.created === 'string' ? { created: fields.created } : {}),
    ...(typeof fields.updated === 'string' ? { updated: fields.updated } : {}),
  }

  // Wikilinks pulled from BOTH body and frontmatter.related (which may be
  // declared as [[slug]] tokens or bare slugs).
  const bodyLinks = extractWikilinks(body)
  const relatedLinks = (frontmatter.related ?? []).map((s) => {
    const m = /^\[\[([^\]]+)\]\]$/.exec(s)
    return m?.[1] ?? s
  }).filter(Boolean)
  const wikilinks = [...new Set([...bodyLinks, ...relatedLinks])]

  return { slug, path, frontmatter, body, wikilinks, fetchedAt }
}

// === Index extraction — pull every wikilink from index.md so the registry
// knows which slugs to warm. ===

export const extractIndexSlugs = (indexMd: string): ReadonlyArray<string> =>
  extractWikilinks(indexMd)
