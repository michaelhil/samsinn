// Agent list rendering — compact one-line rows grouped by in-room / not-in-room.

import type { AgentInfo } from './render-types.ts'

const renderAgentRow = (
  agent: AgentInfo,
  isInRoom: boolean,
  isMuted: boolean,
  isGenerating: boolean,
  isSelf: boolean,
  isSelected: boolean,
  onToggleMute: (agentName: string, muted: boolean) => void,
  onInspect?: (agentName: string) => void,
  roomAction?: { onAdd?: (id: string, name: string) => void; onRemove?: (id: string, name: string) => void },
): HTMLElement => {
  const div = document.createElement('div')
  div.className = `px-3 py-1 flex items-center gap-1.5 group relative ${isSelected ? 'bg-blue-50' : ''} ${isMuted ? 'opacity-40' : ''} ${!isInRoom && !isSelected ? 'opacity-40' : ''}`

  const dot = document.createElement('span')
  const dotColor = isMuted ? 'bg-gray-300' : isGenerating ? 'bg-yellow-400 typing-indicator' : 'bg-green-400'
  dot.className = `inline-block w-2 h-2 rounded-full shrink-0 ${dotColor}`
  if (agent.kind === 'ai') {
    dot.style.cursor = 'pointer'
    dot.title = isMuted ? `Unmute ${agent.name}` : `Mute ${agent.name}`
    dot.onclick = (e) => { e.stopPropagation(); onToggleMute(agent.name, !isMuted) }
  }
  div.appendChild(dot)

  const name = document.createElement('span')
  name.className = `text-xs truncate ${isSelf ? 'font-bold' : 'font-medium'} ${isMuted ? 'line-through' : ''} ${isSelected ? 'text-blue-700' : 'text-gray-700'}`
  name.textContent = agent.name
  if (onInspect) {
    name.style.cursor = 'pointer'
    name.onclick = (e) => { e.stopPropagation(); onInspect(agent.name) }
  }
  div.appendChild(name)

  if (roomAction) {
    if (isInRoom && roomAction.onRemove) {
      const btn = document.createElement('button')
      btn.className = 'absolute right-1 text-orange-300 hover:text-orange-600 text-xs opacity-0 group-hover:opacity-100'
      btn.textContent = '×'
      btn.title = `Remove ${agent.name} from room`
      btn.onclick = (e) => { e.stopPropagation(); roomAction.onRemove!(agent.id, agent.name) }
      div.appendChild(btn)
    } else if (!isInRoom && roomAction.onAdd) {
      const btn = document.createElement('button')
      btn.className = 'absolute right-1 text-green-400 hover:text-green-700 text-xs opacity-0 group-hover:opacity-100'
      btn.textContent = '+'
      btn.title = `Add ${agent.name} to room`
      btn.onclick = (e) => { e.stopPropagation(); roomAction.onAdd!(agent.id, agent.name) }
      div.appendChild(btn)
    }
  }

  return div
}

export interface RenderAgentsOptions {
  agents: Record<string, AgentInfo>
  mutedAgentIds: Set<string>
  myAgentId: string | null
  selectedAgentId: string | null
  roomMemberIds: string[]
  onToggleMute: (agentId: string, muted: boolean) => void
  onInspect: (agentId: string) => void
  onAddToRoom?: (agentId: string) => void
  onRemoveFromRoom?: (agentId: string) => void
}

export const renderAgents = (
  container: HTMLElement,
  opts: RenderAgentsOptions,
): void => {
  container.innerHTML = ''

  const allAgents = Object.values(opts.agents)
  const memberSet = new Set(opts.roomMemberIds)
  const hasRoom = opts.roomMemberIds.length > 0

  const inRoom = hasRoom ? allAgents.filter(a => memberSet.has(a.id)) : allAgents
  const notInRoom = hasRoom ? allAgents.filter(a => !memberSet.has(a.id)) : []

  for (const agent of [...inRoom, ...notInRoom]) {
    const isIn = !hasRoom || memberSet.has(agent.id)
    const isMuted = opts.mutedAgentIds.has(agent.id)
    const isGenerating = agent.state === 'generating'
    const isSelf = agent.id === opts.myAgentId
    const isSelected = agent.id === opts.selectedAgentId
    container.appendChild(renderAgentRow(
      agent, isIn, isMuted, isGenerating, isSelf, isSelected,
      (_name, muted) => opts.onToggleMute(agent.id, muted),
      () => opts.onInspect(agent.id),
      hasRoom ? { onAdd: !isIn ? (id) => opts.onAddToRoom?.(id) : undefined, onRemove: isIn ? (id) => opts.onRemoveFromRoom?.(id) : undefined } : undefined,
    ))
  }
}
