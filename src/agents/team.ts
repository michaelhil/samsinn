// ============================================================================
// Team — Agent collection (AI + human).
// Simple Map. No delivery logic. No awareness of rooms or house.
// Names are unique (case-insensitive). addAgent() throws on collision.
// getAgent() accepts UUID or name (dual lookup).
// ============================================================================

import type { Agent, Team } from '../core/types.ts'
import { validateName } from '../core/names.ts'

export const createTeam = (): Team => {
  const agents = new Map<string, Agent>()       // id → agent
  const nameIndex = new Map<string, string>()   // lowercase name → id

  const addAgent = (agent: Agent): void => {
    validateName(agent.name, 'Agent')
    const lower = agent.name.toLowerCase()
    if (nameIndex.has(lower)) {
      throw new Error(`Agent name "${agent.name}" is already taken`)
    }
    agents.set(agent.id, agent)
    nameIndex.set(lower, agent.id)
  }

  const getAgent = (idOrName: string): Agent | undefined =>
    agents.get(idOrName) ?? agents.get(nameIndex.get(idOrName.toLowerCase()) ?? '')

  const removeAgent = (id: string): boolean => {
    const agent = agents.get(id)
    if (agent) nameIndex.delete(agent.name.toLowerCase())
    return agents.delete(id)
  }

  const listAgents = (): ReadonlyArray<Agent> => [...agents.values()]

  const listByKind = (kind: 'ai' | 'human'): ReadonlyArray<Agent> =>
    [...agents.values()].filter(a => a.kind === kind)

  return { addAgent, getAgent, removeAgent, listAgents, listByKind }
}
