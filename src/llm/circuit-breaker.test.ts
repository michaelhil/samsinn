import { expect, test, describe } from 'bun:test'
import { createCircuitBreaker } from './circuit-breaker.ts'

const withFakeClock = () => {
  let t = 0
  return { now: () => t, advance: (ms: number) => { t += ms } }
}

describe('circuit breaker', () => {
  test('starts closed and allows requests', () => {
    const cb = createCircuitBreaker({ threshold: 3, cooldownMs: 1000 })
    expect(cb.getState()).toBe('closed')
    expect(cb.shouldAllow()).toBe(true)
  })

  test('trips open after threshold consecutive failures', () => {
    const cb = createCircuitBreaker({ threshold: 3, cooldownMs: 1000 })
    cb.recordFailure()
    cb.recordFailure()
    expect(cb.getState()).toBe('closed')
    cb.recordFailure()
    expect(cb.getState()).toBe('open')
    expect(cb.shouldAllow()).toBe(false)
  })

  test('success before threshold resets the counter', () => {
    const cb = createCircuitBreaker({ threshold: 3, cooldownMs: 1000 })
    cb.recordFailure()
    cb.recordFailure()
    cb.recordSuccess()
    cb.recordFailure()
    cb.recordFailure()
    expect(cb.getState()).toBe('closed')
    expect(cb.getConsecutiveFailures()).toBe(2)
  })

  test('after cooldown, shouldAllow transitions open → half_open and allows one probe', () => {
    const clock = withFakeClock()
    const cb = createCircuitBreaker({ threshold: 1, cooldownMs: 1000 }, { now: clock.now })
    cb.recordFailure()
    expect(cb.getState()).toBe('open')
    expect(cb.shouldAllow()).toBe(false)

    clock.advance(1000)
    expect(cb.shouldAllow()).toBe(true)
    expect(cb.getState()).toBe('half_open')
    // No further probes while half_open
    expect(cb.shouldAllow()).toBe(false)
  })

  test('half_open + success → closed', () => {
    const clock = withFakeClock()
    const cb = createCircuitBreaker({ threshold: 1, cooldownMs: 500 }, { now: clock.now })
    cb.recordFailure()
    clock.advance(500)
    cb.shouldAllow() // trigger half_open
    cb.recordSuccess()
    expect(cb.getState()).toBe('closed')
    expect(cb.shouldAllow()).toBe(true)
  })

  test('half_open + failure → open again (single-failure re-trip)', () => {
    const clock = withFakeClock()
    const cb = createCircuitBreaker({ threshold: 5, cooldownMs: 500 }, { now: clock.now })
    for (let i = 0; i < 5; i++) cb.recordFailure()
    expect(cb.getState()).toBe('open')

    clock.advance(500)
    cb.shouldAllow() // → half_open
    cb.recordFailure() // a single probe failure trips immediately
    expect(cb.getState()).toBe('open')
  })

  test('reset() forces closed state and clears failures', () => {
    const cb = createCircuitBreaker({ threshold: 2, cooldownMs: 1000 })
    cb.recordFailure()
    cb.recordFailure()
    expect(cb.getState()).toBe('open')
    cb.reset()
    expect(cb.getState()).toBe('closed')
    expect(cb.getConsecutiveFailures()).toBe(0)
    expect(cb.shouldAllow()).toBe(true)
  })

  test('onStateChange fires only on actual transitions', () => {
    const transitions: string[] = []
    const clock = withFakeClock()
    const cb = createCircuitBreaker(
      { threshold: 2, cooldownMs: 500 },
      { now: clock.now, onStateChange: (s) => transitions.push(s) },
    )
    cb.recordFailure()
    cb.recordFailure() // closed → open
    clock.advance(500)
    cb.shouldAllow() // open → half_open
    cb.recordSuccess() // half_open → closed
    expect(transitions).toEqual(['open', 'half_open', 'closed'])
  })

  test('updateConfig applies new threshold to subsequent failures', () => {
    const cb = createCircuitBreaker({ threshold: 5, cooldownMs: 1000 })
    cb.updateConfig({ threshold: 2 })
    cb.recordFailure()
    cb.recordFailure()
    expect(cb.getState()).toBe('open')
  })
})
