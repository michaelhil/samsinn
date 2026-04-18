// Evaluation events — real-time visibility into agent reasoning. Leaf module.

export type EvalEvent =
  | { readonly kind: 'chunk'; readonly delta: string }
  | { readonly kind: 'thinking'; readonly delta: string }
  | { readonly kind: 'tool_start'; readonly tool: string }
  | { readonly kind: 'tool_result'; readonly tool: string; readonly success: boolean; readonly preview?: string }
  | { readonly kind: 'context_ready'; readonly messages: ReadonlyArray<{ readonly role: string; readonly content: string }>; readonly model: string; readonly temperature?: number; readonly toolCount: number }
  | { readonly kind: 'warning'; readonly message: string }

export type OnEvalEvent = (agentName: string, event: EvalEvent) => void
