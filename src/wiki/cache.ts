// ============================================================================
// Wiki cache — TTL freshness check on top of an unbounded Map per wiki.
//
// "LRU" was on the original plan but a wiki of typical size (≤200 pages) fits
// comfortably in memory; eviction would just force re-fetches. We instead
// cap by wiki count (one Map per wiki) and treat TTL as the only invalidation.
// `clear(wikiId)` is exposed for manual refresh.
// ============================================================================

import type { WikiPage } from './types.ts'

export interface WikiCache {
  readonly get: (wikiId: string, slug: string) => WikiPage | undefined
  readonly put: (wikiId: string, page: WikiPage) => void
  readonly listSlugs: (wikiId: string) => ReadonlyArray<string>
  readonly listPages: (wikiId: string) => ReadonlyArray<WikiPage>
  readonly clear: (wikiId: string) => void
  readonly clearAll: () => void
  readonly size: (wikiId: string) => number
}

export interface WikiCacheOptions {
  readonly ttlMs: number          // entries older than this are treated as missing
  readonly now?: () => number     // injectable for tests
}

export const createWikiCache = (opts: WikiCacheOptions): WikiCache => {
  const now = opts.now ?? (() => Date.now())
  const stores = new Map<string, Map<string, WikiPage>>()

  const storeFor = (wikiId: string): Map<string, WikiPage> => {
    let s = stores.get(wikiId)
    if (!s) { s = new Map(); stores.set(wikiId, s) }
    return s
  }

  return {
    get: (wikiId, slug) => {
      const page = stores.get(wikiId)?.get(slug)
      if (!page) return undefined
      if (now() - page.fetchedAt > opts.ttlMs) return undefined
      return page
    },
    put: (wikiId, page) => { storeFor(wikiId).set(page.slug, page) },
    listSlugs: (wikiId) => [...(stores.get(wikiId)?.keys() ?? [])],
    listPages: (wikiId) => [...(stores.get(wikiId)?.values() ?? [])]
      .filter((p) => now() - p.fetchedAt <= opts.ttlMs),
    clear: (wikiId) => { stores.delete(wikiId) },
    clearAll: () => { stores.clear() },
    size: (wikiId) => stores.get(wikiId)?.size ?? 0,
  }
}
