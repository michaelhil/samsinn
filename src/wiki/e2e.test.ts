// ============================================================================
// Wiki[network] — end-to-end test against the real michaelhil/nuclear-wiki
// repo on GitHub. Filtered out of normal `bun test` runs the same way Ollama
// integration tests are: by name. To skip, use:
//
//   bun test -t '^(?!.*(Ollama|Wiki\[network\]))'
//
// or simply omit the file with a path argument. Skipped automatically when
// SAMSINN_SKIP_NETWORK=1 (CI offline path).
// ============================================================================

import { describe, it, expect } from 'bun:test'
import { createWikiRegistry } from './registry.ts'
import { createGithubAdapter } from './github-adapter.ts'
import { buildWikisCatalog } from './catalog.ts'
import type { MergedWikiEntry } from './types.ts'

const SKIP = process.env.SAMSINN_SKIP_NETWORK === '1'

const wiki: MergedWikiEntry = {
  id: 'nuclear',
  owner: 'michaelhil',
  repo: 'nuclear-wiki',
  ref: 'main',
  displayName: 'Nuclear AI',
  apiKey: process.env.SAMSINN_GH_TOKEN ?? '',
  maskedKey: '',
  enabled: true,
}

const itNet = SKIP ? it.skip : it

describe('Wiki[network] — michaelhil/nuclear-wiki', () => {
  itNet('warms cache, search, getPage, catalog round-trip', async () => {
    const reg = createWikiRegistry({ wikis: [wiki], adapterFactory: createGithubAdapter })
    const { pageCount, warnings } = await reg.warm('nuclear')
    if (warnings.length > 0) console.warn(`[warm warnings] ${warnings.length}`)
    expect(pageCount).toBeGreaterThan(0)

    const list = reg.list()
    expect(list[0]?.id).toBe('nuclear')
    expect(list[0]?.pageCount).toBe(pageCount)

    // Search returns ranked hits.
    const hits = reg.search('hallucination', { limit: 5 })
    expect(hits.length).toBeGreaterThan(0)

    // Get the top hit's full page.
    const top = hits[0]!
    const page = await reg.getPage(top.wikiId, top.slug)
    expect(page).toBeDefined()
    expect(page?.frontmatter.title.length).toBeGreaterThan(0)
    expect(page?.body.length).toBeGreaterThan(0)

    // Catalog text mentions the wiki and includes index content.
    const cat = buildWikisCatalog(reg, ['nuclear'])
    expect(cat.text).toContain('Nuclear AI')
    expect(cat.text).toContain('Vetted knowledge')
  }, 60_000)
})
