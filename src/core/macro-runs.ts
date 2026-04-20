// ============================================================================
// Macro Run State — Manages in-flight macro execution for a Room.
//
// Macro blueprints are Artifacts (system-level). This module only tracks the
// active run: which macro is running, what step we're on, and notifies
// listeners of run events (started/step/completed/cancelled).
// ============================================================================

import type { MacroRun, MacroEventDetails, MacroEventName } from './types/macro.ts'
import type { OnMacroEvent } from './types/room.ts'

export interface MacroRunState {
  readonly getRun: () => MacroRun | undefined
  readonly setRun: (run: MacroRun | undefined) => void
  readonly clearRun: () => void
  readonly advanceStep: (nextStepIndex: number) => void
  readonly notifyMacroEvent: <E extends MacroEventName>(event: E, detail?: MacroEventDetails[E]) => void
}

export const createMacroRunState = (roomId: string, onMacroEvent?: OnMacroEvent): MacroRunState => {
  let macroRun: MacroRun | undefined

  const notifyMacroEvent = <E extends MacroEventName>(event: E, detail?: MacroEventDetails[E]): void => {
    onMacroEvent?.(roomId, event, detail)
  }

  return {
    getRun: (): MacroRun | undefined => macroRun,
    setRun: (run: MacroRun | undefined): void => { macroRun = run },
    clearRun: (): void => { macroRun = undefined },
    advanceStep: (nextStepIndex: number): void => {
      if (macroRun) macroRun.stepIndex = nextStepIndex
    },
    notifyMacroEvent,
  }
}
