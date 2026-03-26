// ============================================================================
// Shared agent utilities — profile extraction and join metadata.
// ============================================================================

import type { Agent, AIAgent, AgentProfile, Message, Room } from '../core/types.ts'

// Extract agent profile from a join message's metadata.
// Called by both AI and human agents in receive() and join().
export const extractAgentProfile = (
  message: Message,
  ownId: string,
  profiles: Map<string, AgentProfile>,
): void => {
  if (message.type !== 'join' || !message.metadata) return
  if (message.senderId === ownId) return

  const meta = message.metadata
  const name = meta.agentName
  const kind = meta.agentKind

  if (typeof name === 'string' && (kind === 'ai' || kind === 'human')) {
    profiles.set(message.senderId, {
      id: message.senderId,
      name,
      kind,
    })
  }
}

// Build join message metadata from an agent's public fields.
// Used by spawn.ts and actions.ts when posting join messages.
export const makeJoinMetadata = (agent: Agent) => ({
  agentName: agent.name,
  agentKind: agent.kind,
})

// Type-safe AI agent narrowing. Returns AIAgent if kind === 'ai', undefined otherwise.
// Use instead of manual `agent.kind === 'ai'` + `as AIAgent` casts.
export const asAIAgent = (agent: Agent): AIAgent | undefined =>
  agent.kind === 'ai' ? agent as AIAgent : undefined

// Add an agent to a room — shared between HTTP routes and WS handler.
export const addAgentToRoom = async (agent: Agent, room: Room): Promise<void> => {
  room.addMember(agent.id)
  await agent.join(room)
}
