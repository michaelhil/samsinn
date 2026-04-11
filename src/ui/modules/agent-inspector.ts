// ============================================================================
// Agent Inspector Modal — Memory inspection + management.
//
// Shows agent memory stats, room histories with expand/collapse,
// per-message delete, per-room clear, and clear-all.
// ============================================================================

import { createModal } from './modal.ts'

interface MemoryStats {
  rooms: Array<{ roomId: string; roomName: string; messageCount: number; lastActiveAt?: number }>
  incomingCount: number
  knownAgents: string[]
}

const escapeHtml = (s: string): string =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

const formatTimeAgo = (timestamp: number): string => {
  const seconds = Math.floor((Date.now() - timestamp) / 1000)
  if (seconds < 60) return 'just now'
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`
  return `${Math.floor(seconds / 86400)}d ago`
}

const safeFetchJson = async <T>(url: string, init?: RequestInit): Promise<T | null> => {
  try {
    const res = await fetch(url, init)
    if (!res.ok) return null
    return await res.json() as T
  } catch {
    return null
  }
}

const renderMemoryMessage = (
  msg: { id: string; senderName?: string; content: string; timestamp: number },
  agentEnc: string,
  roomId: string,
  onRefresh: () => Promise<void>,
): HTMLElement => {
  const row = document.createElement('div')
  row.className = 'px-3 py-1.5 text-xs border-b border-gray-50 flex items-start gap-2 group hover:bg-gray-50'

  const text = document.createElement('div')
  text.className = 'flex-1 min-w-0'
  const sender = msg.senderName ?? 'unknown'
  const preview = msg.content.length > 120 ? msg.content.slice(0, 120) + '…' : msg.content
  text.innerHTML = `<span class="font-medium text-gray-600">[${escapeHtml(sender)}]</span> <span class="text-gray-500">${escapeHtml(preview)}</span>`
  row.appendChild(text)

  const delBtn = document.createElement('button')
  delBtn.className = 'text-red-300 hover:text-red-500 opacity-0 group-hover:opacity-100 flex-shrink-0 text-xs'
  delBtn.textContent = '×'
  delBtn.title = 'Delete from agent memory'
  delBtn.onclick = async (e) => {
    e.stopPropagation()
    await safeFetchJson(`/api/agents/${agentEnc}/memory/${encodeURIComponent(roomId)}/${encodeURIComponent(msg.id)}`, { method: 'DELETE' })
    await onRefresh()
  }
  row.appendChild(delBtn)

  return row
}

export const openAgentInspector = (agentName: string): void => {
  const enc = encodeURIComponent(agentName)

  const modal = createModal({ title: agentName, width: 'max-w-2xl' })
  const content = document.createElement('div')
  content.textContent = 'Loading…'
  content.className = 'text-sm text-gray-400'
  modal.body.appendChild(content)
  document.body.appendChild(modal.overlay)

  const renderInspector = async (): Promise<void> => {
    const [agentRes, stats] = await Promise.all([
      safeFetchJson<Record<string, unknown>>(`/api/agents/${enc}`),
      safeFetchJson<MemoryStats>(`/api/agents/${enc}/memory`),
    ])

    content.innerHTML = ''
    if (!agentRes || !stats) {
      content.className = 'text-sm text-red-500'
      content.textContent = 'Failed to load agent data'
      return
    }
    content.className = ''

    // Add model selector + state next to the title in the modal header
    const titleEl = modal.body.querySelector('h3')
    if (titleEl) {
      const modelSelect = document.createElement('select')
      modelSelect.className = 'text-sm text-gray-500 font-normal ml-2 border-none bg-transparent cursor-pointer hover:text-blue-500 focus:outline-none'
      modelSelect.innerHTML = `<option value="">${agentRes.model ?? 'n/a'}</option>`

      // Load models lazily on first click
      let modelsLoaded = false
      modelSelect.onfocus = async () => {
        if (modelsLoaded) return
        modelsLoaded = true
        const data = await safeFetchJson<{ running: string[]; available: string[] }>('/api/models')
        if (!data) return
        modelSelect.innerHTML = ''
        const allModels = [...(data.running ?? []), ...(data.available ?? [])]
        for (const m of allModels) {
          const opt = document.createElement('option')
          opt.value = m
          opt.textContent = m
          if (m === agentRes.model) opt.selected = true
          modelSelect.appendChild(opt)
        }
      }

      modelSelect.onchange = async () => {
        if (!modelSelect.value) return
        await safeFetchJson(`/api/agents/${enc}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ model: modelSelect.value }),
        })
      }

      const stateDot = document.createElement('span')
      const isGenerating = agentRes.state === 'generating'
      stateDot.className = `inline-block w-2.5 h-2.5 rounded-full ml-2 ${isGenerating ? 'bg-yellow-400 typing-indicator' : 'bg-green-400'}`
      stateDot.title = String(agentRes.state ?? 'unknown')

      titleEl.insertBefore(stateDot, titleEl.firstChild)
      titleEl.appendChild(modelSelect)
    }

    const promptActions = document.createElement('div')
    promptActions.className = 'flex items-center justify-between mb-1'
    const promptLabel = document.createElement('span')
    promptLabel.className = 'text-xs font-semibold text-gray-400 uppercase tracking-wide'
    promptLabel.textContent = 'Agent prompt'
    promptActions.appendChild(promptLabel)

    const promptArea = document.createElement('textarea')
    promptArea.className = 'w-full border rounded p-2 text-xs font-mono resize-y focus:outline-none focus:ring-2 focus:ring-blue-300 mb-3'
    promptArea.style.height = '5rem'
    promptArea.value = (agentRes.systemPrompt as string) ?? ''
    const savePromptBtn = document.createElement('button')
    savePromptBtn.className = 'text-xs px-3 py-1 bg-gray-300 text-white rounded cursor-not-allowed'
    savePromptBtn.textContent = 'Update'
    let savedPrompt = promptArea.value

    const updateButtonStyle = (): void => {
      const dirty = promptArea.value !== savedPrompt
      savePromptBtn.className = dirty
        ? 'text-xs px-3 py-1 bg-blue-500 text-white rounded hover:bg-blue-600 cursor-pointer'
        : 'text-xs px-3 py-1 bg-gray-300 text-white rounded cursor-not-allowed'
    }

    promptArea.oninput = updateButtonStyle

    savePromptBtn.onclick = async () => {
      if (promptArea.value === savedPrompt) return
      await safeFetchJson(`/api/agents/${enc}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ systemPrompt: promptArea.value }),
      })
      savedPrompt = promptArea.value
      updateButtonStyle()
      // Show confirmation toast overlay
      const toast = document.createElement('div')
      toast.className = 'absolute left-1/2 -translate-x-1/2 bg-green-600 text-white text-xs px-3 py-1 rounded shadow transition-opacity duration-700'
      toast.style.bottom = '4px'
      toast.textContent = 'Prompt updated'
      promptActions.style.position = 'relative'
      promptActions.appendChild(toast)
      setTimeout(() => { toast.style.opacity = '0' }, 2000)
      setTimeout(() => { toast.remove() }, 3000)
    }
    promptActions.appendChild(savePromptBtn)
    content.appendChild(promptActions)
    content.appendChild(promptArea)

    // Memory section label
    const sepLabel = document.createElement('div')
    sepLabel.className = 'text-xs font-semibold text-gray-400 uppercase tracking-wide mb-2 border-t border-gray-200 pt-3'
    sepLabel.textContent = 'Memory'
    content.appendChild(sepLabel)

    // Summary + clear all
    const summaryRow = document.createElement('div')
    summaryRow.className = 'flex items-center justify-between mb-3'
    const summaryText = document.createElement('span')
    summaryText.className = 'text-sm text-gray-600'
    const totalMsgs = stats.rooms.reduce((sum, r) => sum + r.messageCount, 0)
    summaryText.textContent = `${totalMsgs} messages across ${stats.rooms.length} rooms · ${stats.incomingCount} incoming`
    if (stats.knownAgents.length > 0) {
      summaryText.textContent += ` · Knows: ${stats.knownAgents.join(', ')}`
    }
    summaryRow.appendChild(summaryText)

    if (totalMsgs > 0 || stats.incomingCount > 0) {
      const clearAllBtn = document.createElement('button')
      clearAllBtn.className = 'text-xs text-red-400 hover:text-red-600 px-2 py-1 rounded hover:bg-red-50'
      clearAllBtn.textContent = 'Clear All'
      clearAllBtn.onclick = async () => {
        await safeFetchJson(`/api/agents/${enc}/memory`, { method: 'DELETE' })
        await renderInspector()
      }
      summaryRow.appendChild(clearAllBtn)
    }
    content.appendChild(summaryRow)

    // Room list
    for (const room of stats.rooms) {
      const roomDiv = document.createElement('div')
      roomDiv.className = 'border border-gray-100 rounded mb-2'

      const roomHeader = document.createElement('div')
      roomHeader.className = 'flex items-center justify-between px-3 py-2 cursor-pointer hover:bg-gray-50'

      const roomLabel = document.createElement('span')
      roomLabel.className = 'text-sm font-medium text-gray-700'
      const ago = room.lastActiveAt ? formatTimeAgo(room.lastActiveAt) : 'never'
      roomLabel.textContent = `▸ ${room.roomName} (${room.messageCount} msgs, ${ago})`
      roomHeader.appendChild(roomLabel)

      if (room.messageCount > 0) {
        const clearBtn = document.createElement('button')
        clearBtn.className = 'text-xs text-red-400 hover:text-red-600 px-2 py-1 rounded hover:bg-red-50'
        clearBtn.textContent = 'Clear'
        clearBtn.onclick = async (e) => {
          e.stopPropagation()
          await safeFetchJson(`/api/agents/${enc}/memory/${encodeURIComponent(room.roomId)}`, { method: 'DELETE' })
          await renderInspector()
        }
        roomHeader.appendChild(clearBtn)
      }

      const messagesContainer = document.createElement('div')
      messagesContainer.className = 'hidden'

      let expanded = false
      roomHeader.onclick = async () => {
        if (expanded) {
          messagesContainer.className = 'hidden'
          roomLabel.textContent = `▸ ${room.roomName} (${room.messageCount} msgs, ${ago})`
          expanded = false
          return
        }
        expanded = true
        roomLabel.textContent = `▾ ${room.roomName} (${room.messageCount} msgs, ${ago})`
        messagesContainer.className = 'border-t border-gray-100 max-h-64 overflow-y-auto'
        messagesContainer.innerHTML = ''

        type MessageItem = { id: string; senderName?: string; content: string; timestamp: number }
        const messages = await safeFetchJson<MessageItem[]>(`/api/agents/${enc}/memory/${encodeURIComponent(room.roomId)}`)
        if (!messages) {
          messagesContainer.textContent = 'Failed to load'
          messagesContainer.className = 'px-3 py-2 text-xs text-red-400'
          return
        }

        const toShow = messages.slice(-10)
        const hasMore = messages.length > 10

        if (hasMore) {
          const loadMore = document.createElement('div')
          loadMore.className = 'px-3 py-1 text-xs text-blue-500 cursor-pointer hover:bg-blue-50'
          loadMore.textContent = `Load ${messages.length - 10} more…`
          loadMore.onclick = () => {
            loadMore.remove()
            const older = messages.slice(0, -10)
            const fragment = document.createDocumentFragment()
            for (const msg of older) fragment.appendChild(renderMemoryMessage(msg, enc, room.roomId, renderInspector))
            messagesContainer.insertBefore(fragment, messagesContainer.firstChild)
          }
          messagesContainer.appendChild(loadMore)
        }

        for (const msg of toShow) {
          messagesContainer.appendChild(renderMemoryMessage(msg, enc, room.roomId, renderInspector))
        }
      }

      roomDiv.appendChild(roomHeader)
      roomDiv.appendChild(messagesContainer)
      content.appendChild(roomDiv)
    }

    if (stats.rooms.length === 0) {
      const empty = document.createElement('div')
      empty.className = 'text-sm text-gray-400 italic'
      empty.textContent = 'No room history'
      content.appendChild(empty)
    }
  }

  void renderInspector()
}
