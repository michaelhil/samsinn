import { describe, it, expect } from 'bun:test'
import { buildWikisCatalog } from './catalog.ts'
import { createWikiRegistry } from './registry.ts'
import type { WikiAdapter } from './github-adapter.ts'

const adapter: WikiAdapter = {
  fetchIndex: async () => `# Index\n- [[a]]\n- [[b]]\n`,
  fetchScope: async () => `# Scope\nNuclear safety topics.`,
  fetchPage: async (slug) => ({ path: `wiki/${slug}.md`, body: `---\ntitle: ${slug}\n---\nbody` }),
  listWikiTree: async () => [`wiki/a.md`, `wiki/b.md`],
}

const wiki = { id: 'nuclear', owner: 'o', repo: 'r', ref: 'main', displayName: 'Nuclear', apiKey: '', maskedKey: '', enabled: true }

describe('buildWikisCatalog', () => {
  it('returns empty text when no wikis bound', async () => {
    const reg = createWikiRegistry({ wikis: [wiki], adapterFactory: () => adapter })
    const r = buildWikisCatalog(reg, [])
    expect(r.text).toBe('')
    expect(r.truncatedWikis).toEqual([])
  })

  it('emits header + index + scope per wiki', async () => {
    const reg = createWikiRegistry({ wikis: [wiki], adapterFactory: () => adapter })
    await reg.warm('nuclear')
    const r = buildWikisCatalog(reg, ['nuclear'])
    expect(r.text).toContain('Vetted knowledge wikis')
    expect(r.text).toContain('Wiki: Nuclear')
    expect(r.text).toContain('[[a]]')
    expect(r.text).toContain('Nuclear safety topics')
    expect(r.truncatedWikis).toEqual([])
  })

  it('truncates and reports', async () => {
    const big = '#'.repeat(10_000)
    const bigAdapter: WikiAdapter = {
      ...adapter,
      fetchIndex: async () => big,
      fetchScope: async () => big,
    }
    const reg = createWikiRegistry({ wikis: [wiki], adapterFactory: () => bigAdapter })
    await reg.warm('nuclear')
    const r = buildWikisCatalog(reg, ['nuclear'], { maxIndexChars: 50, maxScopeChars: 50 })
    expect(r.text).toContain('[truncated]')
    expect(r.truncatedWikis).toEqual(['nuclear'])
  })

  it('skips unknown ids silently', async () => {
    const reg = createWikiRegistry({ wikis: [wiki], adapterFactory: () => adapter })
    await reg.warm('nuclear')
    const r = buildWikisCatalog(reg, ['nuclear', 'missing'])
    expect(r.text).toContain('Wiki: Nuclear')
    expect(r.text).not.toContain('missing')
  })
})
