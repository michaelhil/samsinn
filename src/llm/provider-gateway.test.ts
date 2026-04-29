// ============================================================================
// Regression tests for createProviderGateway config merge.
//
// Bug context: production samsinn.app went silent because
//   `{ ...PROVIDER_GATEWAY_DEFAULTS, ...configOverrides }`
// where `configOverrides = { maxConcurrent: undefined }` clobbered the
// default `maxConcurrent` (=2) with undefined. The semaphore was created
// with `max=undefined`, so `active < max` was always false, every acquire
// queued, and every request timed out after 30 s with
// "LLM gateway queue timeout after 30000ms".
//
// The bug only manifested for cloud providers that didn't set explicit
// maxConcurrent in providers-config (anthropic, cerebras, groq, openrouter,
// mistral, sambanova). Gemini was fine because providers-config sets
// maxConcurrent: 3 explicitly. The user-visible symptom: "Send a message,
// nothing happens" — agents using a model whose router walked any of the
// undefined-max gateways hung for 30 s before timing out (often longer if
// the router fell through multiple).
// ============================================================================

import { describe, test, expect } from 'bun:test'
import { createProviderGateway, PROVIDER_GATEWAY_DEFAULTS } from './provider-gateway.ts'
import type { LLMProvider, ChatRequest, ChatResponse } from '../core/types/llm.ts'

const stubProvider = (): LLMProvider => ({
  chat: async (_req: ChatRequest): Promise<ChatResponse> =>
    ({ content: 'ok', generationMs: 0, tokensUsed: { prompt: 1, completion: 1 } }),
  stream: async function* () { yield { delta: 'ok', done: false }; yield { delta: '', done: true } },
  models: async () => [],
  runningModels: async () => [],
})

describe('createProviderGateway config merge', () => {
  test('undefined override does NOT clobber default (the bug)', () => {
    const gw = createProviderGateway(stubProvider(), { maxConcurrent: undefined })
    // Pre-fix: maxConcurrent === undefined → semaphore.acquire queues forever.
    // Post-fix: defaults survive when override is undefined.
    expect(gw.getConfig().maxConcurrent).toBe(PROVIDER_GATEWAY_DEFAULTS.maxConcurrent)
    expect(typeof gw.getConfig().maxConcurrent).toBe('number')
  })

  test('omitted override falls back to default', () => {
    const gw = createProviderGateway(stubProvider(), {})
    expect(gw.getConfig().maxConcurrent).toBe(PROVIDER_GATEWAY_DEFAULTS.maxConcurrent)
  })

  test('explicit override is honored', () => {
    const gw = createProviderGateway(stubProvider(), { maxConcurrent: 7 })
    expect(gw.getConfig().maxConcurrent).toBe(7)
  })

  test('partial override merges with defaults — only the explicit field changes', () => {
    const gw = createProviderGateway(stubProvider(), { maxConcurrent: 5 })
    const cfg = gw.getConfig()
    expect(cfg.maxConcurrent).toBe(5)
    expect(cfg.queueTimeoutMs).toBe(PROVIDER_GATEWAY_DEFAULTS.queueTimeoutMs)
    expect(cfg.maxQueueDepth).toBe(PROVIDER_GATEWAY_DEFAULTS.maxQueueDepth)
  })

  test('chat() returns immediately when maxConcurrent is properly set (sentinel)', async () => {
    // The actual queue-timeout symptom: if the bug returns, this test would
    // hang for 30 s. Bun's per-test timeout (default 5 s) catches it.
    const gw = createProviderGateway(stubProvider(), { maxConcurrent: undefined })
    const start = Date.now()
    const r = await gw.chat({ model: 'm', messages: [{ role: 'user', content: 'hi' }] })
    expect(r.content).toBe('ok')
    expect(Date.now() - start).toBeLessThan(1000) // way under the 30s queue timeout
  })
})

describe('updateConfig merge', () => {
  test('undefined in partial does NOT clobber existing config', () => {
    const gw = createProviderGateway(stubProvider(), { maxConcurrent: 4 })
    gw.updateConfig({ queueTimeoutMs: 10_000 } as Parameters<typeof gw.updateConfig>[0])
    expect(gw.getConfig().maxConcurrent).toBe(4)
    expect(gw.getConfig().queueTimeoutMs).toBe(10_000)
    // Calling updateConfig with explicit-undefined must not zero out fields
    // (e.g. when a partial form has empty inputs).
    gw.updateConfig({ maxConcurrent: undefined as unknown as number })
    expect(gw.getConfig().maxConcurrent).toBe(4)
  })
})
