// ============================================================================
// Shared agent utilities — profile extraction and join metadata.
// ============================================================================

import type { Agent, AIAgent } from '../core/types/agent.ts'
import type { AgentProfile, Message } from '../core/types/messaging.ts'

// Extract agent profile from a join message's typed fields.
// Called by both AI and human agents in receive() and join().
export const extractAgentProfile = (
  message: Message,
  ownId: string,
  profiles: Map<string, AgentProfile>,
): void => {
  if (message.type !== 'join') return
  if (message.senderId === ownId) return

  const { agentName, agentKind, agentTags } = message
  if (!agentName || !agentKind) return

  profiles.set(message.senderId, {
    id: message.senderId,
    name: agentName,
    kind: agentKind,
    ...(agentTags && agentTags.length > 0 ? { tags: agentTags } : {}),
  })
}

// Build join-message fields from an agent's public profile. Used by
// spawn.ts and actions.ts when posting join messages; the returned object
// is spread onto the PostParams.
export const makeJoinFields = (agent: Agent): Pick<Message, 'agentName' | 'agentKind' | 'agentTags'> => {
  const tags = agent.metadata?.tags as ReadonlyArray<string> | undefined
  return {
    agentName: agent.name,
    agentKind: agent.kind,
    ...(tags && tags.length > 0 ? { agentTags: tags } : {}),
  }
}

// Type-safe AI agent narrowing. Returns AIAgent if kind === 'ai', undefined otherwise.
// Use instead of manual `agent.kind === 'ai'` + `as AIAgent` casts.
export const asAIAgent = (agent: Agent): AIAgent | undefined =>
  agent.kind === 'ai' ? agent as AIAgent : undefined
