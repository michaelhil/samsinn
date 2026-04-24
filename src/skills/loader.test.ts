// ============================================================================
// Skill loader — frontmatter parsing + `allowed-tools` dedup-warn tests.
//
// The parser tests are pure string-in/string-out. The warn test uses a temp
// directory with a real SKILL.md to exercise loadSkills end-to-end.
// ============================================================================

import { describe, test, expect } from 'bun:test'
import { join } from 'node:path'
import { mkdtemp, writeFile, mkdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { parseFrontmatter, loadSkills, createSkillStore } from './loader.ts'
import { createToolRegistry } from '../core/tool-registry.ts'

describe('parseFrontmatter — allowed-tools', () => {
  test('parses inline array form', () => {
    const { frontmatter } = parseFrontmatter(`---
name: foo
description: test
allowed-tools: [web_search, read_file]
---
body`)
    expect(frontmatter.allowedTools).toEqual(['web_search', 'read_file'])
  })

  test('parses YAML block list with 2-space indent', () => {
    const { frontmatter } = parseFrontmatter(`---
name: foo
description: test
allowed-tools:
  - web_search
  - read_file
---
body`)
    expect(frontmatter.allowedTools).toEqual(['web_search', 'read_file'])
  })

  test('parses YAML block list with 0-space indent', () => {
    const { frontmatter } = parseFrontmatter(`---
name: foo
description: test
allowed-tools:
- web_search
- read_file
---
body`)
    expect(frontmatter.allowedTools).toEqual(['web_search', 'read_file'])
  })

  test('missing allowed-tools stays undefined', () => {
    const { frontmatter } = parseFrontmatter(`---
name: foo
description: test
---
body`)
    expect(frontmatter.allowedTools).toBeUndefined()
  })

  test('empty block list becomes empty array', () => {
    const { frontmatter } = parseFrontmatter(`---
name: foo
description: test
allowed-tools:
---
body`)
    expect(frontmatter.allowedTools).toEqual([])
  })

  test('inline scalar becomes single-element array', () => {
    const { frontmatter } = parseFrontmatter(`---
name: foo
description: test
allowed-tools: web_search
---
body`)
    expect(frontmatter.allowedTools).toEqual(['web_search'])
  })

  test('does not consume following key lines as block items', () => {
    const { frontmatter } = parseFrontmatter(`---
name: foo
description: test
allowed-tools:
  - a
scope: my-room
---
body`)
    expect(frontmatter.allowedTools).toEqual(['a'])
    expect(frontmatter.scope).toEqual(['my-room'])
  })

  test('body parses correctly after block-list field', () => {
    const { body } = parseFrontmatter(`---
name: foo
description: test
allowed-tools:
  - a
  - b
---
# Body heading

content`)
    expect(body).toBe('# Body heading\n\ncontent')
  })
})

describe('parseFrontmatter — scope backwards compatibility', () => {
  test('scope inline scalar still wraps into array', () => {
    const { frontmatter } = parseFrontmatter(`---
name: foo
description: test
scope: my-room
---
body`)
    expect(frontmatter.scope).toEqual(['my-room'])
  })

  test('scope inline array', () => {
    const { frontmatter } = parseFrontmatter(`---
name: foo
description: test
scope: [room-a, room-b]
---
body`)
    expect(frontmatter.scope).toEqual(['room-a', 'room-b'])
  })

  test('scope block list (new path via parseYAMLArrayField)', () => {
    const { frontmatter } = parseFrontmatter(`---
name: foo
description: test
scope:
  - room-a
  - room-b
---
body`)
    expect(frontmatter.scope).toEqual(['room-a', 'room-b'])
  })
})

describe('loadSkills — allowed-tools dedup-warn', () => {
  const makeSkillDir = async (dirRoot: string, name: string, frontmatter: string) => {
    const skillDir = join(dirRoot, name)
    await mkdir(skillDir, { recursive: true })
    await writeFile(join(skillDir, 'SKILL.md'), frontmatter)
    return skillDir
  }

  test('Skill.allowedToolNames is populated from frontmatter', async () => {
    const base = await mkdtemp(join(tmpdir(), 'samsinn-skills-test-'))
    try {
      await makeSkillDir(base, 'alpha', `---
name: alpha
description: test
allowed-tools: [a, b]
---
body`)

      const registry = createToolRegistry()
      const store = createSkillStore()
      const result = await loadSkills(base, store, registry)

      expect(result.loaded).toContain('alpha')
      const skill = store.get('alpha')
      expect(skill?.allowedToolNames).toEqual(['a', 'b'])
    } finally {
      await rm(base, { recursive: true })
    }
  })

  test('unknown allowed-tools emit exactly one warn line per skill', async () => {
    const base = await mkdtemp(join(tmpdir(), 'samsinn-skills-test-'))
    const warnings: string[] = []
    const originalWarn = console.warn
    console.warn = (msg: unknown) => { warnings.push(String(msg)) }

    try {
      await makeSkillDir(base, 'bravo', `---
name: bravo
description: test
allowed-tools:
  - missing_one
  - missing_two
  - missing_three
---
body`)

      const registry = createToolRegistry()
      const store = createSkillStore()
      await loadSkills(base, store, registry)

      const warnLines = warnings.filter(w => w.includes('bravo') && w.includes('allowed-tools'))
      expect(warnLines).toHaveLength(1)
      // Single line must list all three missing names
      expect(warnLines[0]).toContain('missing_one')
      expect(warnLines[0]).toContain('missing_two')
      expect(warnLines[0]).toContain('missing_three')
    } finally {
      console.warn = originalWarn
      await rm(base, { recursive: true })
    }
  })

  test('all-known allowed-tools emit no warning', async () => {
    const base = await mkdtemp(join(tmpdir(), 'samsinn-skills-test-'))
    const warnings: string[] = []
    const originalWarn = console.warn
    console.warn = (msg: unknown) => { warnings.push(String(msg)) }

    try {
      await makeSkillDir(base, 'charlie', `---
name: charlie
description: test
allowed-tools: [known_tool]
---
body`)

      const registry = createToolRegistry()
      registry.register({
        name: 'known_tool',
        description: 'stub',
        parameters: {},
        execute: async () => ({ success: true }),
      })
      const store = createSkillStore()
      await loadSkills(base, store, registry)

      const warnLines = warnings.filter(w => w.includes('charlie') && w.includes('allowed-tools'))
      expect(warnLines).toHaveLength(0)
    } finally {
      console.warn = originalWarn
      await rm(base, { recursive: true })
    }
  })

  test('skill without allowed-tools gets empty array, no warning', async () => {
    const base = await mkdtemp(join(tmpdir(), 'samsinn-skills-test-'))
    const warnings: string[] = []
    const originalWarn = console.warn
    console.warn = (msg: unknown) => { warnings.push(String(msg)) }

    try {
      await makeSkillDir(base, 'delta', `---
name: delta
description: test
---
body`)

      const registry = createToolRegistry()
      const store = createSkillStore()
      await loadSkills(base, store, registry)

      const skill = store.get('delta')
      expect(skill?.allowedToolNames).toEqual([])
      const warnLines = warnings.filter(w => w.includes('delta') && w.includes('allowed-tools'))
      expect(warnLines).toHaveLength(0)
    } finally {
      console.warn = originalWarn
      await rm(base, { recursive: true })
    }
  })
})
