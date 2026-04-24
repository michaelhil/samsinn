// ============================================================================
// Spec-loader tests — structural validation + digest stability.
// ============================================================================

import { describe, test, expect } from 'bun:test'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { loadSpec, validateSpec } from './spec-loader.ts'

const validSpec = `
import type { ExperimentSpec } from '${join(import.meta.dir, 'types.ts')}'
const spec: ExperimentSpec = {
  experiment: 'test',
  base: {
    room: { name: 'r' },
    trigger: { content: 'hi' },
  },
  variants: [{ name: 'baseline', agents: [] }],
  wait: { quietMs: 100, timeoutMs: 1000 },
  outputDir: 'out/test',
}
export default spec
`

describe('validateSpec — structural checks', () => {
  test('rejects non-object', () => {
    expect(() => validateSpec(null)).toThrow('default export must be an object')
  })

  test('rejects missing experiment', () => {
    expect(() => validateSpec({})).toThrow('experiment')
  })

  test('rejects missing base.room.name', () => {
    expect(() => validateSpec({
      experiment: 'x',
      base: { room: {}, trigger: { content: 'hi' } },
      variants: [{ name: 'a', agents: [] }],
      wait: { quietMs: 1, timeoutMs: 1 },
      outputDir: 'o',
    })).toThrow('base.room.name')
  })

  test('rejects empty variants array', () => {
    expect(() => validateSpec({
      experiment: 'x',
      base: { room: { name: 'r' }, trigger: { content: 'hi' } },
      variants: [],
      wait: { quietMs: 1, timeoutMs: 1 },
      outputDir: 'o',
    })).toThrow('non-empty array')
  })

  test('rejects invalid variant name', () => {
    expect(() => validateSpec({
      experiment: 'x',
      base: { room: { name: 'r' }, trigger: { content: 'hi' } },
      variants: [{ name: 'has spaces', agents: [] }],
      wait: { quietMs: 1, timeoutMs: 1 },
      outputDir: 'o',
    })).toThrow('must match')
  })

  test('rejects duplicate variant names', () => {
    expect(() => validateSpec({
      experiment: 'x',
      base: { room: { name: 'r' }, trigger: { content: 'hi' } },
      variants: [{ name: 'a', agents: [] }, { name: 'a', agents: [] }],
      wait: { quietMs: 1, timeoutMs: 1 },
      outputDir: 'o',
    })).toThrow('duplicate variant name')
  })

  test('rejects negative wait.quietMs', () => {
    expect(() => validateSpec({
      experiment: 'x',
      base: { room: { name: 'r' }, trigger: { content: 'hi' } },
      variants: [{ name: 'a', agents: [] }],
      wait: { quietMs: 0, timeoutMs: 1 },
      outputDir: 'o',
    })).toThrow('quietMs')
  })

  test('rejects non-integer repeats', () => {
    expect(() => validateSpec({
      experiment: 'x',
      base: { room: { name: 'r' }, trigger: { content: 'hi' } },
      variants: [{ name: 'a', agents: [] }],
      wait: { quietMs: 1, timeoutMs: 1 },
      outputDir: 'o',
      repeats: 1.5,
    })).toThrow('positive integer')
  })

  test('accepts a minimal valid spec', () => {
    const result = validateSpec({
      experiment: 'x',
      base: { room: { name: 'r' }, trigger: { content: 'hi' } },
      variants: [{ name: 'a', agents: [] }],
      wait: { quietMs: 1, timeoutMs: 1 },
      outputDir: 'o',
    })
    expect(result.experiment).toBe('x')
  })

  test('rejects invalid isolation value', () => {
    expect(() => validateSpec({
      experiment: 'x',
      base: { room: { name: 'r' }, trigger: { content: 'hi' } },
      variants: [{ name: 'a', agents: [] }],
      wait: { quietMs: 1, timeoutMs: 1 },
      outputDir: 'o',
      isolation: 'parallel',
    })).toThrow('isolation')
  })

  test('accepts isolation: reset', () => {
    const result = validateSpec({
      experiment: 'x',
      base: { room: { name: 'r' }, trigger: { content: 'hi' } },
      variants: [{ name: 'a', agents: [] }],
      wait: { quietMs: 1, timeoutMs: 1 },
      outputDir: 'o',
      isolation: 'reset',
    })
    expect(result.isolation).toBe('reset')
  })
})

describe('loadSpec — file import + digest', () => {
  test('loads a valid spec file and returns a stable digest', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'samsinn-spec-test-'))
    try {
      const specPath = join(dir, 'test-spec.ts')
      await writeFile(specPath, validSpec, 'utf-8')

      const first = await loadSpec(specPath)
      expect(first.spec.experiment).toBe('test')
      expect(first.specDigest).toMatch(/^[a-f0-9]{12}$/)
      expect(first.absolutePath).toBe(specPath)

      const second = await loadSpec(specPath)
      expect(second.specDigest).toBe(first.specDigest)
    } finally {
      await rm(dir, { recursive: true })
    }
  })
})
