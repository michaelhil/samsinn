// ============================================================================
// AI Agent — Self-contained agent that uses an LLM to decide responses.
//
// Two-buffer architecture for message context:
// - Room messages: Room is the source of truth. Room delivers each message
//   with the full history preceding it. The agent stores a history snapshot
//   (accepted when the incoming buffer is empty for that context) and an
//   incoming buffer (fresh messages not yet seen by the LLM).
// - DM messages: stored locally (no Room involved).
//
// buildContext() formats history as old context and incoming as [NEW] messages,
// so the LLM can prioritise fresh arrivals. After the LLM responds, incoming
// is flushed and appended to the history snapshot for re-evaluation continuity.
//
// Handles both room messages and DMs uniformly:
// - Room trigger: context from room-sourced history + incoming buffer
// - DM trigger: context from local DM history + incoming buffer
//
// ID Architecture: The agent generates its own UUID. The LLM sees names only.
// Names are resolved to UUIDs externally by resolveTarget in spawn.ts.
// The agent does NOT hold references to house, team, or postAndDeliver.
// Side effects are handled via the onDecision callback.
// ============================================================================

import type {
  AIAgent,
  AgentProfile,
  AgentState,
  AIAgentConfig,
  AgentResponse,
  ChatRequest,
  LLMProvider,
  Message,
  MessageTarget,
  Room,
  RoomProfile,
  StateSubscriber,
  StateValue,
  ToolCall,
  ToolExecutor,
} from '../core/types.ts'
import { DEFAULTS, SYSTEM_SENDER_ID } from '../core/types.ts'
import { extractAgentProfile as extractProfile } from './shared.ts'

// === Decision — what the agent wants to do after evaluation ===

export interface Decision {
  readonly response: AgentResponse
  readonly generationMs: number
  readonly triggerRoomId?: string
  readonly triggerPeerId?: string
}

export type OnDecision = (decision: Decision) => void

// === Internal response type — includes tool_call (never leaves evaluate) ===

type InternalResponse =
  | AgentResponse
  | { readonly action: 'tool_call'; readonly toolCalls: ReadonlyArray<ToolCall> }

// === Trigger key — unified identifier for rooms and DM peers ===

const triggerKey = (roomId?: string, peerId?: string): string =>
  roomId ? `room:${roomId}` : `dm:${peerId}`

// === Factory ===

export interface AIAgentOptions {
  readonly toolExecutor?: ToolExecutor
  readonly toolDescriptions?: string  // pre-formatted tool descriptions for LLM
}

export const createAIAgent = (
  config: AIAgentConfig,
  llmProvider: LLMProvider,
  onDecision: OnDecision,
  options?: AIAgentOptions,
): AIAgent => {
  const agentId = crypto.randomUUID()

  // Room message context: history snapshot from Room + incoming buffer
  const roomHistory = new Map<string, ReadonlyArray<Message>>()  // triggerKey → history snapshot
  const incoming: Message[] = []                                   // fresh messages (room + DM)

  // DM messages: stored locally (no Room source of truth)
  const dmMessages: Message[] = []

  // Agent knowledge
  const roomProfiles = new Map<string, RoomProfile>()
  const agentProfiles = new Map<string, AgentProfile>()
  const roomIds = new Set<string>()

  // Concurrency control
  const generatingContexts = new Set<string>()
  const pendingContexts = new Set<string>()
  let idleResolvers: Array<() => void> = []
  const stateSubscribers = new Set<StateSubscriber>()

  let currentSystemPrompt: string = config.systemPrompt
  const historyLimit = config.historyLimit ?? DEFAULTS.historyLimit
  const maxToolIterations = config.maxToolIterations ?? 5
  const toolExecutor = options?.toolExecutor
  const toolDescriptions = options?.toolDescriptions

  // --- State observability ---

  const notifyState = (value: StateValue, context?: string): void => {
    for (const fn of stateSubscribers) fn(value, agentId, context)
  }

  const state: AgentState = {
    get: () => generatingContexts.size > 0 ? 'generating' : 'idle',
    subscribe: (fn: StateSubscriber) => {
      stateSubscribers.add(fn)
      return () => { stateSubscribers.delete(fn) }
    },
  }

  // --- Profile extraction from join messages ---

  const extractAgentProfileFromMessage = (message: Message): void => {
    extractProfile(message, agentId, agentProfiles)
  }

  // --- DM message management ---

  const addDMMessage = (message: Message): void => {
    dmMessages.push(message)
    // Simple eviction: keep last N DM messages per peer
    const peerId = message.senderId === agentId ? message.recipientId : message.senderId
    if (!peerId) return
    const peerMsgs = dmMessages.filter(m =>
      m.roomId === undefined && (
        (m.senderId === peerId && m.recipientId === agentId) ||
        (m.senderId === agentId && m.recipientId === peerId)
      ),
    )
    if (peerMsgs.length > historyLimit) {
      const excess = peerMsgs.length - historyLimit
      const toRemove = new Set(peerMsgs.slice(0, excess).map(m => m.id))
      const kept = dmMessages.filter(m => !toRemove.has(m.id))
      dmMessages.length = 0
      dmMessages.push(...kept)
    }
  }

  const getDMMessagesForPeer = (peerId: string): ReadonlyArray<Message> => {
    const peerMsgs = dmMessages.filter(m =>
      m.roomId === undefined && (
        (m.senderId === peerId && m.recipientId === agentId) ||
        (m.senderId === agentId && m.recipientId === peerId)
      ),
    )
    if (peerMsgs.length <= historyLimit) return peerMsgs
    return peerMsgs.slice(-historyLimit)
  }

  // --- Participants for room context ---

  const getParticipantsForRoom = (roomId: string): ReadonlyArray<AgentProfile | string> => {
    // Build from history + incoming for that room
    const key = triggerKey(roomId, undefined)
    const history = roomHistory.get(key) ?? []
    const fresh = incoming.filter(m => m.roomId === roomId)
    const allMsgs = [...history, ...fresh]

    const senderIds = new Set<string>()
    for (const msg of allMsgs) {
      if (msg.senderId !== SYSTEM_SENDER_ID && msg.senderId !== agentId) {
        senderIds.add(msg.senderId)
      }
    }
    return [...senderIds].map(id => agentProfiles.get(id) ?? id)
  }

  // --- Name resolution ---

  const resolveName = (senderId: string): string => {
    if (senderId === SYSTEM_SENDER_ID) return 'System'
    if (senderId === agentId) return config.name
    return agentProfiles.get(senderId)?.name ?? senderId
  }

  // --- Idle detection — resolves when all evaluations complete ---

  const checkIdle = (): void => {
    if (generatingContexts.size === 0 && pendingContexts.size === 0) {
      const resolvers = idleResolvers
      idleResolvers = []
      for (const resolve of resolvers) resolve()
    }
  }

  const whenIdle = (timeoutMs = 30_000): Promise<void> => {
    if (generatingContexts.size === 0 && pendingContexts.size === 0) {
      return Promise.resolve()
    }
    return new Promise<void>((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error(`whenIdle timed out after ${timeoutMs}ms`)),
        timeoutMs,
      )
      idleResolvers.push(() => { clearTimeout(timer); resolve() })
    })
  }

  // --- Format messages for LLM context ---

  const formatMessage = (msg: Message, prefix: string): { role: 'user' | 'assistant'; content: string } | null => {
    if (msg.type === 'system' || msg.type === 'join' || msg.type === 'leave') return null
    if (msg.senderId === agentId) {
      return { role: 'assistant' as const, content: msg.content }
    }
    const name = resolveName(msg.senderId)
    return { role: 'user' as const, content: `${prefix}[${name}]: ${msg.content}` }
  }

  // Flush info returned by buildContext — describes which incoming messages were used
  // and should be removed after the LLM call completes.
  interface FlushInfo {
    readonly ids: Set<string>
    readonly dmMessages: Message[]
    readonly triggerRoomId?: string
  }

  const flushIncoming = (info: FlushInfo): void => {
    if (info.ids.size === 0) return

    // Collect the flushed messages before removing them
    const flushed = incoming.filter(m => info.ids.has(m.id))

    // Remove flushed messages from incoming
    const remaining = incoming.filter(m => !info.ids.has(m.id))
    incoming.length = 0
    incoming.push(...remaining)

    // Append flushed messages to room history snapshot so re-evaluations
    // (triggered by pendingContexts) still have full context.
    // The snapshot is replaced when a fresh one arrives via receive().
    if (info.triggerRoomId && flushed.length > 0) {
      const key = triggerKey(info.triggerRoomId, undefined)
      const current = roomHistory.get(key) ?? []
      roomHistory.set(key, [...current, ...flushed])
    }

    // Move flushed DMs to persistent DM store
    for (const msg of info.dmMessages) {
      addDMMessage(msg)
    }
  }

  // --- Context assembly (names only — no UUIDs shown to LLM) ---

  interface ContextResult {
    readonly messages: ChatRequest['messages']
    readonly flushInfo: FlushInfo
  }

  const buildContext = (triggerRoomId?: string, triggerPeerId?: string): ContextResult => {
    const flushIds = new Set<string>()
    const flushDMs: Message[] = []
    let systemContent = currentSystemPrompt

    // Current conversation context
    if (triggerRoomId) {
      const roomProfile = roomProfiles.get(triggerRoomId)
      if (roomProfile) {
        systemContent += `\n\nYou are in room "${roomProfile.name}".`
        if (roomProfile.description) systemContent += ` ${roomProfile.description}`
        if (roomProfile.roomPrompt) systemContent += `\n\nRoom instructions: ${roomProfile.roomPrompt}`
      }

      const participants = getParticipantsForRoom(triggerRoomId)
      if (participants.length > 0) {
        const lines = participants.map(p =>
          typeof p === 'string' ? `- ${p}` : `- ${p.name}: ${p.description} (${p.kind})`,
        )
        systemContent += `\n\nOther participants:\n${lines.join('\n')}`
      }
    } else if (triggerPeerId) {
      const peerProfile = agentProfiles.get(triggerPeerId)
      const peerName = peerProfile?.name ?? triggerPeerId
      systemContent += `\n\nThis is a direct conversation with ${peerName}.`
      if (peerProfile?.description) systemContent += ` ${peerProfile.description}`
    }

    // Available rooms — from explicit Set
    if (roomIds.size > 0) {
      const roomNames = [...roomIds]
        .map(id => roomProfiles.get(id)?.name ?? id)
        .map(name => `"${name}"`)
      systemContent += `\n\nYour rooms: ${roomNames.join(', ')}`
    }

    // Known agents — names only
    const knownAgents = [...agentProfiles.values()].filter(a => a.id !== agentId)
    if (knownAgents.length > 0) {
      const agentNames = knownAgents.map(a => `"${a.name}" (${a.kind})`)
      systemContent += `\nKnown agents: ${agentNames.join(', ')}`
    }

    // Tool descriptions (only if agent has tools)
    if (toolDescriptions) {
      systemContent += `\n\n${toolDescriptions}`
    }

    // Response format — target is optional (defaults to replying where the message came from)
    systemContent += `\n\nRespond with JSON.
To reply: {"action": "respond", "content": "..."}
To redirect to a specific room or agent: {"action": "respond", "content": "...", "target": {"rooms": ["Room Name"]}} or {"target": {"agents": ["Agent Name"]}}
To stay silent: {"action": "pass", "reason": "..."}`

    if (toolDescriptions) {
      systemContent += `\nTo call a tool: {"action": "tool_call", "toolCalls": [{"tool": "tool_name", "arguments": {...}}]}
Tool results will be provided, then you respond normally.`
    }

    systemContent += `\n\nMessages marked [NEW] have arrived since you last responded. Prioritise responding to these. Only respond when you have substantive input. Do not respond just to acknowledge.`

    // Build message array
    const chatMessages: ChatRequest['messages'][number][] = [
      { role: 'system' as const, content: systemContent },
    ]

    // Room context: history (old) + incoming (new)
    if (triggerRoomId) {
      const key = triggerKey(triggerRoomId, undefined)
      const old = roomHistory.get(key) ?? []
      const fresh = incoming.filter(m => m.roomId === triggerRoomId)

      for (const msg of old) {
        const formatted = formatMessage(msg, '')
        if (formatted) chatMessages.push(formatted)
      }
      for (const msg of fresh) {
        const formatted = formatMessage(msg, '[NEW] ')
        if (formatted) chatMessages.push(formatted)
        flushIds.add(msg.id)
      }
    }

    // DM context: local DM history (old) + incoming DMs (new)
    if (triggerPeerId) {
      const old = getDMMessagesForPeer(triggerPeerId)
      const fresh = incoming.filter(m =>
        m.roomId === undefined && (m.senderId === triggerPeerId || m.recipientId === triggerPeerId),
      )

      for (const msg of old) {
        const formatted = formatMessage(msg, '')
        if (formatted) chatMessages.push(formatted)
      }
      for (const msg of fresh) {
        const formatted = formatMessage(msg, '[NEW] ')
        if (formatted) chatMessages.push(formatted)
        flushIds.add(msg.id)
        flushDMs.push(msg)
      }
    }

    return {
      messages: chatMessages,
      flushInfo: { ids: flushIds, dmMessages: flushDMs, triggerRoomId },
    }
  }

  // --- JSON parsing with fallback ---

  const parseResponse = (raw: string): InternalResponse => {
    try {
      const parsed = JSON.parse(raw) as Record<string, unknown>
      if (parsed.action === 'respond' && typeof parsed.content === 'string' && (parsed.content as string).length > 0) {
        const target = parsed.target as MessageTarget | undefined
        if (target && ((target.rooms && target.rooms.length > 0) || (target.agents && target.agents.length > 0))) {
          return parsed as AgentResponse
        }
        return { action: 'respond', content: parsed.content as string, target: {}, actions: parsed.actions as AgentResponse['actions'] }
      }
      if (parsed.action === 'pass') {
        return { action: 'pass', reason: parsed.reason as string | undefined }
      }
      if (parsed.action === 'tool_call' && Array.isArray(parsed.toolCalls) && parsed.toolCalls.length > 0) {
        const validCalls = (parsed.toolCalls as ReadonlyArray<Record<string, unknown>>)
          .filter(c => typeof c.tool === 'string')
          .map(c => ({ tool: c.tool as string, arguments: (c.arguments ?? {}) as Record<string, unknown> }))
        if (validCalls.length > 0) {
          return { action: 'tool_call', toolCalls: validCalls }
        }
      }
      return { action: 'pass', reason: 'Invalid response structure' }
    } catch {
      return { action: 'respond', content: raw, target: {} }
    }
  }

  // --- Evaluate ---

  interface EvalResult {
    readonly decision: Decision | null
    readonly flushInfo: FlushInfo
  }

  const evaluate = async (triggerRoomId?: string, triggerPeerId?: string): Promise<EvalResult> => {
    const { messages: builtMessages, flushInfo } = buildContext(triggerRoomId, triggerPeerId)
    const context = [...builtMessages]
    let totalGenerationMs = 0

    const makeResult = (decision: Decision | null): EvalResult => ({ decision, flushInfo })

    try {
      // Loop: 1 initial call + up to maxToolIterations tool rounds
      for (let toolRound = 0; toolRound <= maxToolIterations; toolRound++) {
        const chatResponse = await llmProvider.chat({
          model: config.model,
          messages: context,
          temperature: config.temperature,
          jsonMode: true,
        })

        totalGenerationMs += chatResponse.generationMs
        const parsed = parseResponse(chatResponse.content)

        // Tool call — execute and continue loop
        if (parsed.action === 'tool_call' && toolExecutor) {
          const results = await toolExecutor(parsed.toolCalls)

          // Add assistant's tool call as context
          context.push({ role: 'assistant' as const, content: chatResponse.content })

          // Add tool results as user message
          const resultText = results
            .map((r, i) => `Tool "${parsed.toolCalls[i]?.tool}": ${r.success ? JSON.stringify(r.data) : `Error: ${r.error}`}`)
            .join('\n')
          context.push({ role: 'user' as const, content: `Tool results:\n${resultText}\n\nNow respond based on the tool results.` })

          continue
        }

        // tool_call without executor — fall back to pass
        if (parsed.action === 'tool_call') {
          return makeResult({
            response: { action: 'pass', reason: 'Tool calls not available' },
            generationMs: totalGenerationMs,
            triggerRoomId,
            triggerPeerId,
          })
        }

        // respond or pass — return decision
        return makeResult({
          response: parsed,
          generationMs: totalGenerationMs,
          triggerRoomId,
          triggerPeerId,
        })
      }

      // Max iterations reached
      return makeResult({
        response: { action: 'pass', reason: `Tool call loop exceeded ${maxToolIterations} iterations` },
        generationMs: totalGenerationMs,
        triggerRoomId,
        triggerPeerId,
      })
    } catch (err) {
      console.error(`[${config.name}] LLM call failed:`, err)
      return makeResult(null)
    }
  }

  // --- Evaluation loop: per-context generation with pending queue ---

  const tryEvaluate = (triggerRoomId?: string, triggerPeerId?: string): void => {
    const key = triggerKey(triggerRoomId, triggerPeerId)

    if (generatingContexts.has(key)) {
      pendingContexts.add(key)
      return
    }

    generatingContexts.add(key)
    notifyState('generating', key)

    evaluate(triggerRoomId, triggerPeerId)
      .then(({ decision, flushInfo }) => {
        flushIncoming(flushInfo)
        if (decision) onDecision(decision)
      })
      .catch(err => {
        console.error(`[${config.name}] Evaluation error:`, err)
      })
      .finally(() => {
        generatingContexts.delete(key)
        notifyState('idle', key)

        if (pendingContexts.has(key)) {
          pendingContexts.delete(key)
          tryEvaluate(triggerRoomId, triggerPeerId)
        } else {
          checkIdle()
        }
      })
  }

  // --- Receive ---

  const receive = (message: Message, history?: ReadonlyArray<Message>): void => {
    extractAgentProfileFromMessage(message)

    if (message.roomId) {
      const key = triggerKey(message.roomId, undefined)
      // Accept history when no unprocessed external messages exist for this room.
      // room_summary (from join) and own messages don't count — they're not from Room delivery.
      const hasUnprocessed = incoming.some(m =>
        m.roomId === message.roomId && m.type !== 'room_summary' && m.senderId !== agentId,
      )
      if (history && !hasUnprocessed) {
        roomHistory.set(key, history)
      }
      if (message.senderId === agentId) {
        // Own room messages go straight to history (not incoming) so they're
        // visible as assistant context during re-evaluations.
        const current = roomHistory.get(key) ?? []
        roomHistory.set(key, [...current, message])
      } else {
        incoming.push(message)
      }
    } else {
      // DMs: store in incoming buffer (flushed to dmMessages during buildContext)
      incoming.push(message)
    }

    if (message.senderId === agentId) return
    if (message.type === 'system' || message.type === 'leave') return

    if (message.roomId) {
      tryEvaluate(message.roomId, undefined)
    } else {
      tryEvaluate(undefined, message.senderId)
    }
  }

  // --- Join ---

  const join = async (room: Room): Promise<void> => {
    roomProfiles.set(room.profile.id, room.profile)
    roomIds.add(room.profile.id)

    const recent = room.getRecent(historyLimit)
    if (recent.length === 0) return

    for (const msg of recent) {
      extractAgentProfileFromMessage(msg)
    }

    const messageLines = recent
      .filter(m => m.type === 'chat' || m.type === 'room_summary')
      .map(m => `[${resolveName(m.senderId)}]: ${m.content}`)
      .join('\n')

    if (messageLines.length === 0) return

    try {
      const summaryResponse = await llmProvider.chat({
        model: config.model,
        messages: [
          {
            role: 'system',
            content: `Summarize the following room discussion concisely. When referring to participants, always use the format [participantName]. Include: 1) Main topics discussed 2) Key positions held by each participant 3) Any decisions or open questions. Be brief — this summary helps a new participant catch up.`,
          },
          {
            role: 'user',
            content: `Room: "${room.profile.name}"${room.profile.description ? ` — ${room.profile.description}` : ''}\n\nRecent discussion:\n${messageLines}`,
          },
        ],
        temperature: 0.3,
      })

      const summaryMessage: Message = {
        id: crypto.randomUUID(),
        roomId: room.profile.id,
        senderId: SYSTEM_SENDER_ID,
        content: summaryResponse.content,
        timestamp: Date.now(),
        type: 'room_summary',
      }
      // Store summary in incoming so it appears in next context build
      incoming.push(summaryMessage)
    } catch (err) {
      console.error(`[${config.name}] Failed to generate join summary for ${room.profile.name}:`, err)
    }
  }

  // --- Query — synchronous side-channel for tool-based inter-agent communication ---
  // Same LLM, same personality, no message history involvement, no onDecision.
  // Returns the response text directly to the caller.

  let queryActive = false

  const query = async (question: string, askerId: string, askerName?: string): Promise<string> => {
    if (queryActive) throw new Error(`${config.name} is already processing a query`)
    queryActive = true

    try {
      const name = askerName ?? agentProfiles.get(askerId)?.name ?? askerId
      const response = await llmProvider.chat({
        model: config.model,
        messages: [
          { role: 'system', content: currentSystemPrompt },
          { role: 'user', content: `[${name}] asks: ${question}` },
        ],
        temperature: config.temperature,
      })
      return response.content
    } finally {
      queryActive = false
    }
  }

  return {
    id: agentId,
    name: config.name,
    description: config.description,
    kind: 'ai',
    metadata: { model: config.model },
    state,
    receive,
    join,
    getRoomIds: () => [...roomIds],
    whenIdle,
    query,
    updateSystemPrompt: (prompt: string) => { currentSystemPrompt = prompt },
    getSystemPrompt: () => currentSystemPrompt,
  }
}
