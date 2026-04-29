// ============================================================================
// Wiki store — persistent, file-backed wiki configuration.
//
// Stored at ~/.samsinn/wikis.json (mode 0600). Mirrors the providers-store
// pattern: STORE_VERSION constant, atomic tmp+rename write, perm warning on
// load. Never logs apiKey values; use maskKey() for display.
//
// Bindings (room↔wiki, agent↔wiki) are NOT stored here — they live in the
// snapshot. This file is for connection config only.
// ============================================================================

import { readFile, writeFile, rename, chmod, mkdir, stat } from 'node:fs/promises'
import { dirname } from 'node:path'
import { maskKey } from '../llm/providers-store.ts'
import type { WikiConfig, MergedWikiEntry } from './types.ts'

export const STORE_VERSION = 1

export interface WikisFileShape {
  readonly version: number
  readonly wikis: ReadonlyArray<WikiConfig>
}

const EMPTY: WikisFileShape = { version: STORE_VERSION, wikis: [] }

export interface LoadResult {
  readonly data: WikisFileShape
  readonly warnings: ReadonlyArray<string>
}

export const loadWikiStore = async (path: string): Promise<LoadResult> => {
  const warnings: string[] = []
  let raw: string
  try {
    raw = await readFile(path, 'utf-8')
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return { data: EMPTY, warnings }
    warnings.push(`wikis.json read failed: ${(err as Error).message}`)
    return { data: EMPTY, warnings }
  }

  try {
    const s = await stat(path)
    const mode = s.mode & 0o777
    if (mode & 0o077) {
      warnings.push(`wikis.json has permissive mode 0${mode.toString(8)} — recommend 0600 (chmod 600 ${path})`)
    }
  } catch { /* non-fatal */ }

  let parsed: unknown
  try { parsed = JSON.parse(raw) } catch (err) {
    warnings.push(`wikis.json is not valid JSON: ${(err as Error).message}`)
    return { data: EMPTY, warnings }
  }

  const data = validateShape(parsed, warnings)
  return { data, warnings }
}

const ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,62}$/

const validateShape = (raw: unknown, warnings: string[]): WikisFileShape => {
  if (typeof raw !== 'object' || raw === null) {
    warnings.push('wikis.json root is not an object — ignoring')
    return EMPTY
  }
  const r = raw as Record<string, unknown>
  const version = typeof r.version === 'number' ? r.version : 0
  if (version !== STORE_VERSION) {
    warnings.push(`wikis.json version ${version} (expected ${STORE_VERSION}) — migration may be required`)
  }
  if (!Array.isArray(r.wikis)) return { version: STORE_VERSION, wikis: [] }

  const seen = new Set<string>()
  const cleaned: WikiConfig[] = []
  for (const item of r.wikis as unknown[]) {
    if (typeof item !== 'object' || item === null) continue
    const w = item as Record<string, unknown>
    const id = typeof w.id === 'string' ? w.id.trim() : ''
    const owner = typeof w.owner === 'string' ? w.owner.trim() : ''
    const repo = typeof w.repo === 'string' ? w.repo.trim() : ''
    if (!id || !owner || !repo) {
      warnings.push(`wikis.json: skipping entry with missing id/owner/repo (${JSON.stringify(item).slice(0, 80)})`)
      continue
    }
    if (!ID_PATTERN.test(id)) {
      warnings.push(`wikis.json: skipping id ${JSON.stringify(id)} — must match ${ID_PATTERN}`)
      continue
    }
    if (seen.has(id)) {
      warnings.push(`wikis.json: duplicate id ${JSON.stringify(id)} — keeping first`)
      continue
    }
    seen.add(id)
    const entry: WikiConfig = {
      id,
      owner,
      repo,
      ...(typeof w.ref === 'string' && w.ref.trim() ? { ref: w.ref.trim() } : {}),
      ...(typeof w.displayName === 'string' && w.displayName.trim() ? { displayName: w.displayName.trim() } : {}),
      ...(typeof w.apiKey === 'string' ? { apiKey: w.apiKey } : {}),
      ...(typeof w.enabled === 'boolean' ? { enabled: w.enabled } : {}),
    }
    cleaned.push(entry)
  }
  return { version: STORE_VERSION, wikis: cleaned }
}

export const saveWikiStore = async (path: string, data: WikisFileShape): Promise<void> => {
  await mkdir(dirname(path), { recursive: true })
  const tmpPath = `${path}.tmp`
  await writeFile(tmpPath, JSON.stringify({ ...data, version: STORE_VERSION }, null, 2), 'utf-8')
  try { await chmod(tmpPath, 0o600) } catch { /* best-effort */ }
  await rename(tmpPath, path)
}

// === Resolve to merged entries (display-ready, defaults applied) ===

export const mergeWikis = (store: WikisFileShape): ReadonlyArray<MergedWikiEntry> =>
  store.wikis.map((w) => ({
    id: w.id,
    owner: w.owner,
    repo: w.repo,
    ref: w.ref ?? 'main',
    displayName: w.displayName ?? `${w.owner}/${w.repo}`,
    apiKey: w.apiKey ?? '',
    maskedKey: maskKey(w.apiKey ?? ''),
    enabled: w.enabled ?? true,
  }))

export const isValidWikiId = (id: string): boolean => ID_PATTERN.test(id)
