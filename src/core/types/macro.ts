// Macro types — ordered agent sequences triggered by a single message.
// A macro is a reusable blueprint (stored as an artifact) plus an in-flight
// run (managed by the room). It overlays on top of the room's delivery mode.
// Leaf module.

export interface MacroStep {
  readonly agentId: string         // agent UUID (resolved once at macro creation)
  readonly agentName: string       // human-readable name (for display and LLM context)
  readonly stepPrompt?: string     // per-step instruction for this agent
}

export interface Macro {
  readonly id: string              // crypto.randomUUID() — or artifact ID when sourced from an artifact
  readonly name: string
  readonly steps: ReadonlyArray<MacroStep>
  readonly loop: boolean           // repeat or stop after one pass
  // Goal ancestry — set when macro is sourced from an artifact
  readonly artifactDescription?: string
  readonly goalChain?: ReadonlyArray<string>
}

export interface MacroRun {
  readonly macro: Macro
  readonly triggerMessageId: string
  stepIndex: number
}

// Wire-level macro-event detail, indexed by event name. Emitted by room → UI.
export interface MacroEventDetails {
  readonly started: { readonly macroId: string; readonly agentName: string }
  readonly step: { readonly macroId: string; readonly stepIndex: number; readonly agentName: string }
  readonly completed: { readonly macroId: string }
  readonly cancelled: { readonly macroId: string }
}

export type MacroEventName = keyof MacroEventDetails
export type MacroEventDetail<E extends MacroEventName = MacroEventName> = MacroEventDetails[E]

// Carried in message.metadata when delivering a macro step.
// Gives the receiving agent structural awareness of the macro.
export interface MacroStepContext {
  readonly macroName: string
  readonly stepIndex: number                                    // 0-based index of this step
  readonly totalSteps: number
  readonly loop: boolean
  readonly steps: ReadonlyArray<{ readonly agentName: string }>
  // Goal ancestry — present when macro was sourced from an artifact
  readonly artifactDescription?: string
  readonly goalChain?: ReadonlyArray<string>
}
