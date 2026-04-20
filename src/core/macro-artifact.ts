// ============================================================================
// Macro Artifact — Shared helper for resolving a macro artifact into a Macro.
//
// Used by both the WS command handler (artifact-commands.ts) and the MCP tool
// (message-tools.ts). Lives in src/core/ so both layers can import it without
// cross-layer dependencies.
//
// Builds goal ancestry from the artifact's description and the room's roomPrompt,
// giving each macro step's receiving agent context for *why* the macro was run.
// ============================================================================

import type { Artifact, MacroArtifactBody } from './types/artifact.ts'
import type { Macro, MacroStep } from './types/macro.ts'
import type { Team } from './types/agent.ts'

export interface ResolveMacroArtifactError {
  readonly error: string
}

export const resolveMacroArtifact = (
  artifact: Artifact,
  team: Team,
  roomPrompt?: string,
): Macro | ResolveMacroArtifactError => {
  if (artifact.type !== 'macro') {
    return { error: `Artifact "${artifact.id}" is not a macro (type: ${artifact.type})` }
  }

  const macroBody = artifact.body as unknown as MacroArtifactBody
  const steps: MacroStep[] = (macroBody.steps ?? []).map(s => ({
    agentId: s.agentId || (team.getAgent(s.agentName)?.id ?? ''),
    agentName: s.agentName,
    ...(s.stepPrompt ? { stepPrompt: s.stepPrompt } : {}),
  }))

  if (steps.length === 0) return { error: 'Macro has no steps' }

  const unresolvedStep = steps.find(s => !s.agentId)
  if (unresolvedStep) {
    return { error: `Macro step agent "${unresolvedStep.agentName}" not found` }
  }

  // Build goal ancestry: artifact title + optional room context
  // Gives each step agent "why" context alongside the "what"
  const goalChain: string[] = [artifact.title]
  if (roomPrompt) goalChain.push(roomPrompt)

  // Use description from top-level artifact field or fall back to body.description
  const artifactDescription =
    artifact.description ??
    (typeof macroBody.description === 'string' ? macroBody.description : undefined)

  return {
    id: artifact.id,
    name: artifact.title,
    steps,
    loop: macroBody.loop ?? false,
    ...(artifactDescription !== undefined ? { artifactDescription } : {}),
    goalChain,
  }
}

export const isMacroError = (result: Macro | ResolveMacroArtifactError): result is ResolveMacroArtifactError =>
  'error' in result
