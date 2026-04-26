// ============================================================================
// In-memory per-key sliding-window rate limiter with LRU bound.
//
// Used by routes that need to throttle drive-by spam (instance creation,
// bug submission). Single-process, no Redis — fits samsinn's threat model:
// one operator, single host, restarts are rare enough that losing the
// counter on restart isn't a real abuse path.
//
// Keying is left to the caller (typically remote IP). Map size is bounded
// by an LRU cap (default 4096 keys). When full, the least-recently-touched
// key is evicted on each new insert.
//
// Known limitation: LRU eviction means an attacker controlling > mapSizeCap
// unique IPs can evict their own previous timestamps and reset their
// counter — bypassing the limit. Acceptable for the single-VPS deploy
// (Caddy in front handles that scale of abuse). Not safe for direct
// internet exposure without a reverse proxy.
// ============================================================================

import type { LimitMetrics } from '../core/limit-metrics.ts'

export interface RateLimitOk { readonly ok: true }
export interface RateLimitFail { readonly ok: false; readonly retryAfterMs: number }
export type RateLimitResult = RateLimitOk | RateLimitFail

export interface RateLimiterOptions {
  readonly windowMs: number
  readonly max: number
  readonly mapSizeCap?: number   // defaults to 4096
  readonly limitMetrics?: LimitMetrics
}

export interface RateLimiter {
  /** Check + record. Returns { ok: true } and records a timestamp on accept. */
  readonly check: (key: string | undefined, now?: number) => RateLimitResult
}

export const createRateLimiter = (opts: RateLimiterOptions): RateLimiter => {
  const { windowMs, max, limitMetrics } = opts
  const cap = opts.mapSizeCap ?? 4096
  // Map preserves insertion order. delete+set on every accept keeps the
  // most recently touched key at the tail; oldest = first element.
  const stamps = new Map<string, number[]>()

  const check = (key: string | undefined, now: number = Date.now()): RateLimitResult => {
    // No key available (test/headless boundary) — fail open. Production
    // traffic always supplies one via Bun.serve.requestIP().
    if (!key) return { ok: true }
    const arr = stamps.get(key) ?? []
    const cutoff = now - windowMs
    const recent = arr.filter(t => t > cutoff)
    if (recent.length >= max) {
      const oldest = recent[0]!
      return { ok: false, retryAfterMs: oldest + windowMs - now }
    }
    recent.push(now)
    // Refresh insertion order so this key becomes the newest.
    stamps.delete(key)
    stamps.set(key, recent)
    // LRU eviction: when over cap, drop the oldest insertion-order key.
    if (stamps.size > cap) {
      const oldestKey = stamps.keys().next().value
      if (oldestKey !== undefined) {
        stamps.delete(oldestKey)
        limitMetrics?.inc('rateLimitEvicted')
      }
    }
    return { ok: true }
  }

  return { check }
}
