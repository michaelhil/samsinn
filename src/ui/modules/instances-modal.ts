// ============================================================================
// Instances modal — list / switch / create / delete sandboxes.
//
// Surface for the multi-instance registry. Reads /api/instances and renders
// a row per on-disk instance. Actions:
//   - Reset (current row)  → reuses /api/system/reset (10s countdown UX)
//   - Switch (other rows)  → POST /api/instances/:id/switch + reload
//   - Delete (other rows)  → POST DELETE /api/instances/:id with type-to-
//                            confirm. Refused for the current instance.
//   - + New instance       → POST /api/instances + auto-switch + reload
//
// Single-user happy path. No multi-tab coordination beyond the browser's
// own cookie + a full reload after destructive actions.
// ============================================================================

import { showToast } from './toast.ts'
import { triggerReset } from './reset-button.ts'

interface InstanceRow {
  readonly id: string
  readonly snapshotMtimeMs: number
  readonly snapshotSizeBytes: number
  readonly isLive: boolean
  readonly isCurrent: boolean
}

const fmtMtime = (ms: number): string => {
  if (!ms) return 'never saved'
  const d = new Date(ms)
  return d.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })
}

const fmtSize = (bytes: number): string => {
  if (!bytes) return '—'
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

const fetchList = async (): Promise<{ instances: InstanceRow[]; currentId: string | null }> => {
  const res = await fetch('/api/instances')
  if (!res.ok) throw new Error(`list failed (${res.status})`)
  return res.json() as Promise<{ instances: InstanceRow[]; currentId: string | null }>
}

const confirmDelete = (id: string): Promise<boolean> =>
  new Promise(resolve => {
    // <dialog> + showModal() so this stacks on the top layer above the
    // parent Instances dialog.
    const dlg = document.createElement('dialog')
    dlg.className = 'rounded-lg shadow-xl bg-surface text-text'
    dlg.style.cssText = 'max-width:440px;width:90%;padding:20px;border:none'
    dlg.innerHTML = `
      <h2 style="margin:0 0 8px;font-size:16px;font-weight:600;color:var(--text-strong)">⚠ Delete instance?</h2>
      <p style="margin:0 0 16px;font-size:13px;line-height:1.5;color:var(--text)">
        Wipes this sandbox's snapshot and per-instance data.
        <code style="display:block;margin-top:6px;font-size:12px;color:var(--text-strong);font-family:ui-monospace,monospace">${id}</code>
      </p>
      <div style="display:flex;gap:8px;justify-content:flex-end">
        <button type="button" id="del-cancel" style="padding:8px 14px;border:1px solid var(--border-strong);border-radius:4px;background:var(--surface);color:var(--text);font-size:13px;cursor:pointer">Cancel</button>
        <button type="button" id="del-ok" style="padding:8px 14px;border:none;border-radius:4px;background:var(--danger);color:#fff;font-size:13px;font-weight:600;cursor:pointer">Delete</button>
      </div>
    `
    document.body.appendChild(dlg)
    const okBtn = dlg.querySelector<HTMLButtonElement>('#del-ok')!
    const cancelBtn = dlg.querySelector<HTMLButtonElement>('#del-cancel')!
    const close = (result: boolean) => {
      dlg.close()
      dlg.remove()
      resolve(result)
    }
    okBtn.onclick = () => close(true)
    cancelBtn.onclick = () => close(false)
    dlg.addEventListener('cancel', () => close(false))
    dlg.showModal()
    cancelBtn.focus()
  })

const renderList = async (listEl: HTMLElement): Promise<void> => {
  listEl.innerHTML = '<div class="text-text-subtle italic p-3">Loading…</div>'
  let data: Awaited<ReturnType<typeof fetchList>>
  try {
    data = await fetchList()
  } catch (err) {
    listEl.innerHTML = `<div class="text-danger p-3">Failed to load: ${err instanceof Error ? err.message : String(err)}</div>`
    return
  }

  if (data.instances.length === 0) {
    listEl.innerHTML = '<div class="text-text-subtle italic p-3">No instances on disk.</div>'
    return
  }

  listEl.innerHTML = ''
  for (const inst of data.instances) {
    const row = document.createElement('div')
    const bgCls = inst.isCurrent ? 'bg-success-soft-bg' : 'hover:bg-surface-muted'
    row.className = `flex items-center gap-3 px-3 py-2 rounded ${bgCls}`

    const main = document.createElement('div')
    main.className = 'flex-1 min-w-0'
    const idLine = document.createElement('div')
    idLine.className = 'font-mono text-xs text-text-strong truncate'
    idLine.textContent = inst.id
    if (inst.isCurrent) {
      const tag = document.createElement('span')
      tag.className = 'ml-2 text-[10px] font-semibold uppercase text-success'
      tag.textContent = 'current'
      idLine.appendChild(tag)
    } else if (inst.isLive) {
      const tag = document.createElement('span')
      tag.className = 'ml-2 text-[10px] font-semibold uppercase text-text-subtle'
      tag.textContent = 'in memory'
      idLine.appendChild(tag)
    }
    const meta = document.createElement('div')
    meta.className = 'text-[11px] text-text-subtle'
    meta.textContent = `last saved ${fmtMtime(inst.snapshotMtimeMs)} · ${fmtSize(inst.snapshotSizeBytes)}`
    main.appendChild(idLine)
    main.appendChild(meta)

    const actions = document.createElement('div')
    actions.className = 'flex items-center gap-1.5 shrink-0'

    if (inst.isCurrent) {
      const reset = document.createElement('button')
      reset.className = 'px-2 py-1 text-xs border border-danger text-danger rounded hover:bg-danger hover:text-white'
      reset.textContent = 'Reset'
      reset.title = 'Wipe this sandbox (10-second cancellable countdown)'
      reset.onclick = () => {
        // Close the Instances dialog so the post-confirm countdown banner
        // (a position:fixed div) isn't hidden behind the modal's top-layer.
        const dlg = document.getElementById('instances-modal') as HTMLDialogElement | null
        dlg?.close()
        void triggerReset()
      }
      actions.appendChild(reset)
    } else {
      const sw = document.createElement('button')
      sw.className = 'px-2 py-1 text-xs border border-border-strong rounded hover:bg-surface-muted'
      sw.textContent = 'Switch'
      sw.onclick = async () => {
        try {
          const res = await fetch(`/api/instances/${inst.id}/switch`, { method: 'POST' })
          if (!res.ok) {
            const body = await res.json().catch(() => ({})) as { error?: string }
            showToast(document.body, body.error ?? `Switch failed (${res.status})`, { type: 'error', position: 'fixed' })
            return
          }
          window.location.reload()
        } catch {
          showToast(document.body, 'Switch failed', { type: 'error', position: 'fixed' })
        }
      }
      actions.appendChild(sw)

      const del = document.createElement('button')
      del.className = 'px-2 py-1 text-xs border border-danger text-danger rounded hover:bg-danger hover:text-white'
      del.textContent = 'Delete'
      del.onclick = async () => {
        const ok = await confirmDelete(inst.id)
        if (!ok) return
        try {
          const res = await fetch(`/api/instances/${inst.id}`, { method: 'DELETE' })
          if (!res.ok) {
            const body = await res.json().catch(() => ({})) as { error?: string }
            showToast(document.body, body.error ?? `Delete failed (${res.status})`, { type: 'error', position: 'fixed' })
            return
          }
          await renderList(listEl)
        } catch {
          showToast(document.body, 'Delete failed', { type: 'error', position: 'fixed' })
        }
      }
      actions.appendChild(del)
    }

    row.appendChild(main)
    row.appendChild(actions)
    listEl.appendChild(row)
  }
}

export const openInstancesModal = async (): Promise<void> => {
  const dlg = document.getElementById('instances-modal') as HTMLDialogElement | null
  if (!dlg) return
  const listEl = document.getElementById('instances-list')!
  const newBtn = document.getElementById('instances-new') as HTMLButtonElement
  const closeBtn = document.getElementById('instances-close') as HTMLButtonElement

  closeBtn.onclick = () => dlg.close()
  newBtn.onclick = async () => {
    newBtn.disabled = true
    try {
      const res = await fetch('/api/instances', { method: 'POST' })
      if (!res.ok) {
        const body = await res.json().catch(() => ({})) as { error?: string }
        showToast(document.body, body.error ?? `Create failed (${res.status})`, { type: 'error', position: 'fixed' })
        return
      }
      const { id } = await res.json() as { id: string }
      // Auto-switch to the new instance.
      const sw = await fetch(`/api/instances/${id}/switch`, { method: 'POST' })
      if (!sw.ok) {
        showToast(document.body, 'Created, but switch failed — reload manually', { type: 'error', position: 'fixed' })
        await renderList(listEl)
        return
      }
      window.location.reload()
    } catch {
      showToast(document.body, 'Create failed', { type: 'error', position: 'fixed' })
    } finally {
      newBtn.disabled = false
    }
  }

  if (!dlg.open) dlg.showModal()
  await renderList(listEl)
}
