// ============================================================================
// WebSocket Handler — WS protocol, session management, and broadcasting.
//
// Handles upgrade, message dispatch, reconnection, and inactive agent reclaim.
// Commands mirror REST endpoints but use a simpler JSON message protocol.
//
// Command modules live in ws-commands/: room, agent, artifact, message.
// The dispatch loop tries each handler in order; first match wins.
// ============================================================================

import type { System } from '../main.ts'
import type { HumanAgent } from '../agents/human-agent.ts'
import type { AgentProfile } from '../core/types/messaging.ts'
import type { RoomState } from '../core/types/room.ts'
import type { StateValue } from '../core/types/agent.ts'
import type { WSInbound, WSOutbound } from '../core/types/ws-protocol.ts'
import { asAIAgent } from '../agents/shared.ts'
import { handleRoomCommand } from './ws-commands/room-commands.ts'
import { handleAgentCommand } from './ws-commands/agent-commands.ts'
import { handleArtifactCommand } from './ws-commands/artifact-commands.ts'
import { handleMessageCommand } from './ws-commands/message-commands.ts'
import { sendError } from './ws-commands/types.ts'

// === Types ===

export interface ClientSession {
  readonly agent: HumanAgent
  readonly instanceId: string         // which per-tenant House this session belongs to
  lastActivity: number
}

export interface WSData {
  sessionToken: string
  instanceId: string                  // bound at upgrade from cookie
  name?: string
  reconnect?: boolean
}

// === Session + State Management ===

export interface WSManager {
  readonly sessions: Map<string, ClientSession>
  readonly wsConnections: Map<string, { send: (data: string) => void }>
  // Global broadcast — used for shared state (Ollama health, reset, etc.)
  // that applies regardless of which instance a client belongs to.
  readonly broadcast: (msg: WSOutbound) => void
  // Per-instance broadcast — only delivers to ws connections whose session
  // has matching instanceId. Used by wireSystemEvents so an event fired in
  // instance A doesn't reach instance B's clients.
  readonly broadcastToInstance: (instanceId: string, msg: WSOutbound) => void
  readonly subscribeAgentState: (agentId: string, agentName: string) => void
  readonly unsubscribeAgentState: (agentId: string) => void
  readonly subscribeOllamaMetrics: (sessionToken: string) => void
  readonly unsubscribeOllamaMetrics: (sessionToken: string) => void
  readonly buildSnapshot: (agentId: string, sessionToken?: string) => Extract<WSOutbound, { type: 'snapshot' }>
}

export const createWSManager = (system: System): WSManager => {
  const sessions = new Map<string, ClientSession>()
  const wsConnections = new Map<string, { send: (data: string) => void }>()
  const stateUnsubs = new Map<string, () => void>()

  const broadcast = (msg: WSOutbound): void => {
    const data = JSON.stringify(msg)
    for (const ws of wsConnections.values()) {
      try { ws.send(data) } catch { /* client gone */ }
    }
  }

  // Per-instance broadcast — filters wsConnections by session.instanceId
  // so events fired in one tenant don't reach another tenant's clients.
  const broadcastToInstance = (instanceId: string, msg: WSOutbound): void => {
    const data = JSON.stringify(msg)
    for (const [token, session] of sessions) {
      if (session.instanceId !== instanceId) continue
      const ws = wsConnections.get(token)
      if (!ws) continue
      try { ws.send(data) } catch { /* client gone */ }
    }
  }

  // System callback wiring (room/membership/agent-activity/provider-events/
  // summary lifecycle/ollama-health) lives in src/api/wire-system-events.ts.
  // Called once per System (here for now via the call site in createServer
  // for backward compat; Phase F4 moves it into registry.onSystemCreated).

  // Subscribe-based ollama metrics push (keyed by agent ID)
  const metricsSubscribers = new Set<string>()
  let metricsPushTimer: ReturnType<typeof setInterval> | undefined

  const startMetricsPush = (): void => {
    if (metricsPushTimer) return
    metricsPushTimer = setInterval(() => {
      if (metricsSubscribers.size === 0) return
      if (!system.ollama) return
      const metrics = system.ollama.getMetrics()
      const data = JSON.stringify({ type: 'ollama_metrics', metrics })
      // Find WS connections for subscribed agents
      for (const agentId of metricsSubscribers) {
        for (const [token, session] of sessions) {
          if (session.agent.id === agentId) {
            const ws = wsConnections.get(token)
            if (ws) try { ws.send(data) } catch { /* client gone */ }
          }
        }
      }
    }, 3_000)
  }

  const subscribeOllamaMetrics = (agentId: string): void => {
    metricsSubscribers.add(agentId)
    startMetricsPush()
  }

  const unsubscribeOllamaMetrics = (agentId: string): void => {
    metricsSubscribers.delete(agentId)
    if (metricsSubscribers.size === 0 && metricsPushTimer) {
      clearInterval(metricsPushTimer)
      metricsPushTimer = undefined
    }
  }

  const subscribeAgentState = (agentId: string, agentName: string): void => {
    const agent = system.team.getAgent(agentId)
    if (!agent || agent.kind !== 'ai') return
    const unsub = agent.state.subscribe((state: StateValue, _agentId: string, context?: string) => {
      broadcast({ type: 'agent_state', agentName, state, context })
    })
    stateUnsubs.set(agentId, unsub)
  }

  const unsubscribeAgentState = (agentId: string): void => {
    const unsub = stateUnsubs.get(agentId)
    if (unsub) {
      unsub()
      stateUnsubs.delete(agentId)
    }
  }

  // Existing-agent subscription seeding moved into wireSystemEvents so
  // it runs at the right time (after the System is fully populated by
  // any snapshot restore). Single-tenant boot path calls wireSystemEvents
  // immediately after createWSManager, so behavior is preserved.

  const buildSnapshot = (agentId: string, sessionToken?: string): Extract<WSOutbound, { type: 'snapshot' }> => {
    const roomStates: Record<string, RoomState> = {}
    for (const profile of system.house.listAllRooms()) {
      const room = system.house.getRoom(profile.id)
      if (room) roomStates[profile.id] = room.getRoomState()
    }
    const agents: AgentProfile[] = system.team.listAgents()
      .filter(a => !a.inactive)
      .map(a => {
        const ai = asAIAgent(a)
        const ctx = a.state.getContext()
        return { id: a.id, name: a.name, kind: a.kind, state: a.state.get(), ...(ctx ? { context: ctx } : {}), ...(ai ? { model: ai.getModel() } : {}) }
      })
    return {
      type: 'snapshot',
      rooms: system.house.listAllRooms(),
      agents,
      agentId,
      roomStates,
      ...(sessionToken ? { sessionToken } : {}),
    }
  }

  return { sessions, wsConnections, broadcast, broadcastToInstance, subscribeAgentState, unsubscribeAgentState, subscribeOllamaMetrics, unsubscribeOllamaMetrics, buildSnapshot }
}

// === Command dispatch order — first handler that returns true wins ===

const commandHandlers = [
  handleMessageCommand,
  handleRoomCommand,
  handleAgentCommand,
  handleArtifactCommand,
]

// === Message Handler ===

export const handleWSMessage = async (
  ws: { send: (data: string) => void },
  session: ClientSession,
  raw: string,
  system: System,
  wsManager: WSManager,
): Promise<void> => {
  let msg: WSInbound
  try {
    msg = JSON.parse(raw) as WSInbound
  } catch {
    sendError(ws, 'Invalid JSON')
    return
  }

  // Handle ollama metrics subscribe/unsubscribe
  const msgType = (msg as Record<string, unknown>).type
  if (msgType === 'subscribe_ollama_metrics') {
    wsManager.subscribeOllamaMetrics(session.agent.id)
    return
  }
  if (msgType === 'unsubscribe_ollama_metrics') {
    wsManager.unsubscribeOllamaMetrics(session.agent.id)
    return
  }

  const ctx = { ws, session, system, broadcast: wsManager.broadcast, wsManager }

  try {
    for (const handler of commandHandlers) {
      if (await handler(msg, ctx)) return
    }
    sendError(ws, `Unknown message type: ${(msg as Record<string, unknown>).type}`)
  } catch (err) {
    sendError(ws, err instanceof Error ? err.message : 'Command failed')
  }
}
