// ============================================================================
// Macro panel — wires the 5 macro-group DOM handlers and owns macro-only
// module state.
//
// Handlers (in file order below):
//   - btnMacroStop    — stop the active macro
//   - btnMacroPicker  — expand / collapse the macro group toolbar
//   - btnMacroList    — open the list popover (pick / edit existing macros)
//   - btnMacroNext    — advance the current macro (auto-flush chat input)
//   - btnMacroCreate  — open the editor modal, auto-select on save
//
// Shared state:
//   - macroGroupExpanded (per-room UI state; resets on reload by design)
//   - macroListPopoverEl (open-popover singleton)
//
// Call `initMacroPanel({ onRefreshRoomControls })` once at app startup;
// `refreshRoomControls` stays in app.ts and reads the expand state via the
// exported `isMacroGroupExpanded` getter.
// ============================================================================

import { domRefs } from './app-dom.ts'
import { roomIdToName } from './identity-lookups.ts'
import { send } from './ws-send.ts'
import { pendingCreateHooks } from './ws-dispatch/index.ts'
import {
  $selectedRoomId,
  $agents,
  $myAgentId,
  $selectedRoomArtifacts,
  $selectedMacroIdByRoom,
} from './stores.ts'
import type { AgentInfo } from './render-types.ts'

// === State ===

const macroGroupExpanded = new Map<string, boolean>()

export const isMacroGroupExpanded = (roomId: string): boolean =>
  macroGroupExpanded.get(roomId) ?? false

// === Macro editor lazy imports ===

type MacroStep = { agentId: string; agentName: string; stepPrompt?: string }
type MacroEditorOnSave = (
  name: string,
  steps: ReadonlyArray<MacroStep>,
  loop: boolean,
  description?: string,
) => void

const lazyMacroEditor = async (
  agents: Map<string, AgentInfo>, myAgentId: string,
  onSave: MacroEditorOnSave,
): Promise<void> => {
  const { openMacroEditorModal } = await import('./macro-editor.ts')
  openMacroEditorModal(agents, myAgentId, onSave)
}

const lazyMacroEditorEdit = async (
  agents: Map<string, AgentInfo>, myAgentId: string,
  existingSteps: ReadonlyArray<MacroStep>,
  existingLoop: boolean, existingName: string, existingDescription: string | undefined,
  onSave: MacroEditorOnSave,
): Promise<void> => {
  const { openMacroEditorModal } = await import('./macro-editor.ts')
  const stepsWithPrompt = existingSteps.map(s => ({
    agentId: s.agentId,
    agentName: s.agentName,
    stepPrompt: s.stepPrompt ?? '',
  }))
  openMacroEditorModal(agents, myAgentId, onSave, existingName, stepsWithPrompt, existingLoop, existingDescription)
}

// === List popover (singleton) ===

let macroListPopoverEl: HTMLElement | null = null

const closeMacroListPopover = (): void => {
  macroListPopoverEl?.remove()
  macroListPopoverEl = null
  document.removeEventListener('click', onDocClickForListPopover, true)
}

const onDocClickForListPopover = (ev: MouseEvent): void => {
  if (!macroListPopoverEl) return
  const t = ev.target as Node
  if (!macroListPopoverEl.contains(t) && t !== domRefs.btnMacroList) closeMacroListPopover()
}

// === Init ===

export interface MacroPanelDeps {
  /** Invoked after the macro group expand state changes so app.ts can re-run
   *  the shared room-controls refresh (mode icons, chip visibility, etc.). */
  readonly onRefreshRoomControls: () => void
}

export const initMacroPanel = (deps: MacroPanelDeps): void => {
  const {
    btnMacroStop, btnMacroPicker, btnMacroList, btnMacroNext, btnMacroCreate,
    chatInput,
  } = domRefs

  btnMacroStop.onclick = () => {
    const roomId = $selectedRoomId.get()
    if (!roomId) return
    const roomName = roomIdToName(roomId)
    if (!roomName) return
    send({ type: 'stop_macro', roomName })
  }

  btnMacroPicker.onclick = (e) => {
    e.stopPropagation()
    const roomId = $selectedRoomId.get()
    if (!roomId) return
    const wasOpen = macroGroupExpanded.get(roomId) ?? false
    if (wasOpen) closeMacroListPopover()
    macroGroupExpanded.set(roomId, !wasOpen)
    deps.onRefreshRoomControls()
  }

  btnMacroList.onclick = (e) => {
    e.stopPropagation()
    if (macroListPopoverEl) { closeMacroListPopover(); return }

    const roomId = $selectedRoomId.get()
    const roomName = roomId ? roomIdToName(roomId) : null
    if (!roomName || !roomId) return
    const macros = $selectedRoomArtifacts.get().filter(a => !a.resolvedAt && a.type === 'macro')
    if (macros.length === 0) return   // button is disabled in this state — defensive

    const selection = $selectedMacroIdByRoom.get()[roomId] ?? null

    macroListPopoverEl = document.createElement('div')
    macroListPopoverEl.className = 'macro-popover'

    for (const m of macros) {
      const body = m.body as { loop?: boolean }
      const row = document.createElement('div')
      row.className = 'macro-item'

      const label = document.createElement('span')
      label.className = 'flex-1 truncate'
      const isSelected = m.id === selection
      label.textContent = `${isSelected ? '✓ ' : ''}${m.title}${body.loop ? ' ↻' : ''}`
      if (isSelected) label.style.fontWeight = '600'

      const selectBtn = document.createElement('button')
      selectBtn.className = 'text-xs px-2 py-0.5 text-accent hover:text-accent-hover'
      selectBtn.textContent = isSelected ? '✓' : 'Select'
      selectBtn.title = isSelected ? 'Already selected' : `Select ${m.title}`
      selectBtn.disabled = isSelected
      selectBtn.onclick = () => {
        send({ type: 'select_macro', roomName, macroArtifactId: m.id })
        closeMacroListPopover()
      }

      const editBtn = document.createElement('button')
      editBtn.className = 'text-xs px-2 py-0.5 text-text-subtle hover:text-text-strong'
      editBtn.textContent = '✎'
      editBtn.title = `Edit ${m.title}`
      editBtn.onclick = () => {
        closeMacroListPopover()
        const agentsMap = new Map(Object.entries($agents.get()).map(([id, a]) => [id, a as AgentInfo]))
        const existingSteps = (body as { steps?: ReadonlyArray<MacroStep> }).steps ?? []
        void lazyMacroEditorEdit(
          agentsMap, $myAgentId.get() ?? '',
          existingSteps, !!body.loop, m.title,
          (m.body as { description?: string }).description,
          (name, steps, loop, description) => {
            send({
              type: 'update_artifact',
              artifactId: m.id,
              title: name,
              body: { steps, loop, ...(description !== undefined ? { description } : {}) },
            })
          },
        )
      }

      row.appendChild(label)
      row.appendChild(selectBtn)
      row.appendChild(editBtn)
      macroListPopoverEl.appendChild(row)
    }

    const rect = btnMacroList.getBoundingClientRect()
    macroListPopoverEl.style.top = `${rect.bottom + 4}px`
    macroListPopoverEl.style.right = `${window.innerWidth - rect.right}px`
    document.body.appendChild(macroListPopoverEl)

    setTimeout(() => document.addEventListener('click', onDocClickForListPopover, true), 0)
  }

  btnMacroNext.onclick = () => {
    const roomId = $selectedRoomId.get()
    if (!roomId) return
    const roomName = roomIdToName(roomId)
    if (!roomName) return
    // Auto-flush any unsent composer text (Send-then-Next UX).
    const pending = chatInput.value.trim()
    if (pending) {
      send({ type: 'post_message', target: { rooms: [roomName] }, content: pending })
      chatInput.value = ''
    }
    send({ type: 'room_next', roomName })
  }

  btnMacroCreate.onclick = () => {
    const roomId = $selectedRoomId.get()
    if (!roomId) return
    const roomName = roomIdToName(roomId)
    if (!roomName) return
    const agentsMap = new Map(Object.entries($agents.get()).map(([id, a]) => [id, a as AgentInfo]))
    void lazyMacroEditor(agentsMap, $myAgentId.get() ?? '', (name, steps, loop, description) => {
      const requestId = crypto.randomUUID()
      // Register a one-shot hook that fires when the server echoes artifact_created.
      pendingCreateHooks.set(requestId, (artifactId, artifactType) => {
        if (artifactType !== 'macro') return
        send({ type: 'select_macro', roomName, macroArtifactId: artifactId })
      })
      send({
        type: 'add_artifact',
        artifactType: 'macro',
        title: name,
        body: { steps, loop },
        scope: [roomName],
        requestId,
        ...(description !== undefined ? { description } : {}),
      })
    })
  }

}
