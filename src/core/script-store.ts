// ============================================================================
// Script store — filesystem-backed loader.
//
// Layout (mirrors src/skills/loader.ts):
//   $SAMSINN_HOME/scripts/<name>/script.json      ← preferred
//   $SAMSINN_HOME/scripts/<name>.json             ← flat-form (single file)
//
// Each entry is parsed into a Script and registered under <name>. The name
// must match VALID_NAME (lowercase alphanumerics + dash + underscore).
//
// Loading is one-shot: scanScriptDir() at startup populates the store; reload()
// rescans on demand (used after the user drops in a new script). No watchers.
// ============================================================================

import { readdir, readFile, stat } from 'node:fs/promises'
import { join } from 'node:path'
import type { Script, Scene, CastMember, Objective, Signal, SpeechActDef } from './types/script.ts'

const VALID_NAME = /^[a-z0-9][a-z0-9_-]*$/

export interface ScriptStore {
  readonly get: (name: string) => Script | undefined
  readonly list: () => ReadonlyArray<Script>
  readonly reload: () => Promise<ReadonlyArray<string>>   // returns names loaded
}

export const createScriptStore = (baseDir: string): ScriptStore => {
  const scripts = new Map<string, Script>()

  const reload = async (): Promise<ReadonlyArray<string>> => {
    scripts.clear()
    const loaded = await scanScriptDir(baseDir)
    for (const s of loaded) scripts.set(s.name, s)
    return loaded.map(s => s.name)
  }

  return {
    get: (name) => scripts.get(name),
    list: () => [...scripts.values()],
    reload,
  }
}

// === Filesystem scan ===

const scanScriptDir = async (baseDir: string): Promise<ReadonlyArray<Script>> => {
  let entries: string[]
  try {
    entries = await readdir(baseDir)
  } catch {
    return []   // dir absent — empty store
  }

  const out: Script[] = []
  for (const entry of entries) {
    const full = join(baseDir, entry)
    let info
    try { info = await stat(full) } catch { continue }

    let name: string
    let raw: string
    if (info.isDirectory()) {
      if (!VALID_NAME.test(entry)) {
        console.warn(`[scripts] "${entry}": directory name not a valid script name — skipping`)
        continue
      }
      try {
        raw = await readFile(join(full, 'script.json'), 'utf-8')
      } catch {
        continue   // dir without script.json — skip silently
      }
      name = entry
    } else if (info.isFile() && entry.endsWith('.json')) {
      const stem = entry.slice(0, -'.json'.length)
      if (!VALID_NAME.test(stem)) {
        console.warn(`[scripts] "${entry}": filename not a valid script name — skipping`)
        continue
      }
      try {
        raw = await readFile(full, 'utf-8')
      } catch (err) {
        console.warn(`[scripts] "${entry}": read failed — ${err instanceof Error ? err.message : err}`)
        continue
      }
      name = stem
    } else {
      continue
    }

    try {
      const parsed = parseScript(name, raw)
      out.push(parsed)
    } catch (err) {
      console.warn(`[scripts] "${name}": invalid — ${err instanceof Error ? err.message : err}`)
    }
  }

  console.log(`[scripts] ${baseDir}: ${out.length} loaded`)
  return out
}

// === Parsing + validation ===

const parseScript = (name: string, raw: string): Script => {
  let json: unknown
  try {
    json = JSON.parse(raw)
  } catch (err) {
    throw new Error(`invalid JSON: ${err instanceof Error ? err.message : err}`)
  }
  if (!json || typeof json !== 'object') throw new Error('script must be a JSON object')
  const j = json as Record<string, unknown>

  const acts = parseActs(j.acts)
  const cast = parseCast(j.cast)
  const castNames = new Set(cast.map(c => c.name))
  const scenes = parseScenes(j.scenes, castNames, acts)

  return {
    id: crypto.randomUUID(),
    name,
    acts,
    cast,
    scenes,
  }
}

const parseActs = (raw: unknown): Record<string, SpeechActDef> => {
  if (!raw || typeof raw !== 'object') throw new Error('acts: must be an object')
  const out: Record<string, SpeechActDef> = {}
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof v === 'string') {
      out[k] = { name: k, description: v }
    } else if (v && typeof v === 'object' && typeof (v as { description?: unknown }).description === 'string') {
      out[k] = { name: k, description: (v as { description: string }).description }
    } else {
      throw new Error(`acts.${k}: expected string description or { description: string }`)
    }
  }
  if (Object.keys(out).length === 0) throw new Error('acts: must declare at least one speech-act')
  return out
}

const parseCast = (raw: unknown): ReadonlyArray<CastMember> => {
  if (!raw || typeof raw !== 'object') throw new Error('cast: must be an object')
  const out: CastMember[] = []
  for (const [castName, v] of Object.entries(raw as Record<string, unknown>)) {
    if (!v || typeof v !== 'object') throw new Error(`cast.${castName}: must be an object`)
    const c = v as Record<string, unknown>
    const kind = c.kind === 'human' ? 'human' : 'ai'
    if (kind === 'ai') {
      const cfg = c.agentConfig
      if (!cfg || typeof cfg !== 'object') {
        throw new Error(`cast.${castName}: ai cast requires agentConfig`)
      }
      const ag = cfg as Record<string, unknown>
      if (typeof ag.model !== 'string' || typeof ag.persona !== 'string') {
        throw new Error(`cast.${castName}.agentConfig: model and persona are required`)
      }
      out.push({
        name: castName,
        kind: 'ai',
        agentConfig: { ...ag, name: castName } as CastMember['agentConfig'],
      })
    } else {
      out.push({
        name: castName,
        kind: 'human',
        ...(typeof c.humanAgentName === 'string' ? { humanAgentName: c.humanAgentName } : {}),
      })
    }
  }
  if (out.length === 0) throw new Error('cast: must declare at least one member')
  return out
}

const parseScenes = (
  raw: unknown,
  castNames: ReadonlySet<string>,
  acts: Readonly<Record<string, SpeechActDef>>,
): ReadonlyArray<Scene> => {
  if (!Array.isArray(raw) || raw.length === 0) {
    throw new Error('scenes: must be a non-empty array')
  }
  return raw.map((s, i) => parseScene(s, i, castNames, acts))
}

const parseScene = (
  raw: unknown,
  index: number,
  castNames: ReadonlySet<string>,
  acts: Readonly<Record<string, SpeechActDef>>,
): Scene => {
  if (!raw || typeof raw !== 'object') throw new Error(`scenes[${index}]: must be an object`)
  const s = raw as Record<string, unknown>
  if (typeof s.setup !== 'string') throw new Error(`scenes[${index}].setup: required string`)
  if (!Array.isArray(s.present) || s.present.length === 0) {
    throw new Error(`scenes[${index}].present: required non-empty string array`)
  }
  const present: string[] = []
  for (const n of s.present) {
    if (typeof n !== 'string' || !castNames.has(n)) {
      throw new Error(`scenes[${index}].present: "${String(n)}" not in cast`)
    }
    present.push(n)
  }
  if (!s.objectives || typeof s.objectives !== 'object') {
    throw new Error(`scenes[${index}].objectives: required object keyed by cast name`)
  }
  const objectives: Record<string, Objective> = {}
  for (const [castName, obj] of Object.entries(s.objectives as Record<string, unknown>)) {
    if (!present.includes(castName)) {
      throw new Error(`scenes[${index}].objectives: "${castName}" not in this scene's present list`)
    }
    objectives[castName] = parseObjective(obj, `scenes[${index}].objectives.${castName}`, castNames, acts)
  }
  // Each present character must have an objective
  for (const n of present) {
    if (!objectives[n]) {
      throw new Error(`scenes[${index}].objectives.${n}: missing objective for present character`)
    }
  }
  return { setup: s.setup, present, objectives }
}

const parseObjective = (
  raw: unknown,
  path: string,
  castNames: ReadonlySet<string>,
  acts: Readonly<Record<string, SpeechActDef>>,
): Objective => {
  if (!raw || typeof raw !== 'object') throw new Error(`${path}: must be an object`)
  const o = raw as Record<string, unknown>
  if (typeof o.want !== 'string' || o.want.trim() === '') {
    throw new Error(`${path}.want: required non-empty string`)
  }
  return { want: o.want, signal: parseSignal(o.signal, `${path}.signal`, castNames, acts) }
}

const parseSignal = (
  raw: unknown,
  path: string,
  castNames: ReadonlySet<string>,
  acts: Readonly<Record<string, SpeechActDef>>,
): Signal => {
  if (!raw || typeof raw !== 'object') throw new Error(`${path}: must be an object`)
  const s = raw as Record<string, unknown>
  if (Array.isArray(s.any_of)) {
    if (s.any_of.length === 0) throw new Error(`${path}.any_of: must be non-empty`)
    return { any_of: s.any_of.map((sub, i) => parseSignal(sub, `${path}.any_of[${i}]`, castNames, acts)) }
  }
  if (s.acts && typeof s.acts === 'object') {
    const out: Record<string, ReadonlyArray<string>> = {}
    for (const [castName, list] of Object.entries(s.acts as Record<string, unknown>)) {
      if (!castNames.has(castName)) throw new Error(`${path}.acts: "${castName}" not in cast`)
      if (!Array.isArray(list) || list.length === 0) {
        throw new Error(`${path}.acts.${castName}: must be non-empty string array`)
      }
      const acts2: string[] = []
      for (const a of list) {
        if (typeof a !== 'string' || !acts[a]) {
          throw new Error(`${path}.acts.${castName}: "${String(a)}" not in glossary`)
        }
        acts2.push(a)
      }
      out[castName] = acts2
    }
    return { acts: out }
  }
  if (s.status && typeof s.status === 'object') {
    const out: Record<string, 'met' | 'abandoned'> = {}
    for (const [castName, val] of Object.entries(s.status as Record<string, unknown>)) {
      if (!castNames.has(castName)) throw new Error(`${path}.status: "${castName}" not in cast`)
      if (val !== 'met' && val !== 'abandoned') {
        throw new Error(`${path}.status.${castName}: must be "met" or "abandoned"`)
      }
      out[castName] = val
    }
    return { status: out }
  }
  throw new Error(`${path}: must be { acts }, { status }, or { any_of: [...] }`)
}
