// Agent types — Agent, AIAgent, state observability, team membership,
// AI configuration, response shape, and message-routing coordination.

import type { Message, MessageTarget, PostParams } from './messaging.ts'
import type { ToolDefinition, ToolExecutor } from './tool.ts'
import type { Room, House } from './room.ts'

// === Agent State — subscribe/get pattern for observability ===

export type StateValue = 'idle' | 'generating'

export interface AgentState {
  readonly get: () => StateValue
  readonly getContext: () => string | undefined
  readonly subscribe: (fn: StateSubscriber) => () => void
}

export type StateSubscriber = (state: StateValue, agentId: string, context?: string) => void

// === Agent — unified interface for AI agents and humans ===

export interface Agent {
  readonly id: string
  readonly name: string
  readonly kind: 'ai' | 'human'
  readonly metadata: Record<string, unknown>
  readonly state: AgentState
  readonly receive: (message: Message) => void
  readonly join: (room: Room) => Promise<void>
  readonly leave: (roomId: string) => void
  readonly inactive?: boolean
  readonly setInactive?: (value: boolean) => void
  readonly getDescription?: () => string
  readonly updateDescription?: (desc: string) => void
}

// === AIAgent — extended Agent with observability ===

export interface AIAgent extends Agent {
  readonly whenIdle: (timeoutMs?: number) => Promise<void>
  readonly updateSystemPrompt: (prompt: string) => void
  readonly getSystemPrompt: () => string
  readonly updateModel: (model: string) => void
  readonly getModel: () => string
  readonly cancelGeneration: () => void
  readonly getTemperature: () => number | undefined
  readonly updateTemperature?: (t: number | undefined) => void
  readonly getHistoryLimit: () => number | undefined
  readonly updateHistoryLimit?: (n: number) => void
  readonly getThinking: () => boolean
  readonly updateThinking?: (enabled: boolean) => void
  readonly getTools: () => ReadonlyArray<string> | undefined
  readonly refreshTools?: (support: { toolExecutor?: ToolExecutor; toolDefinitions?: ReadonlyArray<ToolDefinition> }) => void
  // Memory introspection + management
  readonly getHistory?: (roomId: string) => ReadonlyArray<Message>
  readonly getIncoming?: () => ReadonlyArray<Message>
  readonly getMemoryStats?: () => AgentMemoryStats
  readonly clearHistory?: (roomId?: string) => void
  readonly deleteHistoryMessage?: (roomId: string, messageId: string) => boolean
  // Returns a snapshot of the agent's current configuration (mutable fields resolved).
  // Use this when you need multiple config fields at once (e.g. for serialization).
  readonly getConfig: () => AIAgentConfig
}

export interface AgentMemoryStats {
  readonly rooms: ReadonlyArray<{
    readonly roomId: string
    readonly roomName: string
    readonly messageCount: number
    readonly lastActiveAt?: number
  }>
  readonly incomingCount: number
  readonly knownAgents: ReadonlyArray<string>
}

// === Team — agent collection (AI + human) ===

export interface Team {
  readonly addAgent: (agent: Agent) => void
  readonly getAgent: (idOrName: string) => Agent | undefined
  readonly removeAgent: (id: string) => boolean
  readonly listAgents: () => ReadonlyArray<Agent>
  readonly listByKind: (kind: 'ai' | 'human') => ReadonlyArray<Agent>
  readonly listByTag: (tag: string) => ReadonlyArray<Agent>
}

// === Message router — single coordination function ===

export interface RouterDeps {
  readonly house: House
}

export type RouteMessage = (target: MessageTarget, params: PostParams) => ReadonlyArray<Message>

// === AI Agent Configuration ===
// No ID field — system generates UUID automatically.

export interface AIAgentConfig {
  readonly name: string
  readonly model: string
  readonly systemPrompt: string
  readonly temperature?: number
  readonly historyLimit?: number
  readonly tools?: ReadonlyArray<string>        // tool names this agent can use
  readonly maxToolIterations?: number           // default 5
  readonly maxToolResultChars?: number          // default: 4000
  readonly tags?: ReadonlyArray<string>         // capability/role tags for [[tag:X]] addressing
  readonly thinking?: boolean                    // enable model CoT (qwen3 thinking mode)
  readonly compressionThreshold?: number        // history length triggering LLM compression (default: 3 × historyLimit)
}

// === Agent Response (parsed from LLM plain text output) ===

export type AgentResponse =
  | {
      readonly action: 'respond'
      readonly content: string
    }
  | {
      readonly action: 'pass'
      readonly reason?: string
    }
