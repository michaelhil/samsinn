// ============================================================================
// Wikis panel — renderers used by the Settings > Wikis modal.
//
// `renderWikisInto(container)` populates the given element with the current
// wiki list (rows + refresh/delete + per-row room-binding toggles).
// `promptAddWiki()` is the add-new-wiki flow triggered by the modal's "+" button.
//
// Re-renders on `wikis-changed` DOM event (fired by ws-dispatch on WS
// wiki_changed). Listener is registered by the modal once it mounts.
// ============================================================================

import { showToast } from './toast.ts'

interface WikiEntry {
  id: string
  owner: string
  repo: string
  ref: string
  displayName: string
  keyMask: string
  hasKey: boolean
  enabled: boolean
  source: 'stored' | 'discovered'
  pageCount: number
  lastWarmAt: number | null
  lastError: string | null
}

interface RoomEntry { id: string; name: string }

const escapeHtml = (s: string): string =>
  s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c] ?? c))

const fetchWikis = async (): Promise<WikiEntry[]> => {
  try {
    const res = await fetch('/api/wikis')
    if (!res.ok) return []
    const data = await res.json() as { wikis?: WikiEntry[] }
    return data.wikis ?? []
  } catch { return [] }
}

const fetchRooms = async (): Promise<RoomEntry[]> => {
  try {
    const res = await fetch('/api/rooms')
    if (!res.ok) return []
    return await res.json() as RoomEntry[]
  } catch { return [] }
}

const fetchRoomBindings = async (roomName: string): Promise<string[]> => {
  try {
    const res = await fetch(`/api/rooms/${encodeURIComponent(roomName)}/wikis`)
    if (!res.ok) return []
    const data = await res.json() as { wikiIds?: string[] }
    return data.wikiIds ?? []
  } catch { return [] }
}

const setRoomBindings = async (roomName: string, wikiIds: string[]): Promise<boolean> => {
  const res = await fetch(`/api/rooms/${encodeURIComponent(roomName)}/wikis`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ wikiIds }),
  })
  return res.ok
}

const formatLastWarm = (ts: number | null): string => {
  if (!ts) return 'never'
  const ageMs = Date.now() - ts
  const min = Math.floor(ageMs / 60000)
  if (min < 1) return 'just now'
  if (min < 60) return `${min}m ago`
  const hr = Math.floor(min / 60)
  if (hr < 24) return `${hr}h ago`
  return `${Math.floor(hr / 24)}d ago`
}

export const renderWikisInto = async (container: HTMLElement): Promise<void> => {
  container.innerHTML = '<div class="text-xs text-text-muted px-3 py-2 italic">Loading…</div>'
  const [wikis, rooms] = await Promise.all([fetchWikis(), fetchRooms()])
  container.innerHTML = ''

  if (wikis.length === 0) {
    const empty = document.createElement('div')
    empty.className = 'text-xs text-text-muted px-3 py-3 italic'
    empty.textContent = 'No wikis configured. Use + to add one (e.g. owner=michaelhil repo=nuclear-wiki).'
    container.appendChild(empty)
    return
  }

  for (const w of wikis) {
    const row = document.createElement('div')
    row.className = 'px-3 py-2 text-xs border-b border-border'
    const status = w.lastError
      ? `<span class="text-red-500" title="${escapeHtml(w.lastError)}">error</span>`
      : `<span class="text-text-muted">${w.pageCount} pages · warmed ${formatLastWarm(w.lastWarmAt)}</span>`
    const keyBadge = w.hasKey
      ? `<span class="text-text-muted ml-2" title="Authenticated with PAT">🔑 ${escapeHtml(w.keyMask)}</span>`
      : `<span class="text-text-muted ml-2" title="Anonymous (60 req/hr GitHub limit)">no PAT</span>`
    const sourceBadge = w.source === 'discovered'
      ? `<span class="ml-2 text-[10px] uppercase tracking-wide text-text-subtle" title="Auto-discovered via SAMSINN_WIKI_SOURCES">discovered</span>`
      : ''
    const isDiscovered = w.source === 'discovered'
    const deleteBtn = isDiscovered
      ? '' // discovered wikis aren't in wikis.json — nothing to delete
      : `<button data-act="delete" class="px-2 py-1 text-red-500 hover:bg-surface-muted rounded interactive" title="Remove">✕</button>`
    const customizeBtn = isDiscovered
      ? `<button data-act="customize" class="px-2 py-1 text-text hover:bg-surface-muted rounded interactive" title="Add PAT or override displayName">⚙</button>`
      : ''
    row.innerHTML = `
      <div class="flex items-center gap-2">
        <div class="flex-1 min-w-0">
          <div class="font-medium truncate">${escapeHtml(w.displayName)} <span class="text-text-muted">(${escapeHtml(w.id)})</span>${sourceBadge}</div>
          <div class="text-text-muted truncate">${escapeHtml(w.owner)}/${escapeHtml(w.repo)}@${escapeHtml(w.ref)} ${keyBadge}</div>
          <div>${status}</div>
        </div>
        <button data-act="refresh" class="px-2 py-1 text-text hover:bg-surface-muted rounded interactive" title="Refresh now">↻</button>
        ${customizeBtn}
        ${deleteBtn}
      </div>
      <div data-bindings class="mt-2 pl-2 text-text-muted">Loading bindings…</div>
    `

    row.querySelector<HTMLButtonElement>('[data-act="refresh"]')!.onclick = async () => {
      showToast(document.body, `Refreshing ${w.id}…`, { position: 'fixed' })
      const res = await fetch(`/api/wikis/${encodeURIComponent(w.id)}/refresh`, { method: 'POST' })
      if (res.ok) {
        const data = await res.json() as { pageCount?: number; warnings?: string[] }
        showToast(document.body, `${w.id}: ${data.pageCount ?? 0} pages`, { type: 'success', position: 'fixed' })
      } else {
        showToast(document.body, `Refresh failed: ${(await res.json().catch(() => ({ error: '?' })) as { error?: string }).error}`, { type: 'error', position: 'fixed' })
      }
    }
    const customizeEl = row.querySelector<HTMLButtonElement>('[data-act="customize"]')
    if (customizeEl) {
      customizeEl.onclick = async () => {
        const apiKey = prompt(`Add a GitHub PAT for "${w.id}" (leave blank to skip):`)?.trim() || undefined
        const displayName = prompt(`Override displayName for "${w.id}" (leave blank to keep current):`)?.trim() || undefined
        const body: Record<string, unknown> = { id: w.id, owner: w.owner, repo: w.repo, ref: w.ref }
        if (apiKey) body.apiKey = apiKey
        if (displayName) body.displayName = displayName
        const res = await fetch('/api/wikis', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        })
        if (res.ok) showToast(document.body, `Customized ${w.id}`, { type: 'success', position: 'fixed' })
        else {
          const data = await res.json().catch(() => ({ error: '?' })) as { error?: string }
          showToast(document.body, `Customize failed: ${data.error}`, { type: 'error', position: 'fixed' })
        }
      }
    }
    const deleteEl = row.querySelector<HTMLButtonElement>('[data-act="delete"]')
    if (deleteEl) deleteEl.onclick = async () => {
      if (!confirm(`Delete wiki "${w.id}"? This also removes all room bindings.`)) return
      const res = await fetch(`/api/wikis/${encodeURIComponent(w.id)}`, { method: 'DELETE' })
      if (res.ok) {
        showToast(document.body, `Deleted ${w.id}`, { type: 'success', position: 'fixed' })
      } else {
        showToast(document.body, `Delete failed`, { type: 'error', position: 'fixed' })
      }
    }

    container.appendChild(row)
    void renderBindingsCell(row.querySelector<HTMLElement>('[data-bindings]')!, w.id, rooms)
  }
}

const renderBindingsCell = async (cell: HTMLElement, wikiId: string, rooms: RoomEntry[]): Promise<void> => {
  // For each room, fetch its bindings, then render checkboxes.
  const allBindings = await Promise.all(rooms.map(async (r) => ({ room: r, ids: await fetchRoomBindings(r.name) })))
  cell.innerHTML = '<div class="text-[11px] mb-1">Bound to rooms:</div>'
  if (rooms.length === 0) {
    cell.innerHTML += '<div class="italic">no rooms yet</div>'
    return
  }
  const wrap = document.createElement('div')
  wrap.className = 'flex flex-wrap gap-2'
  for (const { room, ids } of allBindings) {
    const checked = ids.includes(wikiId)
    const label = document.createElement('label')
    label.className = 'inline-flex items-center gap-1 cursor-pointer'
    label.innerHTML = `<input type="checkbox" ${checked ? 'checked' : ''} class="cursor-pointer"/> <span>${escapeHtml(room.name)}</span>`
    label.querySelector<HTMLInputElement>('input')!.onchange = async (e) => {
      const want = (e.target as HTMLInputElement).checked
      const next = want ? [...new Set([...ids, wikiId])] : ids.filter((x) => x !== wikiId)
      const ok = await setRoomBindings(room.name, next)
      if (!ok) { showToast(document.body, `Bind failed`, { type: 'error', position: 'fixed' }); (e.target as HTMLInputElement).checked = !want }
    }
    wrap.appendChild(label)
  }
  cell.appendChild(wrap)
}

export const promptAddWiki = async (): Promise<void> => {
  const id = prompt('Wiki id (lowercase, kebab-case):')?.trim()
  if (!id) return
  const owner = prompt('GitHub owner (e.g. michaelhil):')?.trim()
  if (!owner) return
  const repo = prompt('GitHub repo (e.g. nuclear-wiki):')?.trim()
  if (!repo) return
  const ref = prompt('Branch or commit (default: main):')?.trim() || undefined
  const apiKey = prompt('Optional GitHub PAT (leave blank for anonymous):')?.trim() || undefined
  const body: Record<string, unknown> = { id, owner, repo }
  if (ref) body.ref = ref
  if (apiKey) body.apiKey = apiKey
  showToast(document.body, `Adding ${id}…`, { position: 'fixed' })
  const res = await fetch('/api/wikis', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  if (!res.ok) {
    const data = await res.json().catch(() => ({ error: 'add failed' })) as { error?: string }
    showToast(document.body, `Add failed: ${data.error ?? 'unknown'}`, { type: 'error', position: 'fixed' })
    return
  }
  showToast(document.body, `Added ${id} — warming in background`, { type: 'success', position: 'fixed' })
}
