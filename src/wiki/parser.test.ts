import { describe, it, expect } from 'bun:test'
import { parseWikiPage, extractIndexSlugs } from './parser.ts'

describe('parseWikiPage', () => {
  it('parses full frontmatter', () => {
    const text = `---
title: "Rod Withdrawal"
type: scenario
sources:
  - raw/reports/report3.md
  - raw/reports/report5.md
related:
  - "[[defense-in-depth]]"
  - reactor-protection-system
tags:
  - safety
  - operations
confidence: high
created: 2026-04-13
updated: 2026-04-20
---

A scenario describing [[unplanned-rod-withdrawal]] during [[reactor-startup]].

See also [[scram-procedure|the SCRAM]].
`
    const page = parseWikiPage('wiki/scenarios/scenario-rod-withdrawal.md', text, 1000)
    expect(page.slug).toBe('scenario-rod-withdrawal')
    expect(page.path).toBe('wiki/scenarios/scenario-rod-withdrawal.md')
    expect(page.frontmatter.title).toBe('Rod Withdrawal')
    expect(page.frontmatter.type).toBe('scenario')
    expect(page.frontmatter.sources).toEqual(['raw/reports/report3.md', 'raw/reports/report5.md'])
    expect(page.frontmatter.confidence).toBe('high')
    expect(page.frontmatter.tags).toEqual(['safety', 'operations'])
    expect(page.frontmatter.related).toEqual(['[[defense-in-depth]]', 'reactor-protection-system'])
    expect(page.wikilinks).toContain('unplanned-rod-withdrawal')
    expect(page.wikilinks).toContain('reactor-startup')
    expect(page.wikilinks).toContain('scram-procedure')
    expect(page.wikilinks).toContain('defense-in-depth')
    expect(page.wikilinks).toContain('reactor-protection-system')
    expect(page.body).toContain('A scenario describing')
    expect(page.fetchedAt).toBe(1000)
  })

  it('handles missing frontmatter — derives title from slug', () => {
    const page = parseWikiPage('wiki/foo.md', 'just body text\n')
    expect(page.frontmatter.title).toBe('foo')
    expect(page.body).toBe('just body text\n')
    expect(page.wikilinks).toEqual([])
  })

  it('handles inline list syntax', () => {
    const text = `---
title: Test
tags: [a, b, "c d"]
---
body`
    const page = parseWikiPage('wiki/test.md', text)
    expect(page.frontmatter.tags).toEqual(['a', 'b', 'c d'])
  })

  it('extracts wikilinks deduplicated', () => {
    const text = `---
title: t
---
[[x]] and [[x]] and [[y]]`
    const page = parseWikiPage('wiki/p.md', text)
    expect(page.wikilinks.slice().sort()).toEqual(['x', 'y'])
  })

  it('strips wikilink display text', () => {
    const text = `---
title: t
---
[[real-target|display]]`
    const page = parseWikiPage('wiki/p.md', text)
    expect(page.wikilinks).toEqual(['real-target'])
  })

  it('ignores invalid confidence values', () => {
    const text = `---
title: t
confidence: maybe
---
body`
    const page = parseWikiPage('wiki/p.md', text)
    expect(page.frontmatter.confidence).toBeUndefined()
  })
})

describe('extractIndexSlugs', () => {
  it('pulls every [[slug]] from index.md text', () => {
    const indexMd = `# Wiki Index

## Concepts
- [[transformer-architecture]] — Attention etc.
- [[tokenization]] — How text becomes tokens

## Entities
- [[nrc]] — U.S. NRC
- [[crewai|CrewAI]] — Multi-agent framework
`
    const slugs = extractIndexSlugs(indexMd)
    expect(slugs.slice().sort()).toEqual(['crewai', 'nrc', 'tokenization', 'transformer-architecture'])
  })
})
