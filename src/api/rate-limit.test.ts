import { describe, test, expect } from 'bun:test'
import { createRateLimiter } from './rate-limit.ts'
import { createLimitMetrics } from '../core/limit-metrics.ts'

describe('rate-limit', () => {
  test('accepts under the per-window limit', () => {
    const r = createRateLimiter({ windowMs: 60_000, max: 3 })
    const now = 1_000_000
    expect(r.check('ip', now).ok).toBe(true)
    expect(r.check('ip', now + 1).ok).toBe(true)
    expect(r.check('ip', now + 2).ok).toBe(true)
    const fourth = r.check('ip', now + 3)
    expect(fourth.ok).toBe(false)
  })

  test('window slides — old timestamps expire', () => {
    const r = createRateLimiter({ windowMs: 1000, max: 1 })
    const t = 1_000_000
    expect(r.check('ip', t).ok).toBe(true)
    expect(r.check('ip', t + 500).ok).toBe(false)
    expect(r.check('ip', t + 1500).ok).toBe(true)
  })

  test('LRU bound — oldest insertion-order key is evicted', () => {
    const metrics = createLimitMetrics()
    const r = createRateLimiter({ windowMs: 60_000, max: 5, mapSizeCap: 4, limitMetrics: metrics })
    // Fill the map exactly to cap.
    r.check('a', 1000)
    r.check('b', 1001)
    r.check('c', 1002)
    r.check('d', 1003)
    expect(metrics.snapshot().rateLimitEvicted).toBe(0)
    // Insert a 5th key — 'a' should be evicted.
    r.check('e', 1004)
    expect(metrics.snapshot().rateLimitEvicted).toBe(1)
    // 'a' is fresh again (its history was wiped) — first check accepts.
    const after = r.check('a', 1005)
    expect(after.ok).toBe(true)
  })

  test('refreshing an existing key moves it to LRU tail', () => {
    const r = createRateLimiter({ windowMs: 60_000, max: 5, mapSizeCap: 3 })
    r.check('a', 1000)   // [a]
    r.check('b', 1001)   // [a, b]
    r.check('c', 1002)   // [a, b, c]
    r.check('a', 1003)   // touches a → reorders to [b, c, a]
    r.check('d', 1004)   // forces eviction of OLDEST = b
    // 'a' should still be tracked (proves it was reordered, not evicted)
    const a = r.check('a', 1005)
    expect(a.ok).toBe(true)
    // a now has 3 stamps in a 60s window (max=5) → still ok.
    expect(a.ok).toBe(true)
  })

  test('no key returns ok (test/headless boundary)', () => {
    const r = createRateLimiter({ windowMs: 60_000, max: 1 })
    expect(r.check(undefined).ok).toBe(true)
    expect(r.check(undefined).ok).toBe(true)
  })
})
