import { expect, test, describe } from 'bun:test'
import { derivePhase, phaseLabel, THINKING_MARKER } from './thinking-phase.ts'

describe('derivePhase', () => {
  test('no context yet → building', () => {
    expect(derivePhase({ hasContext: false, toolText: '', firstChunkSeen: false }))
      .toEqual({ kind: 'building' })
  })

  test('thinking marker always wins (even before context)', () => {
    expect(derivePhase({ hasContext: false, toolText: THINKING_MARKER, firstChunkSeen: false }))
      .toEqual({ kind: 'thinking' })
    expect(derivePhase({ hasContext: true, toolText: THINKING_MARKER, firstChunkSeen: true, model: 'qwen3' }))
      .toEqual({ kind: 'thinking' })
  })

  test('context ready but no activity → waiting', () => {
    expect(derivePhase({ hasContext: true, toolText: '', firstChunkSeen: false, model: 'llama3.2' }))
      .toEqual({ kind: 'waiting', model: 'llama3.2' })
  })

  test('waiting falls back to "model" placeholder when model is undefined', () => {
    expect(derivePhase({ hasContext: true, toolText: '', firstChunkSeen: false }))
      .toEqual({ kind: 'waiting', model: 'model' })
  })

  test('first chunk seen → generating', () => {
    expect(derivePhase({ hasContext: true, toolText: '', firstChunkSeen: true }))
      .toEqual({ kind: 'generating' })
  })

  test('tool in progress → generating (non-thinking toolText)', () => {
    expect(derivePhase({ hasContext: true, toolText: 'web_search: ...', firstChunkSeen: false }))
      .toEqual({ kind: 'generating' })
  })

  // Regression: commit 0de0800 — "thinking indicator restores correct phase label on room re-entry".
  // When the user leaves a room where an agent is already streaming and comes back,
  // the indicator is re-created; its phase must reflect the accumulated state
  // (context + first chunk already seen), not the default "Building context...".
  test('room re-entry with context + chunks already seen → generating, not building', () => {
    expect(derivePhase({ hasContext: true, toolText: '', firstChunkSeen: true, model: 'llama3.2' }))
      .toEqual({ kind: 'generating' })
  })

  test('room re-entry with context but no chunks yet → waiting, not building', () => {
    expect(derivePhase({ hasContext: true, toolText: '', firstChunkSeen: false, model: 'llama3.2' }))
      .toEqual({ kind: 'waiting', model: 'llama3.2' })
  })
})

describe('phaseLabel', () => {
  test('includes agent name and phase text', () => {
    expect(phaseLabel('Alice', { kind: 'building' })).toBe('Alice: Building context...')
    expect(phaseLabel('Alice', { kind: 'thinking' })).toBe('Alice: Thinking...')
    expect(phaseLabel('Alice', { kind: 'generating' })).toBe('Alice: Generating...')
    expect(phaseLabel('Alice', { kind: 'waiting', model: 'qwen2.5' })).toBe('Alice: Waiting for qwen2.5...')
  })
})
