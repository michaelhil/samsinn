// ============================================================================
// Spec loader — dynamic import + structural validation + content digest.
//
// Spec files are TypeScript modules that default-export an ExperimentSpec.
// Validation here is structural only (required fields, variant-name format);
// the TypeScript compiler is the primary type guard — loadSpec runs at
// runtime too, catching specs that were silently `as` or `any`-cast.
// ============================================================================

import { readFile } from 'node:fs/promises'
import type { ExperimentSpec } from './types.ts'

// Must match samsinn's naming rules for tools/skills — variant names end up
// in result filenames (`<variant>-run<N>.json`), so filesystem-safe chars only.
const VARIANT_NAME_RE = /^[a-zA-Z0-9_-]+$/

export interface LoadedSpec {
  readonly spec: ExperimentSpec
  readonly specDigest: string   // sha256 of file contents, first 12 hex chars
  readonly absolutePath: string
}

const sha256Short = async (text: string): Promise<string> => {
  const bytes = new TextEncoder().encode(text)
  const hash = await crypto.subtle.digest('SHA-256', bytes)
  const hex = Array.from(new Uint8Array(hash))
    .map(b => b.toString(16).padStart(2, '0'))
    .join('')
  return hex.slice(0, 12)
}

const requireField = (obj: unknown, path: string, kind: string): void => {
  if (obj === undefined || obj === null || (typeof obj === 'string' && obj.length === 0)) {
    throw new Error(`Invalid spec: missing or empty ${kind} at \`${path}\``)
  }
}

// Structural validation. Throws with a field-specific message on first failure.
// Does NOT attempt deep type checking beyond "has the field, is the right kind
// of thing"; tsc is the primary type guard. Runs at runtime to catch specs that
// bypass the compiler.
export const validateSpec = (spec: unknown): ExperimentSpec => {
  if (!spec || typeof spec !== 'object') {
    throw new Error('Invalid spec: default export must be an object')
  }
  const s = spec as Record<string, unknown>

  requireField(s.experiment, 'experiment', 'experiment name')
  if (typeof s.experiment !== 'string') throw new Error('Invalid spec: `experiment` must be a string')

  requireField(s.outputDir, 'outputDir', 'outputDir path')
  if (typeof s.outputDir !== 'string') throw new Error('Invalid spec: `outputDir` must be a string')

  if (!s.base || typeof s.base !== 'object') throw new Error('Invalid spec: `base` must be an object')
  const base = s.base as Record<string, unknown>

  if (!base.room || typeof base.room !== 'object') throw new Error('Invalid spec: `base.room` must be an object')
  const room = base.room as Record<string, unknown>
  requireField(room.name, 'base.room.name', 'room name')

  if (!base.trigger || typeof base.trigger !== 'object') throw new Error('Invalid spec: `base.trigger` must be an object')
  const trigger = base.trigger as Record<string, unknown>
  requireField(trigger.content, 'base.trigger.content', 'trigger content')

  if (!Array.isArray(s.variants) || s.variants.length === 0) {
    throw new Error('Invalid spec: `variants` must be a non-empty array')
  }
  const seenNames = new Set<string>()
  for (let i = 0; i < s.variants.length; i++) {
    const v = s.variants[i] as Record<string, unknown>
    if (!v || typeof v !== 'object') throw new Error(`Invalid spec: variants[${i}] must be an object`)
    requireField(v.name, `variants[${i}].name`, 'variant name')
    if (typeof v.name !== 'string' || !VARIANT_NAME_RE.test(v.name)) {
      throw new Error(`Invalid spec: variants[${i}].name "${String(v.name)}" must match ${VARIANT_NAME_RE} (letters, digits, underscore, hyphen)`)
    }
    if (seenNames.has(v.name)) {
      throw new Error(`Invalid spec: duplicate variant name "${v.name}"`)
    }
    seenNames.add(v.name)
    if (!Array.isArray(v.agents) || v.agents.length === 0) {
      // Zero agents is legal only when base.agents is also empty → but at
      // least one agent overall is a prerequisite for any conversation. The
      // zero-agent case (for integration smoke tests) has agents: [] here
      // AND base.agents empty/undefined. We allow empty here and let the
      // orchestrator handle zero-agent rooms.
      if (!Array.isArray(v.agents)) {
        throw new Error(`Invalid spec: variants[${i}].agents must be an array`)
      }
    }
  }

  if (!s.wait || typeof s.wait !== 'object') throw new Error('Invalid spec: `wait` must be an object')
  const wait = s.wait as Record<string, unknown>
  if (typeof wait.quietMs !== 'number' || wait.quietMs <= 0) {
    throw new Error('Invalid spec: `wait.quietMs` must be a positive number')
  }
  if (typeof wait.timeoutMs !== 'number' || wait.timeoutMs <= 0) {
    throw new Error('Invalid spec: `wait.timeoutMs` must be a positive number')
  }

  if (s.repeats !== undefined && (typeof s.repeats !== 'number' || s.repeats <= 0 || !Number.isInteger(s.repeats))) {
    throw new Error('Invalid spec: `repeats` must be a positive integer when set')
  }

  return spec as ExperimentSpec
}

export const loadSpec = async (absolutePath: string): Promise<LoadedSpec> => {
  const mod = await import(absolutePath)
  const spec = validateSpec(mod.default)
  const source = await readFile(absolutePath, 'utf-8')
  const specDigest = await sha256Short(source)
  return { spec, specDigest, absolutePath }
}
