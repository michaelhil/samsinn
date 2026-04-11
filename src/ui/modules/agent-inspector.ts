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

    // Header: model + state
    const header = document.createElement('div')
    header.className = 'text-sm text-gray-500 mb-4'
    header.textContent = `Model: ${agentRes.model ?? 'n/a'}  ·  State: ${agentRes.state ?? 'unknown'}`
    content.appendChild(header)

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
