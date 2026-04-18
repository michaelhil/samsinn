// LLM provider interface and call options.

import type { ToolDefinition, NativeToolCall } from './tool.ts'

export interface ChatRequest {
  readonly model: string
  readonly messages: ReadonlyArray<{
    readonly role: 'system' | 'user' | 'assistant'
    readonly content: string
  }>
  readonly temperature?: number
  readonly maxTokens?: number
  readonly jsonMode?: boolean
  readonly tools?: ReadonlyArray<ToolDefinition>
  readonly think?: boolean
  readonly numCtx?: number
}

export interface ChatResponse {
  readonly content: string
  readonly generationMs: number
  readonly tokensUsed: {
    readonly prompt: number
    readonly completion: number
  }
  readonly toolCalls?: ReadonlyArray<NativeToolCall>
  readonly tokensPerSecond?: number
  readonly promptEvalMs?: number
  readonly modelLoadMs?: number
}

// A single streamed token/delta from the LLM
export interface StreamChunk {
  readonly delta: string   // raw text fragment — may be empty for final done chunk
  readonly done: boolean
  readonly thinking?: string  // qwen3 CoT thinking tokens (before visible response)
  readonly toolCalls?: ReadonlyArray<NativeToolCall>  // native tool calls from final chunk
}

export interface LLMProvider {
  readonly chat: (request: ChatRequest) => Promise<ChatResponse>
  readonly stream?: (request: ChatRequest, signal?: AbortSignal) => AsyncIterable<StreamChunk>
  readonly models: () => Promise<string[]>
  readonly runningModels?: () => Promise<string[]>
}

// === Standalone LLM call options ===
// Used by callLLM(), ToolContext.llm, and HouseCallbacks.callSystemLLM.
// No agent lifecycle, no history, no routing, no protocol parsing.
export interface LLMCallOptions {
  readonly model: string
  readonly systemPrompt?: string
  readonly messages: ReadonlyArray<{
    readonly role: 'user' | 'assistant'
    readonly content: string
  }>
  readonly temperature?: number
  readonly jsonMode?: boolean
}
