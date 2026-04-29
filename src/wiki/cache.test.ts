import { describe, it, expect } from 'bun:test'
import { createWikiCache } from './cache.ts'
import type { WikiPage } from './types.ts'

const page = (slug: string, fetchedAt: number): WikiPage => ({
  slug, path: `wiki/${slug}.md`, body: '', wikilinks: [],
  frontmatter: { title: slug }, fetchedAt,
})

describe('createWikiCache', () => {
  it('stores and retrieves within TTL', () => {
    let t = 1000
    const cache = createWikiCache({ ttlMs: 5000, now: () => t })
    cache.put('w', page('a', 1000))
    expect(cache.get('w', 'a')?.slug).toBe('a')
    t = 5500
    expect(cache.get('w', 'a')?.slug).toBe('a')
    t = 7000
    expect(cache.get('w', 'a')).toBeUndefined()
  })

  it('isolates wikis', () => {
    const cache = createWikiCache({ ttlMs: 1000 })
    cache.put('w1', page('a', Date.now()))
    cache.put('w2', page('b', Date.now()))
    expect(cache.get('w1', 'b')).toBeUndefined()
    expect(cache.get('w2', 'b')?.slug).toBe('b')
    expect(cache.size('w1')).toBe(1)
    expect(cache.size('w2')).toBe(1)
  })

  it('clear evicts wiki entries', () => {
    const cache = createWikiCache({ ttlMs: 1000 })
    cache.put('w', page('a', Date.now()))
    cache.clear('w')
    expect(cache.get('w', 'a')).toBeUndefined()
    expect(cache.size('w')).toBe(0)
  })

  it('listPages omits stale entries', () => {
    let t = 1000
    const cache = createWikiCache({ ttlMs: 1000, now: () => t })
    cache.put('w', page('a', 500))   // fetched at 500, TTL 1000 → expired at t=1501
    cache.put('w', page('b', 1000))
    expect(cache.listPages('w').map((p) => p.slug).sort()).toEqual(['a', 'b'])
    t = 2000
    expect(cache.listPages('w').map((p) => p.slug).sort()).toEqual(['b'])
  })
})
