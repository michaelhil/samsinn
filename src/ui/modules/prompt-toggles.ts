// ============================================================================
// Context panel — per-agent controls for what the LLM receives.
//
// Layout (no fold-outs except per-tool list):
//   Summary strip   — one-line totals + overflow warning
//   2x2 grid:
//     Prompts ☑ | Context ☑
//     Tools   ☑ | Model
//   Budgets row     — char cap · context budget
//
// Three groups (Prompts / Context / Tools) each have a master checkbox: when
// off, the group's children are visually greyed and disabled, individual state
// is preserved on the server. Tools keeps a fold-out for its 60-item per-tool
// list (the only remaining fold on the panel).
// ============================================================================

import { safeFetchJson, showToast, createInlineNumberEditor } from './ui-utils.ts'
import { $selectedRoomId } from './stores.ts'

interface AgentData {
  systemPrompt?: string
  tools?: string[]
  rooms?: string[]
}

interface PreviewSection {
  key: string
  label: string
  text: string
  tokens: number
  enabled: boolean
  optional: boolean
}

interface ContextPreview {
  roomId: string
  roomName: string
  sections: PreviewSection[]
  modelMax: number
  historyEstimate: { messages: number; chars: number }
  toolTokens: Record<string, number>
  registeredTools: string[]
}

const escapeHtml = (s: string): string =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

// --- Preview modal (unchanged behavior) ---
const openModal = (title: string, body: string, tokenEstimate: number): void => {
  const backdrop = document.createElement('div')
  backdrop.className = 'fixed inset-0 bg-black/40 z-50 flex items-center justify-center p-4'
  const panel = document.createElement('div')
  panel.className = 'bg-white rounded shadow-xl max-w-2xl w-full max-h-[80vh] flex flex-col'
  panel.innerHTML = `
    <div class="flex items-center justify-between px-4 py-3 border-b">
      <div>
        <div class="font-semibold text-sm">${escapeHtml(title)}</div>
        <div class="text-xs text-gray-500">~${tokenEstimate} tok · ${body.length} chars</div>
      </div>
      <button class="text-gray-400 hover:text-gray-700 text-lg leading-none" aria-label="Close">×</button>
    </div>
    <pre class="p-4 text-xs font-mono whitespace-pre-wrap overflow-auto flex-1">${escapeHtml(body || '(empty)')}</pre>
  `
  const close = (): void => { backdrop.remove() }
  panel.querySelector('button')!.addEventListener('click', close)
  backdrop.addEventListener('click', (e) => { if (e.target === backdrop) close() })
  document.addEventListener('keydown', function onEsc(e) {
    if (e.key === 'Escape') { close(); document.removeEventListener('keydown', onEsc) }
  })
  backdrop.appendChild(panel)
  document.body.appendChild(backdrop)
}

// --- Helpers ---
const sectionByKey = (p: ContextPreview, key: string): PreviewSection | undefined =>
  p.sections.find(s => s.key === key)

const mkGlass = (label: string, onPreview: () => void | Promise<void>): HTMLButtonElement => {
  const b = document.createElement('button')
  b.type = 'button'
  b.className = 'text-gray-400 hover:text-blue-500'
  b.setAttribute('aria-label', `Preview ${label}`)
  b.textContent = '🔍'
  b.onclick = (e) => { e.preventDefault(); void onPreview() }
  return b
}

// Flip a group's greyed/disabled state. Called when the master checkbox flips.
const applyGroupDisabled = (groupEl: HTMLElement, disabled: boolean): void => {
  groupEl.classList.toggle('opacity-50', disabled)
  const inputs = groupEl.querySelectorAll<HTMLInputElement>('input[data-group-child]')
  const labels = groupEl.querySelectorAll<HTMLElement>('[data-group-child-label]')
  for (const input of inputs) input.disabled = disabled
  for (const lbl of labels) lbl.classList.toggle('text-gray-400', disabled)
}

// ============================================================================

export interface PromptTogglesDeps {
  readonly agentName: string
  readonly agentEnc: string
  readonly agentData: AgentData & Record<string, unknown>
  readonly promptTextarea: HTMLTextAreaElement
}

export const renderPromptToggles = (container: HTMLElement, deps: PromptTogglesDeps): void => {
  const { agentEnc, agentData, promptTextarea } = deps

  // Per-tool fold state persists across re-renders within this inspector
  // session, so per-tool checkbox edits don't collapse the list.
  let toolsFoldOpen = false

  // Panel root (no outer fold)
  const panel = document.createElement('div')
  panel.className = 'border border-gray-100 rounded mb-3 px-3 py-2'
  container.appendChild(panel)

  const summaryBar = document.createElement('div')
  summaryBar.className = 'text-xs font-semibold text-gray-500 uppercase tracking-wide mb-2'
  summaryBar.textContent = 'Context — loading…'
  panel.appendChild(summaryBar)

  const body = document.createElement('div')
  panel.appendChild(body)

  const getRoomIdForPreview = (): string | undefined => {
    const sel = $selectedRoomId.get()
    const joined = agentData.rooms as string[] | undefined
    if (sel && joined?.includes(sel)) return sel
    return joined?.[0]
  }

  const fetchPreview = async (): Promise<ContextPreview | null> => {
    const roomId = getRoomIdForPreview()
    const qs = roomId ? `?roomId=${encodeURIComponent(roomId)}` : ''
    return safeFetchJson<ContextPreview>(`/api/agents/${agentEnc}/context-preview${qs}`)
  }

  const patchAgent = async (patch: Record<string, unknown>): Promise<void> => {
    await safeFetchJson(`/api/agents/${agentEnc}`, {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(patch),
    })
  }

  const render = async (): Promise<void> => {
    const joinedRooms = (agentData.rooms as string[] | undefined) ?? []
    if (joinedRooms.length === 0) {
      body.innerHTML = ''
      summaryBar.textContent = 'Context — (no room)'
      body.textContent = 'Add this agent to a room to see its context.'
      return
    }
    const preview = await fetchPreview()
    body.innerHTML = ''
    if (!preview) {
      summaryBar.textContent = 'Context — (failed to load)'
      body.textContent = 'Failed to load context preview.'
      return
    }

    // --- Resolve state ---
    const get = (k: string): PreviewSection | undefined => sectionByKey(preview, k)
    const promptKeys = [
      { code: 'agent',          section: 'agent',          label: 'Agent prompt' },
      { code: 'room',           section: 'room',           label: 'Room prompt' },
      { code: 'house',          section: 'house',          label: 'System prompt' },
      { code: 'responseFormat', section: 'responseFormat', label: 'Response format' },
      { code: 'skills',         section: 'skills',         label: 'Skills' },
    ] as const
    const contextKeys = [
      { code: 'participants', section: 'ctx_participants', label: 'Participants list' },
      { code: 'flow',         section: 'ctx_flow',         label: 'Flow section' },
      { code: 'artifacts',    section: 'ctx_artifacts',    label: 'Artifacts' },
      { code: 'activity',     section: 'ctx_activity',     label: 'Activity in other rooms' },
      { code: 'knownAgents',  section: 'ctx_knownAgents',  label: 'Known agents', warning: 'breaks [[Name]] mentions' },
    ] as const

    const includePrompts = (agentData.includePrompts as Record<string, boolean>) ?? {}
    const includeContext = (agentData.includeContext as Record<string, boolean>) ?? {}
    const includeFlowStepPrompt = (agentData.includeFlowStepPrompt as boolean) ?? true
    const includeTools = (agentData.includeTools as boolean) ?? true
    const promptsEnabled = (agentData.promptsEnabled as boolean) ?? true
    const contextEnabled = (agentData.contextEnabled as boolean) ?? true
    const temperature = agentData.temperature as number | undefined
    const historyLimit = agentData.historyLimit as number | undefined
    const thinking = (agentData.thinking as boolean) ?? false
    const maxToolResultChars = agentData.maxToolResultChars as number | null | undefined
    const maxToolIterations = agentData.maxToolIterations as number | null | undefined

    const registered = preview.registeredTools
    const enabledTools = new Set<string>(
      (agentData.tools as string[] | undefined) ?? registered,
    )
    const toolTokens = preview.toolTokens

    // --- Summary strip (tokens gated by master flags) ---
    const updateSummary = (): void => {
      const promptsOn = promptsEnabled
        ? promptKeys.filter(p => (includePrompts[p.code] ?? true) && (get(p.section)?.enabled ?? false)).length
        : 0
      const promptsTotal = promptKeys.filter(p => (get(p.section)?.text?.length ?? 0) > 0).length
      const ctxOn = contextEnabled
        ? contextKeys.filter(c => (includeContext[c.code] ?? true) && (get(c.section)?.enabled ?? false)).length
        : 0
      const ctxTotal = contextKeys.filter(c => (get(c.section)?.text?.length ?? 0) > 0).length
      let used = 0
      if (promptsEnabled) for (const p of promptKeys) {
        if ((includePrompts[p.code] ?? true)) used += get(p.section)?.tokens ?? 0
      }
      if (contextEnabled) for (const c of contextKeys) {
        if ((includeContext[c.code] ?? true)) used += get(c.section)?.tokens ?? 0
      }
      if (includeTools) for (const t of enabledTools) used += toolTokens[t] ?? 0
      const modelMax = preview.modelMax
      const pct = modelMax > 0 ? (used / modelMax) * 100 : 0
      const overflow = modelMax > 0 && pct >= 90
      const tokenStr = modelMax > 0
        ? `~${used.toLocaleString()} / ${modelMax.toLocaleString()} tok (${pct.toFixed(1)}%)`
        : `~${used.toLocaleString()} tok (model window unknown)`
      summaryBar.textContent = `${tokenStr} · ${promptsOn}/${promptsTotal} prompts · ${ctxOn}/${ctxTotal} context · ${includeTools ? enabledTools.size : 0}/${registered.length} tools ${overflow ? '⚠' : ''}`
      summaryBar.style.color = overflow ? '#d97706' : ''
    }

    // --- Grid: 2 columns ---
    const grid = document.createElement('div')
    grid.className = 'grid grid-cols-2 gap-x-6 gap-y-4 text-xs'
    body.appendChild(grid)

    // --- Toggle row helper ---
    const mkToggleRow = (
      label: string,
      checked: boolean,
      tokens: number,
      onChange: (next: boolean) => Promise<void>,
      onPreview: () => void | Promise<void>,
      warning?: string,
    ): HTMLElement => {
      const row = document.createElement('div')
      row.className = 'flex items-center gap-1'
      const wrap = document.createElement('label')
      wrap.className = 'inline-flex items-center gap-1 cursor-pointer'
      wrap.setAttribute('data-group-child-label', '')
      const cb = document.createElement('input')
      cb.type = 'checkbox'
      cb.className = 'rounded'
      cb.checked = checked
      cb.setAttribute('data-group-child', '')
      const name = document.createElement('span')
      name.textContent = label
      wrap.appendChild(cb)
      wrap.appendChild(name)
      row.appendChild(wrap)
      row.appendChild(mkGlass(label, onPreview))
      const tok = document.createElement('span')
      tok.className = 'text-gray-400'
      tok.textContent = `(~${tokens} tok)`
      row.appendChild(tok)
      if (warning) {
        const w = document.createElement('span')
        w.className = 'text-xs text-amber-600 ml-1'
        w.textContent = `⚠ ${warning}`
        w.style.display = checked ? 'none' : 'inline'
        row.appendChild(w)
        cb.onchange = async () => {
          w.style.display = cb.checked ? 'none' : 'inline'
          await onChange(cb.checked)
        }
      } else {
        cb.onchange = async () => { await onChange(cb.checked) }
      }
      return row
    }

    // --- Group builder (master checkbox + children + optional token total) ---
    interface GroupOpts {
      readonly label: string
      readonly master?: { checked: boolean; onChange: (next: boolean) => Promise<void> }
      readonly totalTokens?: number
      readonly extraHeader?: HTMLElement    // e.g. Tools' ▾ fold toggle
      readonly children: HTMLElement[]
    }
    const mkGroup = (opts: GroupOpts): HTMLElement => {
      const group = document.createElement('div')
      group.className = 'flex flex-col'

      const header = document.createElement('div')
      header.className = 'flex items-center gap-1 mb-1 text-xs font-semibold text-gray-500 uppercase tracking-wide'

      // Header order: LABEL · [master checkbox] · (~N tok) — master sits between
      // label and token count so the label reads as a heading.
      const labelEl = document.createElement('span')
      labelEl.textContent = opts.label
      header.appendChild(labelEl)

      if (opts.master) {
        const cb = document.createElement('input')
        cb.type = 'checkbox'
        cb.className = 'rounded'
        cb.checked = opts.master.checked
        cb.onchange = async () => {
          applyGroupDisabled(group, !cb.checked)
          await opts.master!.onChange(cb.checked)
        }
        header.appendChild(cb)
      }
      if (opts.totalTokens !== undefined) {
        const t = document.createElement('span')
        t.className = 'text-gray-400 font-normal normal-case'
        t.textContent = `(~${opts.totalTokens} tok)`
        header.appendChild(t)
      }
      if (opts.extraHeader) header.appendChild(opts.extraHeader)
      group.appendChild(header)

      const rows = document.createElement('div')
      rows.className = 'flex flex-col gap-y-1'
      for (const child of opts.children) rows.appendChild(child)
      group.appendChild(rows)

      if (opts.master && !opts.master.checked) applyGroupDisabled(group, true)
      return group
    }

    // --- Group: Prompts ---
    const promptTotal = promptKeys.reduce((s, p) => s + (get(p.section)?.tokens ?? 0), 0)
    const promptRows = promptKeys.map(p => {
      const sec = get(p.section)
      return mkToggleRow(
        p.label,
        includePrompts[p.code] ?? true,
        sec?.tokens ?? 0,
        async (next) => {
          (agentData as Record<string, unknown>).includePrompts = { ...includePrompts, [p.code]: next }
          await patchAgent({ includePrompts: { [p.code]: next } })
          await render()
        },
        p.code === 'agent'
          ? () => {
              promptTextarea.scrollIntoView({ behavior: 'smooth', block: 'center' })
              promptTextarea.classList.add('ring-2', 'ring-blue-400')
              setTimeout(() => promptTextarea.classList.remove('ring-2', 'ring-blue-400'), 1500)
            }
          : () => openModal(`${p.label}${p.code === 'room' ? ` — "${preview.roomName}"` : ''}`, sec?.text ?? '', sec?.tokens ?? 0),
      )
    })
    grid.appendChild(mkGroup({
      label: 'Prompts',
      master: {
        checked: promptsEnabled,
        onChange: async (next) => {
          (agentData as Record<string, unknown>).promptsEnabled = next
          await patchAgent({ promptsEnabled: next })
          await render()
        },
      },
      totalTokens: promptTotal,
      children: promptRows,
    }))

    // --- Group: Context ---
    const contextTotal = contextKeys.reduce((s, c) => s + (get(c.section)?.tokens ?? 0), 0)
    const contextRows: HTMLElement[] = contextKeys.map(c => {
      const sec = get(c.section)
      return mkToggleRow(
        c.label,
        includeContext[c.code] ?? true,
        sec?.tokens ?? 0,
        async (next) => {
          (agentData as Record<string, unknown>).includeContext = { ...includeContext, [c.code]: next }
          await patchAgent({ includeContext: { [c.code]: next } })
          await render()
        },
        () => openModal(c.label, sec?.text ?? '', sec?.tokens ?? 0),
        c.warning,
      )
    })
    // Include flow-step instructions — moved here from Advanced.
    const flowRow = document.createElement('div')
    flowRow.className = 'flex items-center gap-1'
    const flowLabel = document.createElement('label')
    flowLabel.className = 'inline-flex items-center gap-1 cursor-pointer'
    flowLabel.setAttribute('data-group-child-label', '')
    const flowCb = document.createElement('input')
    flowCb.type = 'checkbox'
    flowCb.className = 'rounded'
    flowCb.checked = includeFlowStepPrompt
    flowCb.setAttribute('data-group-child', '')
    const flowText = document.createElement('span')
    flowText.textContent = 'Flow step instructions'
    flowLabel.appendChild(flowCb)
    flowLabel.appendChild(flowText)
    flowRow.appendChild(flowLabel)
    const flowWarn = document.createElement('span')
    flowWarn.className = 'text-xs text-amber-600 ml-1'
    flowWarn.textContent = '⚠ off may break flow routing'
    flowWarn.style.display = includeFlowStepPrompt ? 'none' : 'inline'
    flowRow.appendChild(flowWarn)
    flowCb.onchange = async () => {
      flowWarn.style.display = flowCb.checked ? 'none' : 'inline'
      ;(agentData as Record<string, unknown>).includeFlowStepPrompt = flowCb.checked
      await patchAgent({ includeFlowStepPrompt: flowCb.checked })
    }
    contextRows.push(flowRow)

    grid.appendChild(mkGroup({
      label: 'Context',
      master: {
        checked: contextEnabled,
        onChange: async (next) => {
          (agentData as Record<string, unknown>).contextEnabled = next
          await patchAgent({ contextEnabled: next })
          await render()
        },
      },
      totalTokens: contextTotal,
      children: contextRows,
    }))

    // --- Group: Tools ---
    const toolTokensTotal = [...enabledTools].reduce((s, n) => s + (toolTokens[n] ?? 0), 0)

    // Fold trigger ("N/M tools ▾") lives on its own row below the heading.
    // Both the text and the caret sit inside <summary>, so clicking either
    // opens or closes the fold. Open state persists across render() calls
    // via the outer `toolsFoldOpen` flag.
    const toolFold = document.createElement('details')
    toolFold.className = 'mt-1'
    toolFold.open = toolsFoldOpen
    toolFold.setAttribute('data-group-child-label', '')
    toolFold.ontoggle = () => { toolsFoldOpen = toolFold.open }

    const toolSummary = document.createElement('summary')
    toolSummary.className = 'cursor-pointer text-gray-500 hover:text-gray-700 list-none select-none'
    toolSummary.textContent = `${enabledTools.size}/${registered.length} tools ▾`
    toolFold.appendChild(toolSummary)

    const toolListBody = document.createElement('div')
    toolListBody.className = 'mt-1 space-y-0.5 max-h-40 overflow-y-auto pl-2'

    // Check-all / uncheck-all smart button (label flips).
    if (registered.length > 0) {
      const allChecked = registered.every(n => enabledTools.has(n))
      const toggleAll = document.createElement('button')
      toggleAll.type = 'button'
      toggleAll.className = 'text-xs text-blue-500 hover:text-blue-700 mb-1 underline'
      toggleAll.textContent = allChecked ? 'uncheck all' : 'check all'
      toggleAll.onclick = async (e) => {
        e.preventDefault()
        e.stopPropagation()
        const next = allChecked ? [] : [...registered]
        ;(agentData as Record<string, unknown>).tools = next
        await patchAgent({ tools: next })
        await render()
      }
      toolListBody.appendChild(toggleAll)
    }

    for (const name of registered) {
      const row = document.createElement('label')
      row.className = 'flex items-center gap-1 w-full'
      row.setAttribute('data-group-child-label', '')
      const cb = document.createElement('input')
      cb.type = 'checkbox'
      cb.className = 'rounded'
      cb.checked = enabledTools.has(name)
      cb.setAttribute('data-group-child', '')
      const tok = toolTokens[name] ?? 0
      const span = document.createElement('span')
      span.innerHTML = `<span class="font-mono">${escapeHtml(name)}</span> <span class="text-gray-400">~${tok} tok</span>`
      cb.onchange = async () => {
        if (cb.checked) enabledTools.add(name)
        else enabledTools.delete(name)
        ;(agentData as Record<string, unknown>).tools = [...enabledTools]
        await patchAgent({ tools: [...enabledTools] })
        await render()
      }
      row.appendChild(cb)
      row.appendChild(span)
      toolListBody.appendChild(row)
    }
    toolFold.appendChild(toolListBody)

    // Tool option inputs (iter + result chars) — moved from Advanced
    const toolOpts = document.createElement('div')
    toolOpts.className = 'flex items-center gap-3 mt-2 text-xs text-gray-500'

    const iterWrap = createInlineNumberEditor({
      label: 'iter',
      value: String(maxToolIterations ?? 5),
      tooltip: 'Max tool iterations (default 5)',
      step: '1',
      onSave: async (v) => {
        const n = v === '' ? 5 : Number(v)
        if (!Number.isFinite(n) || n < 1) return
        await patchAgent({ maxToolIterations: n })
        ;(agentData as Record<string, unknown>).maxToolIterations = n
      },
    })
    iterWrap.setAttribute('data-group-child-label', '')

    const resWrap = createInlineNumberEditor({
      label: 'result chars',
      value: typeof maxToolResultChars === 'number' ? String(maxToolResultChars) : 'default',
      tooltip: 'Max characters per tool result (blank = default)',
      step: '100',
      onSave: async (v) => {
        const patch = v === '' ? { maxToolResultChars: null } : { maxToolResultChars: Number(v) }
        await patchAgent(patch)
        ;(agentData as Record<string, unknown>).maxToolResultChars = v === '' ? null : Number(v)
      },
    })
    resWrap.setAttribute('data-group-child-label', '')

    toolOpts.appendChild(iterWrap)
    toolOpts.appendChild(resWrap)

    grid.appendChild(mkGroup({
      label: 'Tools',
      master: {
        checked: includeTools,
        onChange: async (next) => {
          (agentData as Record<string, unknown>).includeTools = next
          await patchAgent({ includeTools: next })
          await render()
        },
      },
      totalTokens: toolTokensTotal,
      children: [toolFold, toolOpts],
    }))

    // --- Group: Model (no master; always applies) ---
    const modelRows: HTMLElement[] = []

    const tempRow = createInlineNumberEditor({
      label: 'temp',
      value: String(temperature ?? 'default'),
      tooltip: 'Temperature — controls randomness',
      step: '0.1',
      onSave: async (v) => {
        const patch = v === '' ? { temperature: undefined } : { temperature: Number(v) }
        await patchAgent(patch)
        ;(agentData as Record<string, unknown>).temperature = v === '' ? undefined : Number(v)
      },
    })
    modelRows.push(tempRow)

    const histRow = createInlineNumberEditor({
      label: 'history',
      value: String(historyLimit ?? 'default'),
      tooltip: 'History limit — max messages',
      step: '1',
      onSave: async (v) => {
        const patch = v === '' ? { historyLimit: undefined } : { historyLimit: Number(v) }
        await patchAgent(patch)
        ;(agentData as Record<string, unknown>).historyLimit = v === '' ? undefined : Number(v)
      },
    })
    modelRows.push(histRow)

    const thinkRow = document.createElement('label')
    thinkRow.className = 'inline-flex items-center gap-1 cursor-pointer text-xs text-gray-500'
    const thinkCb = document.createElement('input')
    thinkCb.type = 'checkbox'
    thinkCb.className = 'rounded'
    thinkCb.checked = thinking
    thinkCb.onchange = async () => {
      await patchAgent({ thinking: thinkCb.checked })
      ;(agentData as Record<string, unknown>).thinking = thinkCb.checked
      showToast(document.body, `Thinking ${thinkCb.checked ? 'on' : 'off'}`, { position: 'fixed' })
    }
    const thinkText = document.createElement('span')
    thinkText.textContent = 'thinking'
    thinkRow.appendChild(thinkCb)
    thinkRow.appendChild(thinkText)
    modelRows.push(thinkRow)

    grid.appendChild(mkGroup({
      label: 'Model',
      children: modelRows,
    }))

    updateSummary()
  }

  void render()
}
