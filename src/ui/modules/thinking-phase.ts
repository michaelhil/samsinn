// Pure phase-derivation for the thinking indicator.
// Decoupled from DOM so it can be tested without a DOM. The renderer (ui-renderer.ts)
// and the orchestrator (app.ts) both consume `derivePhase` + `phaseLabel`.

export type ThinkingPhase =
  | { readonly kind: 'building' }
  | { readonly kind: 'thinking' }
  | { readonly kind: 'waiting'; readonly model: string }
  | { readonly kind: 'generating' }

export interface ThinkingPhaseInput {
  readonly hasContext: boolean
  readonly model?: string
  readonly toolText: string
  readonly firstChunkSeen: boolean
}

export const THINKING_MARKER = '__thinking__'

export const derivePhase = (input: ThinkingPhaseInput): ThinkingPhase => {
  if (input.toolText === THINKING_MARKER) return { kind: 'thinking' }
  if (!input.hasContext) return { kind: 'building' }
  if (input.firstChunkSeen || input.toolText.length > 0) return { kind: 'generating' }
  return { kind: 'waiting', model: input.model ?? 'model' }
}

export const phaseLabel = (agentName: string, phase: ThinkingPhase): string => {
  switch (phase.kind) {
    case 'building': return `${agentName}: Building context...`
    case 'thinking': return `${agentName}: Thinking...`
    case 'waiting': return `${agentName}: Waiting for ${phase.model}...`
    case 'generating': return `${agentName}: Generating...`
  }
}
