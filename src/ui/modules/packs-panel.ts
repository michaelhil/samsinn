// ============================================================================
// Packs panel — renderers used by the Settings > Packs modal.
//
// `renderPacksInto(container)` populates the given element with the current
// pack list (rows + update/uninstall per row). `promptInstall()` is the
// install-new-pack flow triggered by the modal's header "+" button.
//
// Re-renders on `packs-changed` DOM event (fired by ws-dispatch on WS
// packs_changed). Listener is registered once on module load and only acts
// when the container it last rendered into is still in the DOM.
// ============================================================================

import { showToast } from './toast.ts'

interface InstalledPack {
  namespace: string
  dirPath: string
  manifest: { name?: string; description?: string }
  tools: string[]
  skills: string[]
}

const fetchPacks = async (): Promise<InstalledPack[]> => {
  try {
    const res = await fetch('/api/packs')
    if (!res.ok) return []
    return await res.json() as InstalledPack[]
  } catch { return [] }
}

export const renderPacksInto = async (container: HTMLElement): Promise<void> => {
  const packs = await fetchPacks()
  container.innerHTML = ''

  if (packs.length === 0) {
    container.innerHTML = '<div class="text-xs text-text-muted px-3 py-2">No packs installed</div>'
    return
  }

  for (const pack of packs) {
    const row = document.createElement('div')
    row.className = 'px-3 py-2 text-xs hover:bg-surface-muted flex items-center gap-2 border-b border-border'
    const label = pack.manifest.name ?? pack.namespace
    const desc = pack.manifest.description ?? ''
    const counts = `${pack.tools.length} tool${pack.tools.length === 1 ? '' : 's'}, ${pack.skills.length} skill${pack.skills.length === 1 ? '' : 's'}`
    row.innerHTML = `
      <div class="flex-1 min-w-0">
        <div class="text-text-strong font-medium truncate">${label}</div>
        <div class="text-text-muted truncate" title="${desc}">${desc || counts}</div>
        <div class="text-text-subtle text-[10px]">${counts}</div>
      </div>
      <button class="pack-update text-text-subtle hover:text-text px-2 py-1" title="Update (git pull)">↻</button>
      <button class="pack-uninstall text-text-subtle hover:text-danger px-2 py-1" title="Uninstall">✕</button>
    `
    row.querySelector<HTMLButtonElement>('.pack-update')?.addEventListener('click', async () => {
      showToast(document.body, `${pack.namespace}: updating…`, { position: 'fixed' })
      const res = await fetch(`/api/packs/update/${encodeURIComponent(pack.namespace)}`, { method: 'POST' })
      const ok = res.ok
      showToast(document.body, `${pack.namespace}: ${ok ? 'updated' : 'update failed'}`, {
        type: ok ? 'success' : 'error', position: 'fixed',
      })
    })
    row.querySelector<HTMLButtonElement>('.pack-uninstall')?.addEventListener('click', async () => {
      if (!confirm(`Uninstall pack "${pack.namespace}"? Its tools and skills will be unregistered.`)) return
      const res = await fetch(`/api/packs/${encodeURIComponent(pack.namespace)}`, { method: 'DELETE' })
      const ok = res.ok
      showToast(document.body, `${pack.namespace}: ${ok ? 'uninstalled' : 'uninstall failed'}`, {
        type: ok ? 'success' : 'error', position: 'fixed',
      })
    })
    container.appendChild(row)
  }
}

export const promptInstall = async (): Promise<void> => {
  const source = prompt(
    'Install pack from:\n\n' +
    '  name                → github.com/samsinn-packs/<name>\n' +
    '  user/repo           → github.com/user/repo\n' +
    '  https://...         → full URL',
    '',
  )?.trim()
  if (!source) return

  showToast(document.body, `Installing ${source}…`, { position: 'fixed' })
  const res = await fetch('/api/packs/install', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ source }),
  })
  if (!res.ok) {
    const body = await res.json().catch(() => ({ error: 'install failed' })) as { error?: string }
    showToast(document.body, `Install failed: ${body.error ?? 'unknown'}`, { type: 'error', position: 'fixed' })
    return
  }
  const data = await res.json() as { namespace: string; tools: string[]; skills: string[] }
  showToast(
    document.body,
    `${data.namespace}: ${data.tools.length} tools, ${data.skills.length} skills`,
    { type: 'success', position: 'fixed' },
  )
}
