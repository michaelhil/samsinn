import { describe, it, expect } from 'bun:test'
import { createWikiTools } from './wiki-tools.ts'
import { createWikiRegistry } from '../../wiki/registry.ts'
import type { WikiAdapter } from '../../wiki/github-adapter.ts'
import type { ToolContext } from '../../core/types/tool.ts'

const ctx: ToolContext = { callerId: 'a', callerName: 'A' }

const adapter: WikiAdapter = {
  fetchIndex: async () => `# Index\n- [[scenario-rod]]\n- [[transformer]]\n`,
  fetchScope: async () => undefined,
  fetchPage: async (slug) => {
    const map: Record<string, string> = {
      'scenario-rod': `---\ntitle: Rod Scenario\ntype: scenario\ntags: [safety]\n---\nDescribes rod withdrawal during reactor startup.`,
      transformer: `---\ntitle: Transformer\ntype: concept\n---\nAttention is all you need.`,
    }
    if (!map[slug]) throw new Error(`not found: ${slug}`)
    return { path: `wiki/${slug}.md`, body: map[slug] }
  },
  listWikiTree: async () => [`wiki/scenario-rod.md`, `wiki/transformer.md`],
}

const makeRegistry = async () => {
  const reg = createWikiRegistry({
    wikis: [{ id: 'nuclear', owner: 'o', repo: 'r', ref: 'main', displayName: 'Nuclear', apiKey: '', maskedKey: '', enabled: true }],
    adapterFactory: () => adapter,
  })
  await reg.warm('nuclear')
  return reg
}

describe('wiki tools', () => {
  it('wiki_list returns warmed wikis', async () => {
    const reg = await makeRegistry()
    const [list] = createWikiTools(reg)
    const r = await list!.execute({}, ctx)
    expect(r.success).toBe(true)
    expect((r.data as Array<{ id: string; pageCount: number }>)[0]).toMatchObject({ id: 'nuclear', pageCount: 2 })
  })

  it('wiki_search returns hits', async () => {
    const reg = await makeRegistry()
    const [, search] = createWikiTools(reg)
    const r = await search!.execute({ query: 'rod' }, ctx)
    expect(r.success).toBe(true)
    const hits = r.data as Array<{ slug: string }>
    expect(hits.find((h) => h.slug === 'scenario-rod')).toBeDefined()
  })

  it('wiki_search rejects unknown wikiId', async () => {
    const reg = await makeRegistry()
    const [, search] = createWikiTools(reg)
    const r = await search!.execute({ query: 'x', wikiId: 'nope' }, ctx)
    expect(r.success).toBe(false)
    expect(r.error).toContain('unknown wikiId')
  })

  it('wiki_get_page returns full page', async () => {
    const reg = await makeRegistry()
    const [, , get] = createWikiTools(reg)
    const r = await get!.execute({ wikiId: 'nuclear', slug: 'transformer' }, ctx)
    expect(r.success).toBe(true)
    const data = r.data as { frontmatter: { title: string }; body: string }
    expect(data.frontmatter.title).toBe('Transformer')
    expect(data.body).toContain('Attention')
  })

  it('wiki_get_page errors on missing args', async () => {
    const reg = await makeRegistry()
    const [, , get] = createWikiTools(reg)
    const r = await get!.execute({}, ctx)
    expect(r.success).toBe(false)
  })
})
