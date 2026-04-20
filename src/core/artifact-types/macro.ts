// ============================================================================
// Macro Artifact Type
//
// A reusable macro blueprint (ordered agent step sequence).
// The blueprint is stored as an artifact; run state is managed by room.ts.
//
// When starting a macro, callers resolve this artifact to construct a Macro
// object: { id: artifact.id, name: artifact.title, ...artifact.body }
// and pass it to room.runMacro(macro).
//
// Factory function: takes Team so onCreate can resolve agent names → IDs
// in step definitions that omit agentId.
// ============================================================================

import type { Artifact, ArtifactTypeDefinition, MacroArtifactBody } from '../types/artifact.ts'
import type { MacroStep } from '../types/macro.ts'
import type { Team } from '../types/agent.ts'

export const createMacroArtifactType = (team: Team): ArtifactTypeDefinition => ({
  type: 'macro',
  description: 'A reusable agent macro (ordered step sequence). Start execution via run_macro.',

  bodySchema: {
    type: 'object',
    properties: {
      steps: {
        type: 'array',
        description: 'Ordered agent steps',
        items: {
          type: 'object',
          properties: {
            agentName: { type: 'string', description: 'Agent name (resolved to ID at creation)' },
            agentId: { type: 'string', description: 'Agent UUID (auto-resolved from agentName if omitted)' },
            stepPrompt: { type: 'string', description: 'Per-step instruction for this agent' },
          },
          required: ['agentName'],
        },
      },
      loop: { type: 'boolean', description: 'Whether the macro repeats after all steps complete' },
      description: { type: 'string', description: 'Optional description of the macro purpose' },
    },
    required: ['steps', 'loop'],
  },

  onCreate: (artifact: Artifact): void => {
    // Resolve agentName → agentId for any steps missing agentId.
    // Note: we can't mutate artifact here (already stored). The resolution is done
    // at add time by the artifact store calling our onUpdate with a synthetic update,
    // OR callers are expected to provide agentId. The add_artifact tool resolves names.
    // onCreate is a hook for side-effects (e.g. notifications) — not body mutation.
    void team  // team reference available for validation if needed
    void artifact
  },

  onUpdate: (artifact: Artifact, updates): import('../types/artifact.ts').ArtifactUpdateResult | void => {
    if (!updates.body?.steps) return  // no steps change — default merge
    const body = artifact.body as unknown as MacroArtifactBody
    // Resolve any steps missing agentId
    const rawSteps = updates.body.steps as Array<Partial<MacroStep>>
    const resolvedSteps: MacroStep[] = rawSteps.map(s => {
      const agentId = s.agentId ?? (s.agentName ? team.getAgent(s.agentName)?.id : undefined) ?? ''
      const agentName = s.agentName ?? ''
      return { agentId, agentName, ...(s.stepPrompt ? { stepPrompt: s.stepPrompt } : {}) }
    })
    return { newBody: { ...body, ...updates.body, steps: resolvedSteps } as unknown as Record<string, unknown> }
  },

  formatForContext: (artifact: Artifact): string => {
    const body = artifact.body as unknown as MacroArtifactBody
    const steps = body.steps ?? []
    const sequence = steps.map(s => s.agentName).join(' → ')
    const loopTag = body.loop ? ' [loops]' : ''
    const desc = artifact.description ?? body.description
    const lines = [
      `Macro: "${artifact.title}" [id: ${artifact.id}]${loopTag}`,
      ...(desc ? [`  Purpose: ${desc}`] : []),
      `  Sequence: ${sequence || '(no steps)'}`,
      `  Start with: run_macro { roomName: "<room>", macroArtifactId: "${artifact.id}", content: "<trigger>" }`,
    ]
    return lines.join('\n')
  },

  formatUpdateMessage: (artifact: Artifact): string =>
    `macro "${artifact.title}" was updated`,

  postSystemMessageOn: ['added', 'updated', 'removed'],
})
