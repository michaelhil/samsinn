// ============================================================================
// LLM Gateway — Concurrency, resilience, and observability for Ollama.
//
// Self-contained module with no Samsinn-specific imports. Wraps any LLMProvider
// with a semaphore, circuit breaker, metrics ring buffer, and health poller.
// Portable to any TypeScript project using Ollama.
// ============================================================================

import type {
  LLMProvider, ChatRequest, ChatResponse, StreamChunk,
  CircuitState, RequestStatus, RequestRecord, GatewayMetrics, LoadedModel, OllamaHealth,
} from '../core/types/llm.ts'
import type { OllamaPsModel, OllamaProviderExtended } from './ollama.ts'
import { createCircuitBreaker } from './circuit-breaker.ts'
import { createGatewayError, isGatewayError, isOllamaError, isPermanent } from './errors.ts'
import { createRingBuffer, createSemaphore } from './concurrency.ts'

// Re-export for legacy import paths.
export type { CircuitState, RequestStatus, RequestRecord, GatewayMetrics, LoadedModel, OllamaHealth }

// === Configuration ===

export interface GatewayConfig {
  readonly maxConcurrent: number
  readonly maxQueueDepth: number
  readonly queueTimeoutMs: number
  readonly circuitBreakerThreshold: number
  readonly circuitBreakerCooldownMs: number
  readonly keepAlive: string
  readonly healthPollIntervalMs: number
}

export const GATEWAY_DEFAULTS: GatewayConfig = {
  maxConcurrent: 2,
  maxQueueDepth: 6,
  queueTimeoutMs: 30_000,
  circuitBreakerThreshold: 5,
  circuitBreakerCooldownMs: 15_000,
  keepAlive: '30m',
  healthPollIntervalMs: 15_000,
}

// === Metrics ===

// === Gateway Interface ===

export type HealthChangeCallback = (health: OllamaHealth) => void

export interface LLMGateway extends LLMProvider {
  readonly getMetrics: () => GatewayMetrics
  readonly getHealth: () => OllamaHealth
  readonly getConfig: () => GatewayConfig
  readonly updateConfig: (partial: Partial<GatewayConfig>) => void
  readonly loadModel: (name: string) => Promise<void>
  readonly unloadModel: (name: string) => Promise<void>
  readonly onHealthChange: (cb: HealthChangeCallback) => void
  readonly resetCircuitBreaker: () => void
  readonly refreshHealth: () => void
  readonly dispose: () => void
}

// === Percentile Computation ===

const percentile = (sorted: number[], p: number): number => {
  if (sorted.length === 0) return 0
  const idx = Math.ceil(sorted.length * p) - 1
  return sorted[Math.max(0, idx)] ?? 0
}

// === Factory ===

export const createLLMGateway = (
  provider: OllamaProviderExtended,
  configOverrides?: Partial<GatewayConfig>,
): LLMGateway => {
  let config: GatewayConfig = { ...GATEWAY_DEFAULTS, ...configOverrides }

  const semaphore = createSemaphore(config.maxConcurrent)
  const metrics = createRingBuffer<RequestRecord>(200)
  let shedCount = 0

  const cb = createCircuitBreaker(
    { threshold: config.circuitBreakerThreshold, cooldownMs: config.circuitBreakerCooldownMs },
    { onStateChange: () => checkHealthTransition() },
  )

  const recordSuccess = (): void => cb.recordSuccess()
  const recordFailure = (): void => cb.recordFailure()
  const shouldAllowRequest = (): boolean => cb.shouldAllow()

  // Health state
  let health: OllamaHealth = {
    status: 'healthy',
    latencyMs: 0,
    loadedModels: [],
    availableModels: [],
    lastCheckedAt: 0,
  }

  const healthChangeCallbacks: HealthChangeCallback[] = []

  const checkHealthTransition = (): void => {
    const prevStatus = health.status
    let newStatus: OllamaHealth['status'] = 'healthy'
    const cbState = cb.getState()
    if (cbState === 'open') newStatus = 'down'
    else if (cbState === 'half_open') newStatus = 'degraded'
    else if (health.latencyMs > 10_000) newStatus = 'degraded'

    if (newStatus !== prevStatus) {
      health = { ...health, status: newStatus }
      for (const cb2 of healthChangeCallbacks) {
        try { cb2(health) } catch { /* ignore callback errors */ }
      }
    }
  }

  // Health poller
  const pollHealth = async (): Promise<void> => {
    try {
      const [loaded, available] = await Promise.all([
        provider.runningModelsDetailed().catch(() => [] as ReadonlyArray<OllamaPsModel>),
        provider.models().catch(() => [] as string[]),
      ])

      const loadedModels: LoadedModel[] = loaded.map(m => ({
        name: m.name,
        sizeVram: m.size_vram,
        details: m.details ? {
          parameterSize: m.details.parameter_size,
          quantizationLevel: m.details.quantization_level,
        } : undefined,
        expiresAt: m.expires_at,
      }))

      // Use most recent request latency if available, otherwise keep previous
      const recentRecords = metrics.toArray()
      const lastSuccess = recentRecords.filter(r => r.status === 'success').pop()
      const latencyMs = lastSuccess?.durationMs ?? health.latencyMs

      health = {
        ...health,
        latencyMs,
        loadedModels,
        availableModels: available,
        lastCheckedAt: Date.now(),
      }
      checkHealthTransition()
    } catch {
      // Poller failure — if circuit is already open, health is already 'down'
      if (cb.getState() === 'closed') {
        health = { ...health, lastCheckedAt: Date.now() }
      }
    }
  }

  let pollTimer: ReturnType<typeof setInterval> | undefined
  const startPoller = (): void => {
    pollHealth() // initial poll
    pollTimer = setInterval(pollHealth, config.healthPollIntervalMs)
  }
  startPoller()

  // Wrapped chat with semaphore + circuit breaker + metrics
  const chat = async (request: ChatRequest): Promise<ChatResponse> => {
    if (!shouldAllowRequest()) {
      shedCount++
      metrics.push({
        model: request.model,
        promptTokens: 0,
        completionTokens: 0,
        durationMs: 0,
        queueWaitMs: 0,
        tokensPerSecond: 0,
        status: 'circuit_open',
        timestamp: Date.now(),
      })
      throw createGatewayError('circuit_open', `Circuit breaker open — Ollama appears down (${cb.getConsecutiveFailures()} consecutive failures)`)
    }

    let queueWaitMs: number
    try {
      queueWaitMs = await semaphore.acquire(config.queueTimeoutMs, config.maxQueueDepth)
    } catch (err) {
      shedCount++
      const status: RequestStatus = isGatewayError(err) && err.code === 'queue_full' ? 'shed' : 'timeout'
      metrics.push({
        model: request.model,
        promptTokens: 0,
        completionTokens: 0,
        durationMs: 0,
        queueWaitMs: 0,
        tokensPerSecond: 0,
        status,
        timestamp: Date.now(),
      })
      throw err
    }

    const startMs = performance.now()
    try {
      // Inject keep_alive into request
      const enrichedRequest = { ...request, keepAlive: config.keepAlive } as ChatRequest
      const response = await provider.chat(enrichedRequest)

      recordSuccess()

      const durationMs = Math.round(performance.now() - startMs)
      metrics.push({
        model: request.model,
        promptTokens: response.tokensUsed.prompt,
        completionTokens: response.tokensUsed.completion,
        durationMs,
        queueWaitMs,
        tokensPerSecond: response.tokensPerSecond ?? 0,
        status: 'success',
        timestamp: Date.now(),
      })

      // Update health latency from real data
      health = { ...health, latencyMs: durationMs }

      return response
    } catch (err) {
      // Don't trip circuit breaker on permanent errors (4xx = config problem, not infra)
      if (!(isOllamaError(err) && isPermanent(err))) {
        recordFailure()
      }

      const durationMs = Math.round(performance.now() - startMs)
      metrics.push({
        model: request.model,
        promptTokens: 0,
        completionTokens: 0,
        durationMs,
        queueWaitMs,
        tokensPerSecond: 0,
        status: 'error',
        timestamp: Date.now(),
      })

      throw err
    } finally {
      semaphore.release()
    }
  }

  // Wrapped stream — same semaphore + circuit breaker, but metrics recorded at end
  const stream = async function* (request: ChatRequest, signal?: AbortSignal): AsyncIterable<StreamChunk> {
    if (!provider.stream) throw createGatewayError('not_supported', 'Provider does not support streaming')

    if (!shouldAllowRequest()) {
      shedCount++
      throw createGatewayError('circuit_open', 'Circuit breaker open')
    }

    const queueWaitMs = await semaphore.acquire(config.queueTimeoutMs, config.maxQueueDepth)
    const startMs = performance.now()

    try {
      const enrichedRequest = { ...request, keepAlive: config.keepAlive } as ChatRequest
      yield* provider.stream(enrichedRequest, signal)
      recordSuccess()

      metrics.push({
        model: request.model,
        promptTokens: 0,
        completionTokens: 0,
        durationMs: Math.round(performance.now() - startMs),
        queueWaitMs,
        tokensPerSecond: 0,
        status: 'success',
        timestamp: Date.now(),
      })
    } catch (err) {
      if (!(isOllamaError(err) && isPermanent(err))) {
        recordFailure()
      }
      metrics.push({
        model: request.model,
        promptTokens: 0,
        completionTokens: 0,
        durationMs: Math.round(performance.now() - startMs),
        queueWaitMs,
        tokensPerSecond: 0,
        status: 'error',
        timestamp: Date.now(),
      })
      throw err
    } finally {
      semaphore.release()
    }
  }

  // Pass-through model listing (cached by health poller)
  const models = async (): Promise<string[]> => {
    if (health.availableModels.length > 0) return [...health.availableModels]
    return provider.models()
  }

  const runningModels = async (): Promise<string[]> => {
    if (health.loadedModels.length > 0) return health.loadedModels.map(m => m.name)
    return provider.runningModels?.() ?? []
  }

  // Aggregation
  const getMetrics = (): GatewayMetrics => {
    const windowMs = 5 * 60 * 1000
    const cutoff = Date.now() - windowMs
    const recent = metrics.toArray().filter(r => r.timestamp >= cutoff)

    const requestCount = recent.length
    const errorCount = recent.filter(r => r.status !== 'success').length
    const errorRate = requestCount > 0 ? errorCount / requestCount : 0

    const durations = recent.filter(r => r.status === 'success').map(r => r.durationMs).sort((a, b) => a - b)
    const tpsValues = recent.filter(r => r.tokensPerSecond > 0).map(r => r.tokensPerSecond)
    const avgTps = tpsValues.length > 0 ? tpsValues.reduce((a, b) => a + b, 0) / tpsValues.length : 0

    return {
      requestCount,
      errorCount,
      errorRate: Math.round(errorRate * 100) / 100,
      p50Latency: percentile(durations, 0.5),
      p95Latency: percentile(durations, 0.95),
      avgTokensPerSecond: Math.round(avgTps * 10) / 10,
      queueDepth: semaphore.queueDepth,
      concurrentRequests: semaphore.active,
      circuitState: cb.getState(),
      shedCount,
      windowMs,
    }
  }

  const getHealth = (): OllamaHealth => health

  const getConfig = (): GatewayConfig => ({ ...config })

  const updateConfig = (partial: Partial<GatewayConfig>): void => {
    config = { ...config, ...partial }
    if (partial.maxConcurrent !== undefined) semaphore.updateMax(partial.maxConcurrent)
    if (partial.circuitBreakerThreshold !== undefined || partial.circuitBreakerCooldownMs !== undefined) {
      cb.updateConfig({
        ...(partial.circuitBreakerThreshold !== undefined ? { threshold: partial.circuitBreakerThreshold } : {}),
        ...(partial.circuitBreakerCooldownMs !== undefined ? { cooldownMs: partial.circuitBreakerCooldownMs } : {}),
      })
    }
    if (partial.healthPollIntervalMs !== undefined && pollTimer) {
      clearInterval(pollTimer)
      pollTimer = setInterval(pollHealth, config.healthPollIntervalMs)
    }
  }

  const loadModel = async (name: string): Promise<void> => {
    await provider.loadModel(name, config.keepAlive)
    await pollHealth() // refresh loaded models
  }

  const unloadModel = async (name: string): Promise<void> => {
    await provider.unloadModel(name)
    await pollHealth()
  }

  const onHealthChange = (cb2: HealthChangeCallback): void => {
    healthChangeCallbacks.push(cb2)
  }

  const dispose = (): void => {
    if (pollTimer) {
      clearInterval(pollTimer)
      pollTimer = undefined
    }
  }

  return {
    chat,
    stream,
    models,
    runningModels,
    getMetrics,
    getHealth,
    getConfig,
    updateConfig,
    loadModel,
    unloadModel,
    onHealthChange,
    resetCircuitBreaker: () => cb.reset(),
    refreshHealth: () => { void pollHealth() },
    dispose,
  }
}
