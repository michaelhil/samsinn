import { describe, it, expect, beforeEach, afterEach } from 'bun:test'
import { mkdtemp, rm, writeFile, stat, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { loadWikiStore, saveWikiStore, mergeWikis, STORE_VERSION, isValidWikiId } from './store.ts'

let dir: string
let path: string

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'wiki-store-'))
  path = join(dir, 'wikis.json')
})

afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

describe('loadWikiStore', () => {
  it('returns empty when file is missing', async () => {
    const { data, warnings } = await loadWikiStore(path)
    expect(data.wikis).toEqual([])
    expect(data.version).toBe(STORE_VERSION)
    expect(warnings).toEqual([])
  })

  it('parses valid file', async () => {
    const json = JSON.stringify({
      version: 1,
      wikis: [
        { id: 'nuclear', owner: 'michaelhil', repo: 'nuclear-wiki' },
        { id: 'aviation', owner: 'someone', repo: 'aviation', ref: 'develop', apiKey: 'ghp_secret' },
      ],
    })
    await writeFile(path, json, { mode: 0o600 })
    const { data, warnings } = await loadWikiStore(path)
    expect(warnings).toEqual([])
    expect(data.wikis).toHaveLength(2)
    expect(data.wikis[0]?.id).toBe('nuclear')
    expect(data.wikis[1]?.apiKey).toBe('ghp_secret')
    expect(data.wikis[1]?.ref).toBe('develop')
  })

  it('warns on permissive mode', async () => {
    await writeFile(path, JSON.stringify({ version: 1, wikis: [] }), { mode: 0o644 })
    const { warnings } = await loadWikiStore(path)
    expect(warnings.some((w) => w.includes('permissive mode'))).toBe(true)
  })

  it('skips invalid entries with warnings', async () => {
    await writeFile(path, JSON.stringify({
      version: 1,
      wikis: [
        { id: 'good', owner: 'a', repo: 'b' },
        { id: 'BadCase', owner: 'a', repo: 'b' },          // uppercase
        { id: 'no-repo', owner: 'a' },                      // missing repo
        { id: 'good', owner: 'a', repo: 'dup' },            // duplicate id
      ],
    }))
    const { data, warnings } = await loadWikiStore(path)
    expect(data.wikis).toHaveLength(1)
    expect(data.wikis[0]?.id).toBe('good')
    expect(warnings.length).toBeGreaterThanOrEqual(3)
  })

  it('warns on version mismatch', async () => {
    await writeFile(path, JSON.stringify({ version: 99, wikis: [] }))
    const { warnings } = await loadWikiStore(path)
    expect(warnings.some((w) => w.includes('version 99'))).toBe(true)
  })

  it('handles invalid JSON', async () => {
    await writeFile(path, '{not valid')
    const { data, warnings } = await loadWikiStore(path)
    expect(data.wikis).toEqual([])
    expect(warnings.some((w) => w.includes('not valid JSON'))).toBe(true)
  })
})

describe('saveWikiStore', () => {
  it('writes atomically with mode 0600', async () => {
    await saveWikiStore(path, { version: STORE_VERSION, wikis: [{ id: 'n', owner: 'o', repo: 'r' }] })
    const s = await stat(path)
    expect(s.mode & 0o777).toBe(0o600)
    const back = JSON.parse(await readFile(path, 'utf-8'))
    expect(back.wikis[0].id).toBe('n')
  })

  it('round-trips via load', async () => {
    const orig = { version: STORE_VERSION, wikis: [{ id: 'a', owner: 'o', repo: 'r', apiKey: 'k', enabled: false }] }
    await saveWikiStore(path, orig)
    const { data } = await loadWikiStore(path)
    expect(data.wikis[0]).toMatchObject({ id: 'a', apiKey: 'k', enabled: false })
  })
})

describe('mergeWikis', () => {
  it('applies defaults', () => {
    const merged = mergeWikis({ version: 1, wikis: [{ id: 'n', owner: 'o', repo: 'r' }] })
    expect(merged[0]!).toMatchObject({
      ref: 'main',
      displayName: 'o/r',
      apiKey: '',
      maskedKey: '',
      enabled: true,
    })
  })

  it('masks api keys', () => {
    const merged = mergeWikis({ version: 1, wikis: [{ id: 'n', owner: 'o', repo: 'r', apiKey: 'ghp_abcdefg1234' }] })
    expect(merged[0]?.maskedKey).toBe('•••1234')
    expect(merged[0]?.apiKey).toBe('ghp_abcdefg1234')
  })
})

describe('isValidWikiId', () => {
  it('accepts kebab-case alnum', () => {
    expect(isValidWikiId('nuclear')).toBe(true)
    expect(isValidWikiId('a1-b2-c3')).toBe(true)
  })
  it('rejects uppercase, leading dash, or unsupported chars', () => {
    expect(isValidWikiId('Nuclear')).toBe(false)
    expect(isValidWikiId('-leading')).toBe(false)
    expect(isValidWikiId('has_underscore')).toBe(false)
    expect(isValidWikiId('')).toBe(false)
  })
})
