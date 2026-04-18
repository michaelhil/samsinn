// Circuit breaker — closed/open/half_open state machine with cooldown-based recovery.
// Pure logic (no I/O). Used by the LLM gateway to short-circuit requests when the
// provider is failing. Permanent errors (4xx config issues) do not count toward tripping.

import type { CircuitState } from '../core/types/llm.ts'
export type { CircuitState }

export interface CircuitBreakerConfig {
  readonly threshold: number
  readonly cooldownMs: number
}

export interface CircuitBreaker {
  readonly shouldAllow: () => boolean
  readonly recordSuccess: () => void
  readonly recordFailure: () => void
  readonly reset: () => void
  readonly getState: () => CircuitState
  readonly getConsecutiveFailures: () => number
  readonly updateConfig: (partial: Partial<CircuitBreakerConfig>) => void
}

export interface CircuitBreakerDeps {
  readonly now?: () => number
  readonly onStateChange?: (state: CircuitState) => void
}

export const createCircuitBreaker = (
  initialConfig: CircuitBreakerConfig,
  deps: CircuitBreakerDeps = {},
): CircuitBreaker => {
  const now = deps.now ?? Date.now
  const notify = deps.onStateChange

  let config = { ...initialConfig }
  let state: CircuitState = 'closed'
  let consecutiveFailures = 0
  let openedAt = 0

  const setState = (next: CircuitState): void => {
    if (next === state) return
    state = next
    notify?.(state)
  }

  const trip = (): void => {
    openedAt = now()
    setState('open')
  }

  return {
    shouldAllow: (): boolean => {
      if (state === 'closed') return true
      if (state === 'open') {
        if (now() - openedAt >= config.cooldownMs) {
          setState('half_open')
          return true
        }
        return false
      }
      // half_open: no further probes until current probe resolves
      return false
    },

    recordSuccess: (): void => {
      if (state === 'half_open') {
        consecutiveFailures = 0
        setState('closed')
      } else {
        consecutiveFailures = 0
      }
    },

    recordFailure: (): void => {
      consecutiveFailures++
      if (state === 'half_open') {
        trip()
      } else if (consecutiveFailures >= config.threshold) {
        trip()
      }
    },

    reset: (): void => {
      consecutiveFailures = 0
      setState('closed')
    },

    getState: (): CircuitState => state,
    getConsecutiveFailures: (): number => consecutiveFailures,

    updateConfig: (partial: Partial<CircuitBreakerConfig>): void => {
      config = { ...config, ...partial }
    },
  }
}
