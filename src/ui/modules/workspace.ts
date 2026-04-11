// ============================================================================
// Workspace — Resizable bottom pane for artifacts and visualizations.
//
// Three states: collapsed (bar only), expanded (split view, draggable),
// maximized (workspace fills center, chat hidden).
// ============================================================================

export type WorkspaceMode = 'collapsed' | 'expanded' | 'maximized'

export interface Workspace {
  readonly getMode: () => WorkspaceMode
  readonly toggle: () => void
  readonly apply: () => void
  readonly setCount: (n: number) => void
  readonly show: () => void
  readonly hide: () => void
}

export const createWorkspace = (elements: {
  bar: HTMLElement
  pane: HTMLElement
  chatArea: HTMLElement
  label: HTMLElement
}): Workspace => {
  const { bar, pane, chatArea, label } = elements
  let mode: WorkspaceMode = 'collapsed'
  let height = parseInt(localStorage.getItem('samsinn-workspace-height') ?? '200')
  let count = 0

  const apply = (): void => {
    if (mode === 'collapsed') {
      pane.classList.add('hidden')
      pane.style.height = ''
      chatArea.classList.remove('hidden')
      label.textContent = `▲ Workspace${count > 0 ? ` (${count})` : ''}`
    } else if (mode === 'expanded') {
      pane.classList.remove('hidden')
      pane.style.height = `${height}px`
      chatArea.classList.remove('hidden')
      label.textContent = `▼ Workspace${count > 0 ? ` (${count})` : ''}`
    } else {
      // maximized
      pane.classList.remove('hidden')
      pane.style.height = ''
      pane.style.flex = '1'
      chatArea.classList.add('hidden')
      label.textContent = `▼ Back to chat${count > 0 ? ` (${count})` : ''}`
    }
  }

  const toggle = (): void => {
    if (mode === 'collapsed') mode = 'expanded'
    else if (mode === 'expanded') mode = 'collapsed'
    else mode = 'collapsed'  // maximized → collapsed
    if (mode !== 'maximized') {
      pane.style.flex = ''
    }
    apply()
  }

  bar.onclick = toggle

  // Double-click to maximize
  bar.ondblclick = (e) => {
    e.preventDefault()
    if (mode === 'maximized') {
      mode = 'collapsed'
    } else {
      mode = 'maximized'
    }
    if (mode !== 'maximized') {
      pane.style.flex = ''
    }
    apply()
  }

  // Drag to resize
  bar.onmousedown = (e) => {
    if (mode !== 'expanded') return
    e.preventDefault()
    const startY = e.clientY
    const startHeight = height

    const onMove = (ev: MouseEvent): void => {
      const delta = startY - ev.clientY
      height = Math.max(100, Math.min(600, startHeight + delta))
      pane.style.height = `${height}px`
    }

    const onUp = (): void => {
      document.removeEventListener('mousemove', onMove)
      document.removeEventListener('mouseup', onUp)
      localStorage.setItem('samsinn-workspace-height', String(height))
    }

    document.addEventListener('mousemove', onMove)
    document.addEventListener('mouseup', onUp)
  }

  return {
    getMode: () => mode,
    toggle,
    apply,
    setCount: (n: number) => {
      count = n
      // Update label text without changing mode
      const prefix = mode === 'maximized' ? '▼ Back to chat' : mode === 'expanded' ? '▼ Workspace' : '▲ Workspace'
      label.textContent = `${prefix}${n > 0 ? ` (${n})` : ''}`
    },
    show: () => { bar.classList.remove('hidden'); apply() },
    hide: () => { bar.classList.add('hidden'); pane.classList.add('hidden') },
  }
}
