// ============================================================================
// samsinn — UI Application
//
// Orchestrator: connects WS client, delegates rendering, handles events.
// No framework, no build step. Served as transpiled JS by the server.
// ============================================================================

import { createWSClient, type WSClient } from './ws-client.ts'
import {
  renderRoomTabs,
  renderAgents,
  renderMessage,
  renderArtifacts,
  renderThinkingIndicator,
  removeThinkingIndicator,
  type UIMessage,
  type RoomProfile,
  type AgentInfo,
  type ArtifactInfo,
  type ArtifactAction,
} from './ui-renderer.ts'
import { openTextEditorModal } from './modal.ts'
import { createWorkspace } from './workspace.ts'

// Lazy-loaded modals — only fetched on first use
const lazyFlowEditor = async (
  agents: Map<string, AgentInfo>, myAgentId: string,
  onSave: (name: string, steps: ReadonlyArray<{ agentId: string; agentName: string; stepPrompt?: string }>, loop: boolean, description?: string) => void,
) => {
  const { openFlowEditorModal } = await import('./flow-editor.ts')
  openFlowEditorModal(agents, myAgentId, onSave)
}
const lazyAgentInspector = async (name: string) => {
  const { openAgentInspector } = await import('./agent-inspector.ts')
  openAgentInspector(name)
}

// === WS Protocol Types ===

type WSOutbound =
  | { type: 'snapshot'; rooms: RoomProfile[]; agents: AgentInfo[]; agentId: string; sessionToken?: string }
  | { type: 'message'; message: UIMessage }
  | { type: 'agent_state'; agentName: string; state: string; context?: string }
  | { type: 'room_created'; profile: RoomProfile }
  | { type: 'agent_joined'; agent: AgentInfo }
  | { type: 'agent_removed'; agentName: string }
  | { type: 'error'; message: string }
  | { type: 'delivery_mode_changed'; roomName: string; mode: string; paused: boolean }
  | { type: 'mute_changed'; roomName: string; agentName: string; muted: boolean }
  | { type: 'turn_changed'; roomName: string; agentName?: string; waitingForHuman?: boolean }
  | { type: 'flow_event'; roomName: string; event: string; detail?: Record<string, unknown> }
  | { type: 'artifact_changed'; action: 'added' | 'updated' | 'removed'; artifact: ArtifactInfo }
  | { type: 'membership_changed'; roomId: string; roomName: string; agentId: string; agentName: string; action: 'added' | 'removed' }
  | { type: 'room_deleted'; roomName: string }

// === State ===

let client: WSClient | null = null
let myAgentId = ''
let myName = ''
let sessionToken = localStorage.getItem('ta_session') ?? ''
let selectedRoomId = ''
let currentDeliveryMode = 'broadcast'
const rooms = new Map<string, RoomProfile>()
const agents = new Map<string, AgentInfo>()
const roomMessages = new Map<string, UIMessage[]>()
const agentStates = new Map<string, { state: string; context?: string }>()
const mutedAgents = new Set<string>()  // agent names that are muted in current room
let roomPaused = false
const pausedRooms = new Set<string>()  // room IDs that are paused

// Artifact state — flat map keyed by artifact ID (all rooms)
const allArtifacts = new Map<string, ArtifactInfo>()

const getArtifactsForRoom = (roomId: string): ArtifactInfo[] =>
  [...allArtifacts.values()].filter(a => !a.resolvedAt && (a.scope.length === 0 || a.scope.includes(roomId)))

// Membership state per room
const roomMembers = new Map<string, Set<string>>()  // roomId → Set<agentId>

// === DOM refs ===

const $ = (sel: string) => document.querySelector(sel)!
const roomTabs = $('#room-tabs') as HTMLElement
const roomTabsBar = $('#room-tabs-bar') as HTMLElement
const roomInfoBar = $('#room-info-bar') as HTMLElement
const agentList = $('#agent-list') as HTMLElement
const noRoomState = $('#no-room-state') as HTMLElement
const chatArea = $('#chat-area') as HTMLElement
const pinnedMessagesDiv = $('#pinned-messages') as HTMLElement
const workspaceBar = $('#workspace-bar') as HTMLElement
const workspacePane = $('#workspace-pane') as HTMLElement
const workspaceContent = $('#workspace-content') as HTMLElement
const workspaceLabel = $('#workspace-label') as HTMLElement
const workspaceAddRow = $('#workspace-add-row') as HTMLElement
const artifactInput = $('#artifact-input') as HTMLInputElement
const btnArtifactSubmit = $('#btn-artifact-submit') as HTMLElement
const messagesDiv = $('#messages') as HTMLElement
const chatForm = $('#chat-form') as HTMLFormElement
const chatInput = $('#chat-input') as HTMLInputElement
// Thinking indicator timers (for cleanup)
const thinkingTimers = new Map<string, number>()
// Connection status removed — user identified by bold name in agent list
const modeSelector = $('#mode-selector') as HTMLSelectElement
const pauseToggle = $('#btn-pause-toggle') as HTMLButtonElement
const roomModeInfo = $('#room-mode-info') as HTMLElement
// flowSelector removed — flows are now in the mode selector dropdown
const nameModal = $('#name-modal') as HTMLDialogElement
const nameForm = $('#name-form') as HTMLFormElement
const roomModal = $('#room-modal') as HTMLDialogElement
const roomForm = $('#room-form') as HTMLFormElement
const agentModal = $('#agent-modal') as HTMLDialogElement
const agentForm = $('#agent-form') as HTMLFormElement

// Sidebar
const sidebar = $('#sidebar') as HTMLElement
const btnCollapseSidebar = $('#btn-collapse-sidebar') as HTMLElement
const settingsHeader = $('#settings-header') as HTMLElement
const settingsToggle = $('#settings-toggle') as HTMLElement
const settingsList = $('#settings-list') as HTMLElement
const agentsHeader = $('#agents-header') as HTMLElement
const agentsToggle = $('#agents-toggle') as HTMLElement
const toolsHeader = $('#tools-header') as HTMLElement
const toolsToggle = $('#tools-toggle') as HTMLElement
const toolsList = $('#tools-list') as HTMLElement
const skillsHeader = $('#skills-header') as HTMLElement
const skillsToggle = $('#skills-toggle') as HTMLElement
const skillsList = $('#skills-list') as HTMLElement

// Workspace
const workspace = createWorkspace({ bar: workspaceBar, pane: workspacePane, chatArea, label: workspaceLabel })

// Pinned messages state
const pinnedMessageIds = new Set<string>()
const pinnedMessageData = new Map<string, { senderId: string; content: string; senderName?: string }>()

// === Render helpers (delegate to ui-renderer) ===

const send = (data: unknown) => client?.send(data)

const handleLeaveRoom = (roomId: string): void => {
  const room = rooms.get(roomId)
  if (!room) return
  send({ type: 'remove_from_room', roomName: room.name, agentName: myName })
}
const refreshRooms = () => renderRoomTabs(roomTabs, rooms, selectedRoomId, pausedRooms, selectRoom, handleLeaveRoom)

const refreshAgents = () => {
  const room = rooms.get(selectedRoomId)
  const memberIds = room ? roomMembers.get(room.id) : undefined
  renderAgents(
    agentList, agents, agentStates, mutedAgents, myAgentId,
    (name, muted) => {
      if (room) send({ type: 'set_muted', roomName: room.name, agentName: name, muted })
    },
    (name) => lazyAgentInspector(name),
    memberIds,
    room ? (_agentId, agentName) => send({ type: 'add_to_room', roomName: room.name, agentName }) : undefined,
    room ? (_agentId, agentName) => send({ type: 'remove_from_room', roomName: room.name, agentName }) : undefined,
  )
  updateAgentsLabel()
}

const refreshModeSelector = (): void => {
  modeSelector.innerHTML = ''

  // Delivery modes
  const modes = [
    { value: 'broadcast', label: 'Broadcast' },
  ]
  for (const m of modes) {
    const opt = document.createElement('option')
    opt.value = m.value
    opt.textContent = m.label
    modeSelector.appendChild(opt)
  }

  // Flow options (from artifact store)
  const room = rooms.get(selectedRoomId)
  const flowArtifacts = room ? getArtifactsForRoom(room.id).filter(a => a.type === 'flow') : []
  // Flow separator and options — always shown
  const sep = document.createElement('option')
  sep.disabled = true
  sep.textContent = '── Flows ──'
  modeSelector.appendChild(sep)

  for (const flow of flowArtifacts) {
    const flowBody = flow.body as { loop?: boolean }
    const opt = document.createElement('option')
    opt.value = `flow:${flow.id}`
    opt.textContent = `▶ ${flow.title}${flowBody.loop ? ' ↻' : ''}`
    modeSelector.appendChild(opt)
  }

  const createOpt = document.createElement('option')
  createOpt.value = '__create_flow__'
  createOpt.textContent = '+ Create Flow'
  modeSelector.appendChild(createOpt)

  // Set selected value
  if (currentDeliveryMode === 'flow') {
    const activeFlowOpt = Array.from(modeSelector.options).find(o => o.value.startsWith('flow:'))
    if (activeFlowOpt) modeSelector.value = activeFlowOpt.value
  } else {
    modeSelector.value = currentDeliveryMode
  }

  // Pause toggle state
  pauseToggle.textContent = roomPaused ? '▶' : '⏸'
  pauseToggle.title = roomPaused ? 'Resume delivery' : 'Pause delivery'
  pauseToggle.className = `w-6 h-6 flex items-center justify-center text-sm rounded hover:bg-gray-200 ${roomPaused ? 'text-green-600' : 'text-gray-400'}`
  modeSelector.disabled = roomPaused
  modeSelector.classList.toggle('opacity-50', roomPaused)
}

const fetchArtifactsForRoom = async (room: RoomProfile): Promise<void> => {
  try {
    const res = await fetch(`/api/rooms/${encodeURIComponent(room.name)}/artifacts`)
    if (!res.ok) return
    const artifacts = await res.json() as ArtifactInfo[]
    for (const a of artifacts) allArtifacts.set(a.id, a)
    refreshWorkspace(room)
    refreshModeSelector()
  } catch { /* ignore */ }
}

const handleArtifactAction = (action: ArtifactAction): void => {
  if (action.kind === 'add_task') {
    send({ type: 'update_artifact', artifactId: action.artifactId, body: { op: 'add_task', taskContent: action.content } })
  } else if (action.kind === 'complete_task') {
    send({ type: 'update_artifact', artifactId: action.artifactId, body: { op: action.completed ? 'complete_task' : 'update_task', taskId: action.taskId, status: action.completed ? 'completed' : 'pending' } })
  } else if (action.kind === 'cast_vote') {
    send({ type: 'cast_vote', artifactId: action.artifactId, optionId: action.optionId })
  } else if (action.kind === 'remove') {
    send({ type: 'remove_artifact', artifactId: action.artifactId })
  }
}

const refreshWorkspace = (room: RoomProfile): void => {
  const artifacts = getArtifactsForRoom(room.id)
  workspace.setCount(artifacts.length)
  workspace.show()
  workspaceAddRow.classList.toggle('hidden', workspace.getMode() === 'collapsed')

  if (workspace.getMode() !== 'collapsed') {
    if (artifacts.length > 0) {
      renderArtifacts(workspaceContent, artifacts, myAgentId, handleArtifactAction)
    } else {
      workspaceContent.innerHTML = '<p class="text-xs text-gray-400 italic py-0.5">No artifacts yet</p>'
    }
  }
}

const submitArtifact = (): void => {
  const room = rooms.get(selectedRoomId)
  if (!room) return
  const title = artifactInput.value.trim()
  if (!title) return
  send({ type: 'add_artifact', artifactType: 'task_list', title, body: { tasks: [] }, scope: [room.name] })
  artifactInput.value = ''
}

btnArtifactSubmit.onclick = (e) => {
  e.stopPropagation()
  submitArtifact()
}

artifactInput.onkeydown = (e) => {
  if (e.key === 'Enter') { e.preventDefault(); submitArtifact() }
  if (e.key === 'Escape') { artifactInput.value = ''; artifactInput.blur() }
}

// --- Settings section ---
settingsHeader.onclick = () => {
  const nowHidden = settingsList.classList.toggle('hidden')
  settingsToggle.textContent = nowHidden ? '▸ Settings' : '▾ Settings'
}

// --- Collapsible sidebar sections ---
let agentsSectionExpanded = true
let toolsLoaded = false
let skillsLoaded = false
let toolCount = 0
let skillCount = 0

const updateAgentsLabel = () => {
  const arrow = agentsSectionExpanded ? '▾' : '▸'
  agentsToggle.textContent = `${arrow} Agents (${agents.size})`
}

const updateToolsLabel = (expanded: boolean) => {
  toolsToggle.textContent = `${expanded ? '▾' : '▸'} Tools${toolCount > 0 ? ` (${toolCount})` : ''}`
}

const updateSkillsLabel = (expanded: boolean) => {
  skillsToggle.textContent = `${expanded ? '▾' : '▸'} Skills${skillCount > 0 ? ` (${skillCount})` : ''}`
}

// Fetch counts eagerly on load
void fetch('/api/tools').then(r => r.ok ? r.json() : []).then((t: unknown[]) => { toolCount = t.length; updateToolsLabel(false) }).catch(() => {})
void fetch('/api/skills').then(r => r.ok ? r.json() : []).then((s: unknown[]) => { skillCount = s.length; updateSkillsLabel(false) }).catch(() => {})

agentsHeader.onclick = () => {
  agentsSectionExpanded = !agentsSectionExpanded
  agentList.classList.toggle('hidden', !agentsSectionExpanded)
  updateAgentsLabel()
}

toolsHeader.onclick = async () => {
  const nowHidden = toolsList.classList.toggle('hidden')
  updateToolsLabel(!nowHidden)
  if (!nowHidden && !toolsLoaded) {
    toolsLoaded = true
    const tools = await fetch('/api/tools').then(r => r.ok ? r.json() : []).catch(() => []) as Array<{ name: string; description: string }>
    toolCount = tools.length
    updateToolsLabel(true)
    toolsList.innerHTML = ''
    for (const t of tools) {
      const row = document.createElement('div')
      row.className = 'text-xs text-gray-600 py-0.5 px-3 hover:bg-gray-50 cursor-default truncate'
      row.title = t.description
      row.textContent = t.name
      toolsList.appendChild(row)
    }
    if (tools.length === 0) toolsList.innerHTML = '<div class="text-xs text-gray-400 px-3 py-1">No tools</div>'
  }
}

skillsHeader.onclick = async () => {
  const nowHidden = skillsList.classList.toggle('hidden')
  updateSkillsLabel(!nowHidden)
  if (!nowHidden && !skillsLoaded) {
    skillsLoaded = true
    const skills = await fetch('/api/skills').then(r => r.ok ? r.json() : []).catch(() => []) as Array<{ name: string; description: string; tools: string[] }>
    skillCount = skills.length
    updateSkillsLabel(true)
    skillsList.innerHTML = ''
    for (const s of skills) {
      const row = document.createElement('div')
      row.className = 'px-3 py-1'
      const name = document.createElement('div')
      name.className = 'text-xs font-medium text-gray-700'
      name.textContent = s.name
      const desc = document.createElement('div')
      desc.className = 'text-xs text-gray-400 truncate'
      desc.textContent = s.description
      row.appendChild(name)
      row.appendChild(desc)
      skillsList.appendChild(row)
    }
    if (skills.length === 0) skillsList.innerHTML = '<div class="text-xs text-gray-400 px-3 py-1">No skills</div>'
  }
}

// --- Sidebar collapse ---
const initSidebarCollapse = (): void => {
  const collapsed = localStorage.getItem('samsinn-sidebar-collapsed') === 'true'
  if (collapsed) sidebar.classList.add('sidebar-collapsed')

  btnCollapseSidebar.onclick = () => {
    sidebar.classList.toggle('sidebar-collapsed')
    const isCollapsed = sidebar.classList.contains('sidebar-collapsed')
    btnCollapseSidebar.textContent = isCollapsed ? '▶' : '◀'
    localStorage.setItem('samsinn-sidebar-collapsed', String(isCollapsed))
  }
}
initSidebarCollapse()

// --- Message pinning ---
const refreshPinnedMessages = (): void => {
  if (pinnedMessageIds.size === 0) {
    pinnedMessagesDiv.classList.add('hidden')
    return
  }
  pinnedMessagesDiv.classList.remove('hidden')
  pinnedMessagesDiv.innerHTML = ''
  for (const id of pinnedMessageIds) {
    const data = pinnedMessageData.get(id)
    if (!data) continue
    const row = document.createElement('div')
    row.className = 'px-3 py-1 text-xs flex items-center gap-2 border-b border-amber-100'
    const preview = data.content.length > 100 ? data.content.slice(0, 100) + '…' : data.content
    row.innerHTML = `<span class="text-amber-600">📌</span> <span class="font-medium">${data.senderName ?? 'unknown'}:</span> <span class="text-gray-600 flex-1 truncate">${preview}</span>`
    const unpin = document.createElement('button')
    unpin.className = 'text-amber-400 hover:text-amber-600 text-xs'
    unpin.textContent = '✕'
    unpin.onclick = () => { pinnedMessageIds.delete(id); pinnedMessageData.delete(id); refreshPinnedMessages() }
    row.appendChild(unpin)
    pinnedMessagesDiv.appendChild(row)
  }
}

const handlePin = (msgId: string, senderName: string, content: string): void => {
  pinnedMessageIds.add(msgId)
  pinnedMessageData.set(msgId, { senderId: '', content, senderName })
  refreshPinnedMessages()
}

const updateModeUI = () => {
  refreshModeSelector()

  if (currentDeliveryMode === 'flow') {
    roomModeInfo.textContent = 'Flow active'
    roomModeInfo.className = 'text-xs text-purple-500 h-4'
  } else {
    roomModeInfo.textContent = ''
    roomModeInfo.className = 'text-xs text-gray-400 h-4'
  }
}

const showThinking = (agentName: string): void => {
  // Only show if agent is generating in the current room
  const state = agentStates.get(agentName)
  if (!state || state.state !== 'generating' || state.context !== `room:${selectedRoomId}`) return
  // Don't duplicate
  if (messagesDiv.querySelector(`[data-thinking-agent="${agentName}"]`)) return
  const { timer } = renderThinkingIndicator(messagesDiv, agentName, (name) => {
    send({ type: 'cancel_generation', name })
  })
  thinkingTimers.set(agentName, timer)
}

const hideThinking = (agentName: string): void => {
  removeThinkingIndicator(messagesDiv, agentName)
  const timer = thinkingTimers.get(agentName)
  if (timer) { clearInterval(timer); thinkingTimers.delete(agentName) }
}

// === Room selection ===

const selectRoom = (roomId: string) => {
  selectedRoomId = roomId
  const room = rooms.get(roomId)
  if (!room) return

  // Show chat UI, hide empty state
  noRoomState.classList.add('hidden')
  roomTabsBar.classList.remove('hidden')
  roomInfoBar.classList.remove('hidden')
  chatArea.classList.remove('hidden')

  refreshRooms()
  updateModeUI()
  refreshWorkspace(room)
  fetchArtifactsForRoom(room)

  messagesDiv.innerHTML = ''
  const cached = roomMessages.get(roomId)
  if (cached) {
    for (const m of cached) renderMessage(messagesDiv, m, myAgentId, agents, handlePin)
  } else {
    fetchRoomMessages(room.name)
  }
  messagesDiv.scrollTop = messagesDiv.scrollHeight
}

const fetchRoomMessages = async (name: string) => {
  try {
    const res = await fetch(`/api/rooms/${encodeURIComponent(name)}?limit=50`)
    if (!res.ok) return
    const data = await res.json() as { profile: RoomProfile; messages: UIMessage[] }
    roomMessages.set(data.profile.id, data.messages)
    if (selectedRoomId === data.profile.id) {
      messagesDiv.innerHTML = ''
      for (const m of data.messages) renderMessage(messagesDiv, m, myAgentId, agents, handlePin)
      messagesDiv.scrollTop = messagesDiv.scrollHeight
    }
  } catch { /* ignore */ }
}

// === WS message handling ===

const handleMessage = (raw: unknown) => {
  const msg = raw as WSOutbound
  switch (msg.type) {
    case 'snapshot': {
      if (msg.sessionToken) {
        sessionToken = msg.sessionToken
        localStorage.setItem('ta_session', sessionToken)
      }
      myAgentId = msg.agentId
      rooms.clear(); agents.clear(); agentStates.clear(); mutedAgents.clear(); pausedRooms.clear(); roomMembers.clear(); allArtifacts.clear()
      for (const r of msg.rooms) rooms.set(r.id, r)
      for (const a of msg.agents) {
        agents.set(a.id, a)
        if (a.state === 'generating') agentStates.set(a.name, { state: 'generating' })
      }
      // Restore per-room state from snapshot
      if (msg.roomStates) {
        for (const [roomId, rs] of Object.entries(msg.roomStates as Record<string, { mode: string; paused: boolean; muted: string[]; members?: string[] }>)) {
          if (rs.paused) pausedRooms.add(roomId)
          if (rs.members) roomMembers.set(roomId, new Set(rs.members))
        }
      }
      refreshRooms(); refreshAgents()
      // Always show tabs bar when rooms exist
      if (rooms.size > 0) roomTabsBar.classList.remove('hidden')
      if (!selectedRoomId && rooms.size > 0) {
        selectRoom(rooms.values().next().value!.id)
      }
      // Apply selected room state AFTER selectRoom (which may have set selectedRoomId)
      if (msg.roomStates && selectedRoomId && msg.roomStates[selectedRoomId]) {
        const rs2 = msg.roomStates[selectedRoomId] as { mode: string; paused: boolean; muted: string[] }
        currentDeliveryMode = rs2.mode
        roomPaused = rs2.paused
        mutedAgents.clear()
        for (const id of rs2.muted) {
          const agent = agents.get(id)
          if (agent) mutedAgents.add(agent.name)
        }
        updateModeUI()
        refreshRooms()
        refreshAgents()
      }
      break
    }
    case 'message': {
      const m = msg.message
      const roomId = m.roomId ?? `dm:${m.senderId === myAgentId ? m.recipientId : m.senderId}`
      if (!roomMessages.has(roomId)) roomMessages.set(roomId, [])
      const msgs = roomMessages.get(roomId)!
      if (!msgs.some(existing => existing.id === m.id)) {
        msgs.push(m)
        // Hide thinking indicator when agent's message arrives
        const senderAgent = agents.get(m.senderId)
        if (senderAgent && m.type === 'chat') hideThinking(senderAgent.name)
        if (roomId === selectedRoomId) {
          renderMessage(messagesDiv, m, myAgentId, agents, handlePin)
          messagesDiv.scrollTop = messagesDiv.scrollHeight
        }
      }
      break
    }
    case 'agent_state': {
      agentStates.set(msg.agentName, { state: msg.state, context: msg.context })
      if (msg.state === 'generating') {
        showThinking(msg.agentName)
      } else {
        hideThinking(msg.agentName)
      }
      refreshAgents()
      break
    }
    case 'room_created': {
      rooms.set(msg.profile.id, msg.profile)
      refreshRooms()
      // Always show tabs bar when rooms exist
      if (rooms.size > 0) roomTabsBar.classList.remove('hidden')
      // Auto-select if no room is currently selected
      if (!selectedRoomId) {
        selectRoom(msg.profile.id)
      }
      break
    }
    case 'agent_joined': {
      agents.set(msg.agent.id, msg.agent)
      refreshAgents()
      break
    }
    case 'agent_removed': {
      for (const [id, agent] of agents) {
        if (agent.name === msg.agentName) { agents.delete(id); break }
      }
      agentStates.delete(msg.agentName)
      refreshAgents()
      break
    }
    case 'delivery_mode_changed': {
      currentDeliveryMode = msg.mode
      roomPaused = msg.paused
      // Update pausedRooms set for room list dots
      const changedRoom = [...rooms.values()].find(r => r.name === msg.roomName)
      if (changedRoom) {
        if (msg.paused) pausedRooms.add(changedRoom.id)
        else pausedRooms.delete(changedRoom.id)
      }
      updateModeUI()
      refreshRooms()
      break
    }
    case 'mute_changed': {
      if (msg.muted) {
        mutedAgents.add(msg.agentName)
      } else {
        mutedAgents.delete(msg.agentName)
      }
      refreshAgents()
      break
    }
    case 'turn_changed': {
      if (msg.agentName) {
        roomModeInfo.textContent = `Turn: ${msg.agentName}${msg.waitingForHuman ? ' (waiting for input)' : ''}`
        roomModeInfo.className = 'text-xs text-blue-500 h-4 font-medium'
      }
      break
    }
    case 'flow_event': {
      if (msg.event === 'completed') {
        currentDeliveryMode = 'broadcast'
        roomPaused = true
        if (selectedRoomId) pausedRooms.add(selectedRoomId)
        updateModeUI()
        refreshRooms()
      } else if (msg.event === 'step') {
        const detail = msg.detail as Record<string, unknown> | undefined
        roomModeInfo.textContent = `Flow step ${(detail?.stepIndex as number ?? 0) + 1}: ${detail?.agentName ?? '...'}`
        roomModeInfo.className = 'text-xs text-purple-500 h-4 font-medium'
      } else if (msg.event === 'cancelled') {
        currentDeliveryMode = 'broadcast'
        roomPaused = true
        updateModeUI()
      }
      break
    }
    case 'artifact_changed': {
      const { action, artifact } = msg
      if (action === 'removed') {
        allArtifacts.delete(artifact.id)
      } else {
        allArtifacts.set(artifact.id, artifact)
      }
      // Refresh if current room is affected
      const affectedRoom = rooms.get(selectedRoomId)
      if (affectedRoom && (artifact.scope.length === 0 || artifact.scope.includes(selectedRoomId))) {
        refreshWorkspace(affectedRoom)
        refreshModeSelector()
      }
      break
    }
    case 'membership_changed': {
      // Use IDs directly — no fragile name-based lookups
      if (!roomMembers.has(msg.roomId)) roomMembers.set(msg.roomId, new Set())
      const memberSet = roomMembers.get(msg.roomId)!
      if (msg.action === 'added') memberSet.add(msg.agentId)
      else memberSet.delete(msg.agentId)
      if (msg.roomId === selectedRoomId) refreshAgents()
      break
    }
    case 'room_deleted': {
      const deletedRoom = [...rooms.values()].find(r => r.name === msg.roomName)
      if (deletedRoom) {
        rooms.delete(deletedRoom.id)
        roomMembers.delete(deletedRoom.id)
        roomMessages.delete(deletedRoom.id)
        if (selectedRoomId === deletedRoom.id) {
          selectedRoomId = ''
          noRoomState.classList.remove('hidden')
          roomTabsBar.classList.add('hidden')
          roomInfoBar.classList.add('hidden')
          chatArea.classList.add('hidden')
          workspace.hide()
        }
      }
      refreshRooms()
      break
    }
    case 'error': {
      console.error('Server error:', msg.message)
      break
    }
    case 'ollama_health': {
      const health = (msg as { health: Record<string, unknown> }).health
      updateOllamaHealthUI(health)
      break
    }
    case 'ollama_metrics': {
      const metrics = (msg as { metrics: Record<string, unknown> }).metrics
      updateOllamaMetricsUI(metrics)
      break
    }
  }
}

// === Connect ===

const connect = (name: string) => {
  client = createWSClient(name, sessionToken, handleMessage, (connected) => {
    // Connection state visible through agent list + Ollama indicator
    chatInput.disabled = !connected
    if (connected) chatForm.querySelector('button')!.removeAttribute('disabled')
  })
}

// === Event handlers ===

chatForm.onsubmit = (e) => {
  e.preventDefault()
  const content = chatInput.value.trim()
  if (!content || !selectedRoomId) return
  const room = rooms.get(selectedRoomId)
  if (!room) return

  // If a flow is selected in the mode dropdown, start it with this message
  const selectedMode = modeSelector.value
  if (selectedMode.startsWith('flow:')) {
    const flowArtifactId = selectedMode.slice(5)
    send({ type: 'start_flow', roomName: room.name, flowArtifactId, content })
    chatInput.value = ''
    chatInput.placeholder = 'Type a message...'
    return
  }

  send({ type: 'post_message', target: { rooms: [room.name] }, content })
  chatInput.value = ''
}

document.getElementById('btn-create-room')!.onclick = () => roomModal.showModal()
document.getElementById('btn-create-agent')!.onclick = async () => {
  // Populate model dropdown before showing modal
  const modelSelect = agentForm.querySelector('select[name="model"]') as HTMLSelectElement
  modelSelect.innerHTML = '<option value="">Loading...</option>'
  agentModal.showModal()
  try {
    const res = await fetch('/api/models')
    const data = await res.json() as { running: string[]; available: string[] }
    modelSelect.innerHTML = ''
    const allModels = [...data.running, ...data.available]
    // Prefer the lightest model as default: qwen3:4b > llama3.2 > first available
    const preferredDefaults = ['llama3.2:latest', 'qwen3:4b', 'llama3.2:3b']
    const defaultModel = preferredDefaults.find(p => allModels.includes(p)) ?? allModels[0] ?? ''
    if (data.running.length > 0) {
      const group = document.createElement('optgroup')
      group.label = 'Running'
      for (const m of data.running) {
        const opt = document.createElement('option')
        opt.value = m; opt.textContent = m; opt.selected = m === defaultModel
        group.appendChild(opt)
      }
      modelSelect.appendChild(group)
    }
    if (data.available.length > 0) {
      const group = document.createElement('optgroup')
      group.label = 'Available'
      for (const m of data.available) {
        const opt = document.createElement('option')
        opt.value = m; opt.textContent = m; opt.selected = m === defaultModel
        group.appendChild(opt)
      }
      modelSelect.appendChild(group)
    }
    if (allModels.length === 0) {
      modelSelect.innerHTML = '<option value="">No models found</option>'
    }
  } catch {
    modelSelect.innerHTML = '<option value="">Failed to load models</option>'
  }
}

// Pause toggle
pauseToggle.onclick = () => {
  const room = rooms.get(selectedRoomId)
  if (!room) return
  send({ type: 'set_paused', roomName: room.name, paused: !roomPaused })
}

// Mode selector — controls delivery mode and flows
modeSelector.onchange = () => {
  const room = rooms.get(selectedRoomId)
  if (!room) return
  const val = modeSelector.value

  // Create flow
  if (val === '__create_flow__') {
    refreshModeSelector()  // revert selector to current state
    lazyFlowEditor(agents, myAgentId, (name, steps, loop, description) => {
      send({ type: 'add_artifact', artifactType: 'flow', title: name, body: { steps, loop }, scope: [room.name], ...(description !== undefined ? { description } : {}) })
    })
    return
  }

  // Start a flow
  if (val.startsWith('flow:')) {
    const flowArtifactId = val.slice(5)
    const content = chatInput.value.trim()
    if (!content) {
      chatInput.placeholder = 'Type a message to start the flow...'
      chatInput.focus()
      return
    }
    send({ type: 'start_flow', roomName: room.name, flowArtifactId, content })
    chatInput.value = ''
    chatInput.placeholder = 'Type a message...'
    return
  }

  // Base delivery mode (broadcast) — also unpauses
  send({ type: 'set_delivery_mode', roomName: room.name, mode: val })
}

roomForm.onsubmit = (e) => {
  e.preventDefault()
  const data = new FormData(roomForm)
  const roomPrompt = (data.get('roomPrompt') as string | null)?.trim() || undefined
  send({
    type: 'create_room',
    name: data.get('name') as string,
    ...(roomPrompt ? { roomPrompt } : {}),
  })
  roomModal.close()
  roomForm.reset()
}

agentForm.onsubmit = (e) => {
  e.preventDefault()
  const data = new FormData(agentForm)
  const rawTags = (data.get('tags') as string | null)?.trim() ?? ''
  const tags = rawTags ? rawTags.split(',').map(t => t.trim()).filter(Boolean) : undefined
  send({
    type: 'create_agent',
    config: {
      name: data.get('name') as string,
      model: data.get('model') as string,
      systemPrompt: data.get('systemPrompt') as string,
      ...(tags && tags.length > 0 ? { tags } : {}),
    },
  })
  agentModal.close()
  agentForm.reset()
}

// === Prompt editing — house, room, response format ===

const btnHousePrompt = $('#btn-house-prompt') as HTMLButtonElement
btnHousePrompt.onclick = () => openTextEditorModal(
  'House Rules', '/api/house/prompts', 'housePrompt', '/api/house/prompts',
)

const btnResponseFormat = $('#btn-response-format') as HTMLButtonElement
btnResponseFormat.onclick = () => openTextEditorModal(
  'Response Format', '/api/house/prompts', 'responseFormat', '/api/house/prompts',
)

const btnRoomPrompt = $('#btn-room-prompt') as HTMLButtonElement
btnRoomPrompt.onclick = () => {
  const room = rooms.get(selectedRoomId)
  if (!room) return
  openTextEditorModal(
    `Room Prompt — ${room.name}`,
    `/api/rooms/${encodeURIComponent(room.name)}`,
    'roomPrompt',
    `/api/rooms/${encodeURIComponent(room.name)}/prompt`,
    'PUT',
    (data) => ((data.profile as Record<string, unknown>)?.roomPrompt as string) ?? '',
  )
}

// === Ollama Dashboard ===

const ollamaStatusDot = document.getElementById('ollama-status-dot') as HTMLElement
const ollamaDashboard = document.getElementById('ollama-dashboard') as HTMLDialogElement
const ollamaDashboardClose = document.getElementById('ollama-dashboard-close') as HTMLButtonElement

const statusColors: Record<string, string> = {
  healthy: 'bg-green-500',
  degraded: 'bg-yellow-400',
  down: 'bg-red-500',
}

const updateOllamaHealthUI = (health: Record<string, unknown>): void => {
  const status = health.status as string ?? 'down'
  ollamaStatusDot.className = `inline-block w-2 h-2 rounded-full ${statusColors[status] ?? 'bg-gray-400'}`

  // Update dashboard if open
  const dotEl = document.getElementById('od-status-dot')
  const textEl = document.getElementById('od-status-text')
  const latencyEl = document.getElementById('od-latency')
  if (dotEl) dotEl.className = `inline-block w-3 h-3 rounded-full ${statusColors[status] ?? 'bg-gray-400'}`
  if (textEl) textEl.textContent = status.charAt(0).toUpperCase() + status.slice(1)
  if (latencyEl) latencyEl.textContent = `${health.latencyMs ?? 0}ms`

  // Update models
  const modelsEl = document.getElementById('od-models')
  const loaded = health.loadedModels as Array<{ name: string; sizeVram: number; expiresAt?: string }> ?? []
  if (modelsEl) {
    if (loaded.length === 0) {
      modelsEl.textContent = 'No models loaded'
    } else {
      modelsEl.innerHTML = loaded.map(m => {
        const sizeMb = Math.round(m.sizeVram / 1e6)
        const unloadBtn = `<button class="od-unload text-xs text-red-400 hover:text-red-600 ml-2" data-model="${m.name}">unload</button>`
        return `<div class="flex items-center justify-between py-0.5"><span class="font-mono text-xs">${m.name}</span><span class="text-xs text-gray-400">${sizeMb}MB${unloadBtn}</span></div>`
      }).join('')
      // Wire unload buttons
      modelsEl.querySelectorAll('.od-unload').forEach(btn => {
        btn.addEventListener('click', async () => {
          const model = (btn as HTMLElement).dataset.model
          if (model) {
            await fetch(`/api/ollama/models/${encodeURIComponent(model)}/unload`, { method: 'POST' })
          }
        })
      })
    }
  }
}

const updateOllamaMetricsUI = (metrics: Record<string, unknown>): void => {
  const tpsEl = document.getElementById('od-tps')
  const p50El = document.getElementById('od-p50')
  const errorsEl = document.getElementById('od-errors')
  const queueEl = document.getElementById('od-queue')
  const concurrentEl = document.getElementById('od-concurrent')
  const circuitEl = document.getElementById('od-circuit')
  const requestsEl = document.getElementById('od-requests')

  if (tpsEl) tpsEl.textContent = `${(metrics.avgTokensPerSecond as number ?? 0).toFixed(1)}`
  if (p50El) {
    const ms = metrics.p50Latency as number ?? 0
    p50El.textContent = ms >= 1000 ? `${(ms / 1000).toFixed(1)}s` : `${ms}ms`
  }
  if (errorsEl) errorsEl.textContent = `${((metrics.errorRate as number ?? 0) * 100).toFixed(0)}%`
  if (queueEl) queueEl.textContent = `${metrics.queueDepth ?? 0}`
  if (concurrentEl) concurrentEl.textContent = `${metrics.concurrentRequests ?? 0}`
  if (circuitEl) {
    const state = metrics.circuitState as string ?? 'closed'
    circuitEl.textContent = state
    circuitEl.className = `text-lg font-semibold ${state === 'closed' ? 'text-green-600' : state === 'open' ? 'text-red-600' : 'text-yellow-500'}`
  }
  if (requestsEl) requestsEl.textContent = `${metrics.requestCount ?? 0}`
}

// Dashboard open/close
document.getElementById('btn-ollama-dashboard')!.onclick = async () => {
  ollamaDashboard.showModal()
  send({ type: 'subscribe_ollama_metrics' } as unknown as Parameters<typeof send>[0])

  // Fetch initial data
  try {
    const [healthRes, metricsRes, configRes] = await Promise.all([
      fetch('/api/ollama/health'),
      fetch('/api/ollama/metrics'),
      fetch('/api/ollama/config'),
    ])
    if (healthRes.ok) updateOllamaHealthUI(await healthRes.json() as Record<string, unknown>)
    if (metricsRes.ok) updateOllamaMetricsUI(await metricsRes.json() as Record<string, unknown>)
    if (configRes.ok) {
      const cfg = await configRes.json() as Record<string, unknown>
      const cfgConcurrent = document.getElementById('od-cfg-concurrent') as HTMLInputElement
      const cfgQueue = document.getElementById('od-cfg-queue') as HTMLInputElement
      const cfgTimeout = document.getElementById('od-cfg-timeout') as HTMLInputElement
      const cfgKeepalive = document.getElementById('od-cfg-keepalive') as HTMLInputElement
      if (cfgConcurrent) cfgConcurrent.value = String(cfg.maxConcurrent ?? 2)
      if (cfgQueue) cfgQueue.value = String(cfg.maxQueueDepth ?? 6)
      if (cfgTimeout) cfgTimeout.value = String(cfg.queueTimeoutMs ?? 30000)
      if (cfgKeepalive) cfgKeepalive.value = String(cfg.keepAlive ?? '30m')
    }
  } catch { /* ignore fetch errors on dashboard open */ }
}

ollamaDashboardClose.onclick = () => {
  ollamaDashboard.close()
  send({ type: 'unsubscribe_ollama_metrics' } as unknown as Parameters<typeof send>[0])
}

ollamaDashboard.addEventListener('close', () => {
  send({ type: 'unsubscribe_ollama_metrics' } as unknown as Parameters<typeof send>[0])
})

// Config save
document.getElementById('od-cfg-save')!.onclick = async () => {
  const body: Record<string, unknown> = {}
  const cfgConcurrent = document.getElementById('od-cfg-concurrent') as HTMLInputElement
  const cfgQueue = document.getElementById('od-cfg-queue') as HTMLInputElement
  const cfgTimeout = document.getElementById('od-cfg-timeout') as HTMLInputElement
  const cfgKeepalive = document.getElementById('od-cfg-keepalive') as HTMLInputElement
  if (cfgConcurrent?.value) body.maxConcurrent = parseInt(cfgConcurrent.value)
  if (cfgQueue?.value) body.maxQueueDepth = parseInt(cfgQueue.value)
  if (cfgTimeout?.value) body.queueTimeoutMs = parseInt(cfgTimeout.value)
  if (cfgKeepalive?.value) body.keepAlive = cfgKeepalive.value
  await fetch('/api/ollama/config', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
}

// === Startup ===

const savedName = localStorage.getItem('ta_name')

nameForm.onsubmit = (e) => {
  e.preventDefault()
  const name = (new FormData(nameForm).get('name') as string).trim()
  if (!name) return
  myName = name
  localStorage.setItem('ta_name', name)
  nameModal.close()
  connect(name)
}

if (savedName) {
  myName = savedName
  connect(savedName)
} else {
  nameModal.showModal()
}
