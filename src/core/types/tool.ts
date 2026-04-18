// Tool framework types — tool contract, registry, execution surface, and
// native tool-calling interoperability with LLM providers. Leaf module.

export interface ToolCall {
  readonly tool: string
  readonly arguments: Record<string, unknown>
}

export interface ToolResult {
  readonly success: boolean
  readonly data?: unknown
  readonly error?: string
}

// Options for tool-internal LLM calls — model is inherited from the calling agent.
export interface ToolLLMRequest {
  readonly systemPrompt?: string
  readonly messages: ReadonlyArray<{
    readonly role: 'user' | 'assistant'
    readonly content: string
  }>
  readonly temperature?: number
  readonly jsonMode?: boolean
}

export interface ToolContext {
  readonly callerId: string
  readonly callerName: string
  readonly roomId?: string          // current trigger room ID — available when tool is called from a room context
  readonly llm?: (request: ToolLLMRequest) => Promise<string>  // model inherited from calling agent at spawn time
  readonly llmStream?: (request: ToolLLMRequest) => AsyncIterable<string>  // streaming variant — yields raw deltas
  readonly maxResultChars?: number  // evaluation loop's context budget for this tool's result — tools should pre-size output to fit
}

export interface Tool {
  readonly name: string
  readonly description: string
  readonly usage?: string           // when to use / when not to — injected into LLM context
  readonly returns?: string         // human-readable description of the return value
  readonly parameters: Record<string, unknown>  // JSON Schema for LLM
  readonly execute: (params: Record<string, unknown>, context: ToolContext) => Promise<ToolResult>
}

export interface ToolRegistry {
  readonly register: (tool: Tool) => void
  readonly registerAll: (tools: ReadonlyArray<Tool>) => void
  readonly get: (name: string) => Tool | undefined
  readonly has: (name: string) => boolean
  readonly list: () => ReadonlyArray<Tool>
}

export type ToolExecutor = (calls: ReadonlyArray<ToolCall>, roomId?: string) => Promise<ReadonlyArray<ToolResult>>

// === Native tool calling (OpenAI/Ollama-compatible) ===

export interface ToolDefinition {
  readonly type: 'function'
  readonly function: {
    readonly name: string
    readonly description: string
    readonly parameters: Record<string, unknown>
  }
}

export interface NativeToolCall {
  readonly function: {
    readonly name: string
    readonly arguments: Record<string, unknown>
  }
}
