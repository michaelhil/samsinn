// ============================================================================
// Delivery Modes — Pure functions for each delivery strategy.
//
// Each mode function receives an `eligible` set (members minus user-muted)
// and delivers accordingly. Room.post() computes eligible once and passes it
// to the active mode. Muting and mode filtering are independent concerns.
//
// Modes:
//   broadcast  — deliver to all eligible members
//   manual     — deliver to humans + sender (AI peers catch up at activation)
//
// Macro step delivery is NOT a mode; it overlays on top of the room's mode
// via room.runMacro(). The helpers here (advanceMacroStep, deliverMacroStep)
// are used by the overlay.
// ============================================================================

import type { DeliverFn, Message } from './types/messaging.ts'
import type { Macro, MacroStepContext, MacroRun } from './types/macro.ts'

// --- Shared macro step context builder ---
// Single source of truth for MacroStepContext construction.
// Used by both runMacro (room.ts) and deliverMacroStep (subsequent steps).

export const buildMacroStepContext = (macro: Macro, stepIndex: number): MacroStepContext => ({
  macroName: macro.name,
  stepIndex,
  totalSteps: macro.steps.length,
  loop: macro.loop,
  steps: macro.steps.map(s => ({ agentName: s.agentName })),
  ...(macro.artifactDescription !== undefined ? { artifactDescription: macro.artifactDescription } : {}),
  ...(macro.goalChain !== undefined ? { goalChain: macro.goalChain } : {}),
})

// --- Broadcast mode ---

export const deliverBroadcast = (
  message: Message,
  eligible: ReadonlySet<string>,
  deliver: DeliverFn,
): void => {
  for (const id of eligible) {
    deliver(id, message)
  }
}

// --- Macro step delivery (overlay, invoked when a macro run is active) ---

export interface MacroStepResult {
  readonly advanced: boolean
  readonly completed: boolean
  readonly looped: boolean
  readonly nextStepIndex: number
  readonly nextAgentName?: string
}

export const deliverMacroStep = (
  message: Message,
  run: MacroRun,
  eligible: ReadonlySet<string>,
  senderId: string,
  deliver: DeliverFn,
): MacroStepResult => {
  const currentStep = run.macro.steps[run.stepIndex]
  if (!currentStep) {
    return { advanced: false, completed: true, looped: false, nextStepIndex: run.stepIndex }
  }

  // Only the expected step agent's chat response advances the macro.
  // Pass messages do not advance — the step stays open waiting for a real response.
  if (senderId !== currentStep.agentId || message.type === 'pass') {
    return { advanced: false, completed: false, looped: false, nextStepIndex: run.stepIndex }
  }

  // Advance to next step — find next eligible agent
  const result = advanceMacroStep(run, eligible)

  if (!result.completed && result.nextAgentId) {
    const nextStep = run.macro.steps[result.nextStepIndex]!
    const macroContext = buildMacroStepContext(run.macro, result.nextStepIndex)
    const enriched = {
      ...message,
      ...(nextStep.stepPrompt ? { stepPrompt: nextStep.stepPrompt } : {}),
      macroContext,
    }
    deliver(result.nextAgentId, enriched)
  }

  return { advanced: true, ...result }
}

// --- Macro step advancement (pure, no delivery side effects) ---
// Uses agentId directly from MacroStep — no name resolution needed.

interface MacroAdvanceResult {
  readonly completed: boolean
  readonly looped: boolean
  readonly nextStepIndex: number
  readonly nextAgentId?: string
  readonly nextAgentName?: string
}

export const advanceMacroStep = (
  run: MacroRun,
  eligible: ReadonlySet<string>,
): MacroAdvanceResult => {
  let nextIndex = run.stepIndex + 1
  let looped = false

  if (nextIndex >= run.macro.steps.length) {
    if (run.macro.loop) {
      nextIndex = 0
      looped = true
    } else {
      return { completed: true, looped: false, nextStepIndex: nextIndex }
    }
  }

  // Find next eligible step agent (skip muted/non-members).
  // Loop up to stepsLength times to avoid infinite cycle when all are ineligible.
  const stepsLength = run.macro.steps.length
  let attempts = 0
  while (attempts < stepsLength) {
    const nextStep = run.macro.steps[nextIndex]!

    if (eligible.has(nextStep.agentId)) {
      return { completed: false, looped, nextStepIndex: nextIndex, nextAgentId: nextStep.agentId, nextAgentName: nextStep.agentName }
    }

    // Skip ineligible agent
    nextIndex = (nextIndex + 1) % stepsLength
    if (nextIndex === 0 && !run.macro.loop) {
      return { completed: true, looped: false, nextStepIndex: nextIndex }
    }
    attempts++
  }

  // All agents ineligible — macro is effectively complete
  return { completed: true, looped: false, nextStepIndex: nextIndex }
}
