import { describe, test, expect } from 'bun:test'
import { createLimitMetrics } from './limit-metrics.ts'

describe('LimitMetrics', () => {
  test('starts at zero across all fields', () => {
    const m = createLimitMetrics()
    const s = m.snapshot()
    expect(s.sseBufferExceeded).toBe(0)
    expect(s.evictionFlushRetries).toBe(0)
    expect(s.evictionForceEvicts).toBe(0)
    expect(s.wsBackpressureDropped).toBe(0)
    expect(s.rateLimitEvicted).toBe(0)
  })

  test('inc bumps by 1 by default and by N when given', () => {
    const m = createLimitMetrics()
    m.inc('sseBufferExceeded')
    m.inc('sseBufferExceeded')
    m.inc('rateLimitEvicted', 5)
    const s = m.snapshot()
    expect(s.sseBufferExceeded).toBe(2)
    expect(s.rateLimitEvicted).toBe(5)
  })

  test('snapshot returns a frozen-style copy (mutating it does not affect counters)', () => {
    const m = createLimitMetrics()
    m.inc('wsBackpressureDropped')
    const s = m.snapshot()
    s.wsBackpressureDropped = 999
    expect(m.snapshot().wsBackpressureDropped).toBe(1)
  })

  test('reset zeroes every counter', () => {
    const m = createLimitMetrics()
    m.inc('sseBufferExceeded', 3)
    m.inc('rateLimitEvicted', 7)
    m.reset()
    const s = m.snapshot()
    expect(s.sseBufferExceeded).toBe(0)
    expect(s.rateLimitEvicted).toBe(0)
  })
})
