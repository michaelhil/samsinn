// ============================================================================
// Wiki registry — owns the wikis configured by the operator and exposes the
// query surface the tools + context-builder need.
//
// On `warm(wikiId)` (called at register time and on manual refresh) the
// registry fetches index.md, scope.md, and every page slug listed in index.md
// into the cache. Subsequent `getPage`/`search` reads from the cache.
//
// Search is in-memory across the warmed pages of a single wiki (or all).
// Returns `WikiError` thrown by the adapter on transport failures.
// ============================================================================

import type { MergedWikiEntry, WikiPage, WikiState } from './types.ts'
import type { WikiAdapter } from './github-adapter.ts'
import type { WikiCache } from './cache.ts'
import { createGithubAdapter } from './github-adapter.ts'
import { createWikiCache } from './cache.ts'
import { parseWikiPage, extractIndexSlugs } from './parser.ts'

export interface WikiSearchHit {
  readonly wikiId: string
  readonly slug: string
  readonly title: string
  readonly type?: string
  readonly tags?: ReadonlyArray<string>
  readonly confidence?: 'high' | 'medium' | 'low'
  readonly snippet: string
  readonly score: number
}

export interface WikiSearchOptions {
  readonly wikiId?: string
  readonly type?: string
  readonly tag?: string
  readonly limit?: number
}

export interface WikiListEntry {
  readonly id: string
  readonly displayName: string
  readonly pageCount: number
  readonly lastWarmAt?: number
  readonly lastError?: string
}

export interface WikiRegistry {
  readonly setWikis: (wikis: ReadonlyArray<MergedWikiEntry>) => void
  readonly addWiki: (wiki: MergedWikiEntry) => void
  readonly removeWiki: (id: string) => void
  readonly warm: (wikiId: string) => Promise<{ pageCount: number; warnings: ReadonlyArray<string> }>
  readonly list: () => ReadonlyArray<WikiListEntry>
  readonly hasWiki: (id: string) => boolean
  readonly getIndex: (id: string) => string | undefined
  readonly getScope: (id: string) => string | undefined
  readonly getPage: (id: string, slug: string) => Promise<WikiPage | undefined>
  readonly search: (query: string, opts?: WikiSearchOptions) => ReadonlyArray<WikiSearchHit>
  readonly getState: (id: string) => WikiState | undefined
}

export interface WikiRegistryOptions {
  readonly wikis: ReadonlyArray<MergedWikiEntry>
  readonly ttlMs?: number
  readonly cache?: WikiCache
  readonly adapterFactory?: (wiki: MergedWikiEntry) => WikiAdapter   // injectable for tests
}

interface InternalState {
  readonly wiki: MergedWikiEntry
  readonly adapter: WikiAdapter
  indexMd?: string
  scopeMd?: string
  lastWarmAt?: number
  lastError?: string
}

export const createWikiRegistry = (opts: WikiRegistryOptions): WikiRegistry => {
  const cache = opts.cache ?? createWikiCache({ ttlMs: opts.ttlMs ?? 24 * 60 * 60 * 1000 })
  const factory = opts.adapterFactory ?? createGithubAdapter
  const states = new Map<string, InternalState>()

  const installWiki = (wiki: MergedWikiEntry): void => {
    states.set(wiki.id, { wiki, adapter: factory(wiki) })
  }

  for (const w of opts.wikis) installWiki(w)

  const setWikis: WikiRegistry['setWikis'] = (wikis) => {
    const newIds = new Set(wikis.map((w) => w.id))
    for (const id of [...states.keys()]) {
      if (!newIds.has(id)) { states.delete(id); cache.clear(id) }
    }
    for (const w of wikis) {
      const existing = states.get(w.id)
      // Re-install if config changed (new ref/PAT/etc).
      if (!existing
        || existing.wiki.owner !== w.owner
        || existing.wiki.repo !== w.repo
        || existing.wiki.ref !== w.ref
        || existing.wiki.apiKey !== w.apiKey) {
        cache.clear(w.id)
        installWiki(w)
      }
    }
  }

  const addWiki: WikiRegistry['addWiki'] = (wiki) => { installWiki(wiki); cache.clear(wiki.id) }

  const removeWiki: WikiRegistry['removeWiki'] = (id) => { states.delete(id); cache.clear(id) }

  const warm: WikiRegistry['warm'] = async (wikiId) => {
    const s = states.get(wikiId)
    if (!s) throw new Error(`unknown wiki: ${wikiId}`)
    cache.clear(wikiId)
    const warnings: string[] = []
    s.lastError = undefined

    s.indexMd = await s.adapter.fetchIndex()
    try { s.scopeMd = await s.adapter.fetchScope() } catch (err) {
      warnings.push(`scope.md skipped: ${(err as Error).message}`)
      s.scopeMd = undefined
    }
    const slugs = extractIndexSlugs(s.indexMd)
    let okCount = 0
    for (const slug of slugs) {
      try {
        const { path, body } = await s.adapter.fetchPage(slug)
        cache.put(wikiId, parseWikiPage(path, body))
        okCount += 1
      } catch (err) {
        warnings.push(`page ${slug}: ${(err as Error).message}`)
      }
    }
    s.lastWarmAt = Date.now()
    return { pageCount: okCount, warnings }
  }

  const getPage: WikiRegistry['getPage'] = async (id, slug) => {
    const s = states.get(id)
    if (!s) return undefined
    const cached = cache.get(id, slug)
    if (cached) return cached
    try {
      const { path, body } = await s.adapter.fetchPage(slug)
      const page = parseWikiPage(path, body)
      cache.put(id, page)
      return page
    } catch (err) {
      s.lastError = (err as Error).message
      throw err
    }
  }

  const search: WikiRegistry['search'] = (query, opts2 = {}) => {
    const q = query.trim().toLowerCase()
    const limit = opts2.limit ?? 10
    const targets = opts2.wikiId
      ? (states.has(opts2.wikiId) ? [opts2.wikiId] : [])
      : [...states.keys()]
    const hits: WikiSearchHit[] = []
    for (const id of targets) {
      for (const page of cache.listPages(id)) {
        if (opts2.type && page.frontmatter.type !== opts2.type) continue
        if (opts2.tag && !(page.frontmatter.tags ?? []).includes(opts2.tag)) continue
        const score = scorePage(page, q)
        if (score <= 0 && q.length > 0) continue
        hits.push({
          wikiId: id,
          slug: page.slug,
          title: page.frontmatter.title,
          ...(page.frontmatter.type ? { type: page.frontmatter.type } : {}),
          ...(page.frontmatter.tags ? { tags: page.frontmatter.tags } : {}),
          ...(page.frontmatter.confidence ? { confidence: page.frontmatter.confidence } : {}),
          snippet: snippetAround(page.body, q),
          score,
        })
      }
    }
    hits.sort((a, b) => b.score - a.score)
    return hits.slice(0, limit)
  }

  const list: WikiRegistry['list'] = () =>
    [...states.values()].map((s) => ({
      id: s.wiki.id,
      displayName: s.wiki.displayName,
      pageCount: cache.size(s.wiki.id),
      ...(s.lastWarmAt !== undefined ? { lastWarmAt: s.lastWarmAt } : {}),
      ...(s.lastError !== undefined ? { lastError: s.lastError } : {}),
    }))

  return {
    setWikis,
    addWiki,
    removeWiki,
    warm,
    list,
    hasWiki: (id) => states.has(id),
    getIndex: (id) => states.get(id)?.indexMd,
    getScope: (id) => states.get(id)?.scopeMd,
    getPage,
    search,
    getState: (id) => {
      const s = states.get(id)
      if (!s) return undefined
      const pageMap = new Map<string, WikiPage>()
      for (const p of cache.listPages(id)) pageMap.set(p.slug, p)
      return {
        id: s.wiki.id,
        displayName: s.wiki.displayName,
        ...(s.indexMd !== undefined ? { indexMd: s.indexMd } : {}),
        ...(s.scopeMd !== undefined ? { scopeMd: s.scopeMd } : {}),
        pages: pageMap,
        ...(s.lastWarmAt !== undefined ? { lastWarmAt: s.lastWarmAt } : {}),
        ...(s.lastError !== undefined ? { lastError: s.lastError } : {}),
      }
    },
  }
}

// === Scoring + snippet ===

const scorePage = (page: WikiPage, q: string): number => {
  if (!q) return 1
  const title = page.frontmatter.title.toLowerCase()
  const slug = page.slug.toLowerCase()
  const body = page.body.toLowerCase()
  const tags = (page.frontmatter.tags ?? []).map((t) => t.toLowerCase())

  let score = 0
  if (slug === q) score += 100
  if (title === q) score += 80
  if (slug.includes(q)) score += 30
  if (title.includes(q)) score += 20
  if (tags.some((t) => t === q)) score += 25
  if (tags.some((t) => t.includes(q))) score += 5
  // Body occurrences: cap to avoid one big page dominating.
  const bodyHits = body.split(q).length - 1
  score += Math.min(bodyHits, 5) * 2
  return score
}

const snippetAround = (body: string, q: string, len = 200): string => {
  if (!q) return body.slice(0, len)
  const idx = body.toLowerCase().indexOf(q)
  if (idx < 0) return body.slice(0, len)
  const start = Math.max(0, idx - 60)
  return (start > 0 ? '…' : '') + body.slice(start, start + len).replace(/\s+/g, ' ').trim() + (start + len < body.length ? '…' : '')
}
