// ============================================================================
// Context panel — per-agent controls for everything the LLM receives.
//
// Data source: GET /api/agents/:name/context-preview?roomId=:roomId returns
// section-by-section text + token estimates + budget resolution. The panel
// is a pure view over that payload; every checkbox edit PATCHes the agent
// and re-fetches the preview to redraw.
//
// Layout:
//   Prompts        — 5 toggles (agent/room/house/responseFormat/skills)
//   Context data   — 5 sub-toggles (collapsed by default)
//   Tools          — master + per-tool expand
//   History        — count / char cap / context budget
//   Advanced       — flow step prompt + tool loop caps (collapsed)
// ============================================================================

import { safeFetchJson, showToast } from './ui-utils.ts'
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
  budget: { value: number; source: 'override' | 'auto' | 'fallback'; modelMax: number }
  historyEstimate: { messages: number; chars: number }
  toolTokens: Record<string, number>
  registeredTools: string[]
}

const escapeHtml = (s: string): string =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

// --- Preview modal ---
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

// ============================================================================

export interface PromptTogglesDeps {
  readonly agentName: string
  readonly agentEnc: string
  readonly agentData: AgentData & Record<string, unknown>
  readonly promptTextarea: HTMLTextAreaElement
}

export const renderPromptToggles = (container: HTMLElement, deps: PromptTogglesDeps): void => {
  const { agentEnc, agentData, promptTextarea } = deps

  // Root collapsible
  const details = document.createElement('details')
  details.className = 'border border-gray-100 rounded mb-3'
  details.open = true

  const summary = document.createElement('summary')
  summary.className = 'px-3 py-2 cursor-pointer text-xs font-semibold text-gray-500 uppercase tracking-wide hover:bg-gray-50'
  details.appendChild(summary)

  const body = document.createElement('div')
  body.className = 'px-3 py-2 space-y-3'
  details.appendChild(body)
  container.appendChild(details)

  const placeholder = document.createElement('div')
  placeholder.className = 'text-xs text-gray-400'
  placeholder.textContent = 'Loading…'
  body.appendChild(placeholder)
  summary.textContent = 'Context — loading…'

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
    const preview = await fetchPreview()
    body.innerHTML = ''
    if (!preview) {
      summary.textContent = 'Context — (failed to load)'
      body.textContent = 'Failed to load context preview.'
      return
    }

    // --- Resolve current state from preview ---
    const get = (k: string): PreviewSection | undefined => sectionByKey(preview, k)
    const promptKeys: ReadonlyArray<{ code: 'agent'|'room'|'house'|'responseFormat'|'skills'; section: string; label: string }> = [
      { code: 'agent',          section: 'agent',          label: 'Agent prompt' },
      { code: 'room',           section: 'room',           label: 'Room prompt' },
      { code: 'house',          section: 'house',          label: 'System prompt' },
      { code: 'responseFormat', section: 'responseFormat', label: 'Response format' },
      { code: 'skills',         section: 'skills',         label: 'Skills' },
    ]
    const contextKeys: ReadonlyArray<{ code: 'participants'|'flow'|'artifacts'|'activity'|'knownAgents'; section: string; label: string; warning?: string }> = [
      { code: 'participants', section: 'ctx_participants', label: 'Participants list' },
      { code: 'flow',         section: 'ctx_flow',         label: 'Flow section' },
      { code: 'artifacts',    section: 'ctx_artifacts',    label: 'Artifacts' },
      { code: 'activity',     section: 'ctx_activity',     label: 'Activity in other rooms' },
      { code: 'knownAgents',  section: 'ctx_knownAgents',  label: 'Known agents', warning: 'breaks [[Name]] mentions' },
    ]

    const includePrompts = (agentData.includePrompts as Record<string, boolean>) ?? {}
    const includeContext = (agentData.includeContext as Record<string, boolean>) ?? {}
    const includeFlowStepPrompt = (agentData.includeFlowStepPrompt as boolean) ?? true
    const includeTools = (agentData.includeTools as boolean) ?? true
    const maxHistoryChars = agentData.maxHistoryChars as number | null | undefined
    const maxContextTokens = agentData.maxContextTokens as number | null | undefined
    const maxToolResultChars = agentData.maxToolResultChars as number | null | undefined
    const maxToolIterations = agentData.maxToolIterations as number | null | undefined

    const registered = preview.registeredTools
    const enabledTools = new Set<string>(
      (agentData.tools as string[] | undefined) ?? registered,
    )
    const toolTokens = preview.toolTokens

    // --- Summary line ---
    const updateSummary = (): void => {
      const promptsOn = promptKeys.filter(p => (includePrompts[p.code] ?? true) && (get(p.section)?.enabled ?? false)).length
      const promptsTotal = promptKeys.filter(p => (get(p.section)?.text?.length ?? 0) > 0).length
      const ctxOn = contextKeys.filter(c => (includeContext[c.code] ?? true) && (get(c.section)?.enabled ?? false)).length
      const ctxTotal = contextKeys.filter(c => (get(c.section)?.text?.length ?? 0) > 0).length
      let used = 0
      for (const p of promptKeys) {
        if ((includePrompts[p.code] ?? true)) used += get(p.section)?.tokens ?? 0
      }
      for (const c of contextKeys) {
        if ((includeContext[c.code] ?? true)) used += get(c.section)?.tokens ?? 0
      }
      if (includeTools) {
        for (const t of enabledTools) used += toolTokens[t] ?? 0
      }
      const overflow = used > preview.budget.value
      summary.textContent = `Context — ${promptsOn}/${promptsTotal} prompts · ${ctxOn}/${ctxTotal} context · tools ${includeTools ? enabledTools.size : 0}/${registered.length} · ${overflow ? '⚠ ' : ''}~${used} / ${preview.budget.value} tok`
      summary.style.color = overflow ? '#d97706' : ''
    }

    // --- Section renderer (toggle row with glass + token span) ---
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
      const cb = document.createElement('input')
      cb.type = 'checkbox'
      cb.className = 'rounded'
      cb.checked = checked
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

    // --- Group: Prompts ---
    const promptsGroup = document.createElement('div')
    const pLabel = document.createElement('div')
    pLabel.className = 'text-xs font-semibold text-gray-400 uppercase tracking-wide mb-1'
    pLabel.textContent = 'Prompts'
    promptsGroup.appendChild(pLabel)
    const promptsList = document.createElement('div')
    promptsList.className = 'flex flex-col gap-y-1 text-xs'
    for (const p of promptKeys) {
      const sec = get(p.section)
      const row = mkToggleRow(
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
      promptsList.appendChild(row)
    }
    promptsGroup.appendChild(promptsList)
    body.appendChild(promptsGroup)

    // --- Group: Context data (collapsed) ---
    const ctxDetails = document.createElement('details')
    const ctxSummary = document.createElement('summary')
    ctxSummary.className = 'cursor-pointer text-xs font-semibold text-gray-400 uppercase tracking-wide hover:text-gray-600'
    ctxSummary.textContent = 'Context data'
    ctxDetails.appendChild(ctxSummary)
    const ctxList = document.createElement('div')
    ctxList.className = 'flex flex-col gap-y-1 text-xs mt-1 pl-2'
    for (const c of contextKeys) {
      const sec = get(c.section)
      const row = mkToggleRow(
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
      ctxList.appendChild(row)
    }
    ctxDetails.appendChild(ctxList)
    body.appendChild(ctxDetails)

    // --- Group: Tools ---
    const toolsGroup = document.createElement('div')
    const tLabel = document.createElement('div')
    tLabel.className = 'text-xs font-semibold text-gray-400 uppercase tracking-wide mb-1'
    tLabel.textContent = 'Tools'
    toolsGroup.appendChild(tLabel)
    const enabledToolTokens = (): number => includeTools ? [...enabledTools].reduce((s, n) => s + (toolTokens[n] ?? 0), 0) : 0
    const toolsMaster = document.createElement('label')
    toolsMaster.className = 'inline-flex items-center gap-1 cursor-pointer text-xs'
    const masterCb = document.createElement('input')
    masterCb.type = 'checkbox'
    masterCb.className = 'rounded'
    masterCb.checked = includeTools
    const masterLabel = document.createElement('span')
    const refreshMasterLabel = (): void => {
      masterLabel.textContent = `Enable tools — ${enabledTools.size}/${registered.length} on (~${enabledToolTokens()} tok)`
    }
    refreshMasterLabel()
    toolsMaster.appendChild(masterCb)
    toolsMaster.appendChild(masterLabel)
    masterCb.onchange = async () => {
      (agentData as Record<string, unknown>).includeTools = masterCb.checked
      await patchAgent({ includeTools: masterCb.checked })
      await render()
    }
    toolsGroup.appendChild(toolsMaster)

    const toolList = document.createElement('details')
    toolList.className = 'mt-1 ml-5 text-xs'
    const toolListSummary = document.createElement('summary')
    toolListSummary.className = 'cursor-pointer text-gray-500 hover:text-gray-700'
    toolListSummary.textContent = `Per-tool selection (${registered.length} registered)`
    toolList.appendChild(toolListSummary)
    const toolListBody = document.createElement('div')
    toolListBody.className = 'mt-1 space-y-0.5 max-h-40 overflow-y-auto pl-2'
    for (const name of registered) {
      const row = document.createElement('label')
      row.className = 'inline-flex items-center gap-1 w-full'
      const cb = document.createElement('input')
      cb.type = 'checkbox'
      cb.className = 'rounded'
      cb.checked = enabledTools.has(name)
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
    toolList.appendChild(toolListBody)
    toolsGroup.appendChild(toolList)
    body.appendChild(toolsGroup)

    // --- Group: History & budget ---
    const histGroup = document.createElement('div')
    const hLabel = document.createElement('div')
    hLabel.className = 'text-xs font-semibold text-gray-400 uppercase tracking-wide mb-1'
    hLabel.textContent = 'History & budget'
    histGroup.appendChild(hLabel)

    // Char cap
    const charRow = document.createElement('div')
    charRow.className = 'text-xs flex items-center gap-2 mb-1'
    charRow.innerHTML = '<span class="w-32 text-gray-500">Char cap</span>'
    const charInput = document.createElement('input')
    charInput.type = 'number'
    charInput.min = '0'
    charInput.placeholder = 'blank = no cap'
    charInput.className = 'border rounded px-2 py-0.5 text-xs w-32'
    charInput.value = typeof maxHistoryChars === 'number' ? String(maxHistoryChars) : ''
    const charHint = document.createElement('span')
    charHint.className = 'text-gray-400'
    charHint.textContent = `(~${Math.ceil(preview.historyEstimate.chars / 4)} tok in ${preview.historyEstimate.messages} msgs now)`
    charInput.onchange = async () => {
      const v = charInput.value.trim()
      const patch = v === '' ? { maxHistoryChars: null } : { maxHistoryChars: Number(v) }
      await patchAgent(patch)
      ;(agentData as Record<string, unknown>).maxHistoryChars = v === '' ? null : Number(v)
      await render()
    }
    charRow.appendChild(charInput)
    charRow.appendChild(charHint)
    histGroup.appendChild(charRow)

    // Context budget
    const bRow = document.createElement('div')
    bRow.className = 'text-xs flex items-center gap-2'
    bRow.innerHTML = '<span class="w-32 text-gray-500">Context budget</span>'
    const bInfo = document.createElement('span')
    const src = preview.budget.source
    const bText = src === 'override'
      ? `${preview.budget.value} (override)`
      : src === 'auto'
        ? `${preview.budget.value} auto (70% of ${preview.budget.modelMax})`
        : `${preview.budget.value} fallback (model window unknown)`
    bInfo.textContent = bText
    bInfo.className = 'text-gray-500'
    bRow.appendChild(bInfo)
    const bInput = document.createElement('input')
    bInput.type = 'number'
    bInput.min = '0'
    bInput.placeholder = 'override'
    bInput.className = 'border rounded px-2 py-0.5 text-xs w-24 ml-2'
    bInput.value = typeof maxContextTokens === 'number' ? String(maxContextTokens) : ''
    bInput.onchange = async () => {
      const v = bInput.value.trim()
      const patch = v === '' ? { maxContextTokens: null } : { maxContextTokens: Number(v) }
      await patchAgent(patch)
      ;(agentData as Record<string, unknown>).maxContextTokens = v === '' ? null : Number(v)
      showToast(document.body, `Context budget ${v === '' ? 'reset to auto' : `set to ${v}`}`, { position: 'fixed' })
      await render()
    }
    bRow.appendChild(bInput)
    histGroup.appendChild(bRow)
    body.appendChild(histGroup)

    // --- Group: Advanced (collapsed) ---
    const advDetails = document.createElement('details')
    const advSummary = document.createElement('summary')
    advSummary.className = 'cursor-pointer text-xs font-semibold text-gray-400 uppercase tracking-wide hover:text-gray-600'
    advSummary.textContent = 'Advanced'
    advDetails.appendChild(advSummary)
    const advBody = document.createElement('div')
    advBody.className = 'text-xs flex flex-col gap-y-1 mt-1 pl-2'

    // Flow step prompt
    const flowWrap = document.createElement('div')
    flowWrap.className = 'flex items-center gap-1'
    const flowLabel = document.createElement('label')
    flowLabel.className = 'inline-flex items-center gap-1 cursor-pointer'
    const flowCb = document.createElement('input')
    flowCb.type = 'checkbox'
    flowCb.className = 'rounded'
    flowCb.checked = includeFlowStepPrompt
    const flowSpan = document.createElement('span')
    flowSpan.textContent = 'Include flow step instructions'
    flowLabel.appendChild(flowCb)
    flowLabel.appendChild(flowSpan)
    flowWrap.appendChild(flowLabel)
    const flowWarn = document.createElement('span')
    flowWarn.className = 'text-amber-600 ml-1'
    flowWarn.textContent = '⚠ off may break flow routing'
    flowWarn.style.display = includeFlowStepPrompt ? 'none' : 'inline'
    flowWrap.appendChild(flowWarn)
    flowCb.onchange = async () => {
      flowWarn.style.display = flowCb.checked ? 'none' : 'inline'
      (agentData as Record<string, unknown>).includeFlowStepPrompt = flowCb.checked
      await patchAgent({ includeFlowStepPrompt: flowCb.checked })
      await render()
    }
    advBody.appendChild(flowWrap)

    // Max tool iterations
    const itRow = document.createElement('div')
    itRow.className = 'flex items-center gap-2'
    itRow.innerHTML = '<span class="w-40 text-gray-500">Max tool iterations</span>'
    const itInput = document.createElement('input')
    itInput.type = 'number'
    itInput.min = '1'
    itInput.className = 'border rounded px-2 py-0.5 text-xs w-20'
    itInput.value = String(maxToolIterations ?? 5)
    itInput.onchange = async () => {
      const n = Number(itInput.value)
      if (!Number.isFinite(n) || n < 1) return
      await patchAgent({ maxToolIterations: n })
      ;(agentData as Record<string, unknown>).maxToolIterations = n
      showToast(document.body, `Max tool iterations set to ${n}`, { position: 'fixed' })
    }
    itRow.appendChild(itInput)
    advBody.appendChild(itRow)

    // Max tool result chars
    const tcRow = document.createElement('div')
    tcRow.className = 'flex items-center gap-2'
    tcRow.innerHTML = '<span class="w-40 text-gray-500">Max tool result chars</span>'
    const tcInput = document.createElement('input')
    tcInput.type = 'number'
    tcInput.min = '0'
    tcInput.className = 'border rounded px-2 py-0.5 text-xs w-24'
    tcInput.placeholder = '4000'
    tcInput.value = typeof maxToolResultChars === 'number' ? String(maxToolResultChars) : ''
    tcInput.onchange = async () => {
      const v = tcInput.value.trim()
      const patch = v === '' ? { maxToolResultChars: null } : { maxToolResultChars: Number(v) }
      await patchAgent(patch)
      ;(agentData as Record<string, unknown>).maxToolResultChars = v === '' ? null : Number(v)
    }
    tcRow.appendChild(tcInput)
    advBody.appendChild(tcRow)

    advDetails.appendChild(advBody)
    body.appendChild(advDetails)

    updateSummary()
  }

  void render()
}
