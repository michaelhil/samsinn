// ============================================================================
// Logging config — env-var parsing, session-id generation, kind filter.
//
// Pure functions. Called at boot by bootstrap.ts; also used by the
// runtime-reconfigure path (PUT /api/logging + configure_logging MCP tool).
// ============================================================================

import { homedir } from 'node:os'
import { join } from 'node:path'
import type { LogConfig } from './types.ts'

const DEFAULT_LOG_SUBDIR = ['.samsinn', 'logs'] as const

// Short random tail on auto-generated session ids. 8 hex chars (32 bits of
// entropy) is plenty for uniqueness within a study and keeps filenames short.
const shortId = (): string => crypto.randomUUID().replace(/-/g, '').slice(0, 8)

export const defaultSessionId = (): string =>
  `session-${Date.now()}-${shortId()}`

export const defaultLogDir = (): string =>
  join(homedir(), ...DEFAULT_LOG_SUBDIR)

// Read boot config from environment. Missing/empty → sensible defaults.
// Disabled by default — opt-in to avoid surprise disk writes.
export const parseLogConfigFromEnv = (env: NodeJS.ProcessEnv = process.env): LogConfig => {
  const enabled = env.SAMSINN_LOG_ENABLED === '1'
  const dir = env.SAMSINN_LOG_DIR ?? defaultLogDir()
  const sessionId = env.SAMSINN_SESSION_ID ?? defaultSessionId()
  const kinds = env.SAMSINN_LOG_KINDS
    ? env.SAMSINN_LOG_KINDS.split(',').map(s => s.trim()).filter(Boolean)
    : ['*']
  return { enabled, dir, sessionId, kinds }
}

// === Kind-filter glob ===
// Supports three forms:
//   '*'           → matches every kind
//   'message.*'   → prefix match (anything starting with 'message.')
//   'message.posted' → exact match
// Multiple patterns union: any match = included.

export const matchesKindFilter = (kind: string, patterns: ReadonlyArray<string>): boolean => {
  if (patterns.length === 0) return false
  for (const p of patterns) {
    if (p === '*') return true
    if (p === kind) return true
    if (p.endsWith('.*') && kind.startsWith(p.slice(0, -1))) return true
  }
  return false
}

// Validate a config — used by the runtime-reconfigure path to reject bad input
// before swapping the sink. Throws a descriptive error on invalid config; the
// caller translates to HTTP 400 / MCP errorResult.
export const validateLogConfig = (c: Partial<LogConfig>): void => {
  if (c.enabled !== undefined && typeof c.enabled !== 'boolean') {
    throw new Error('logging.enabled must be a boolean')
  }
  if (c.dir !== undefined && (typeof c.dir !== 'string' || c.dir.length === 0)) {
    throw new Error('logging.dir must be a non-empty string')
  }
  if (c.sessionId !== undefined) {
    if (typeof c.sessionId !== 'string' || c.sessionId.length === 0) {
      throw new Error('logging.sessionId must be a non-empty string')
    }
    // Filesystem-safe — sessionId lands in a filename.
    if (!/^[a-zA-Z0-9._-]+$/.test(c.sessionId)) {
      throw new Error('logging.sessionId may contain only letters, digits, dot, underscore, hyphen')
    }
  }
  if (c.kinds !== undefined) {
    if (!Array.isArray(c.kinds)) throw new Error('logging.kinds must be an array of strings')
    for (const k of c.kinds) {
      if (typeof k !== 'string' || k.length === 0) {
        throw new Error('logging.kinds entries must be non-empty strings')
      }
    }
  }
}
