// Mermaid rendering — lazy-loads mermaid.js on first encounter. Replaces
// ```mermaid code blocks with rendered SVG, and renders standalone source
// into a container (for the mermaid artifact type).

let mermaidReady: Promise<void> | null = null
let mermaidRenderCount = 0

export const ensureMermaid = (): Promise<void> => {
  if (mermaidReady) return mermaidReady
  mermaidReady = import('https://cdn.jsdelivr.net/npm/mermaid@11/dist/mermaid.esm.min.mjs')
    .then((m: { default: { initialize: (config: Record<string, unknown>) => void } }) => {
      m.default.initialize({ startOnLoad: false, theme: 'neutral' })
    })
  return mermaidReady
}

export const renderMermaidBlocks = async (container: HTMLElement): Promise<void> => {
  const blocks = container.querySelectorAll('code.language-mermaid')
  if (blocks.length === 0) return

  await ensureMermaid()
  const mermaidApi = (globalThis as Record<string, unknown>).mermaid as {
    render: (id: string, source: string) => Promise<{ svg: string }>
  }

  for (const block of blocks) {
    const pre = block.parentElement
    if (!pre) continue
    try {
      const id = `mermaid-${++mermaidRenderCount}`
      const { svg } = await mermaidApi.render(id, block.textContent ?? '')
      const wrapper = document.createElement('div')
      wrapper.className = 'my-2 overflow-x-auto'
      wrapper.innerHTML = svg
      pre.replaceWith(wrapper)
    } catch {
      // Leave as code block if mermaid can't parse it
    }
  }
}

export const renderMermaidSource = async (container: HTMLElement, source: string): Promise<void> => {
  await ensureMermaid()
  const mermaidApi = (globalThis as Record<string, unknown>).mermaid as {
    render: (id: string, source: string) => Promise<{ svg: string }>
  }
  try {
    const id = `mermaid-${++mermaidRenderCount}`
    const { svg } = await mermaidApi.render(id, source)
    container.innerHTML = svg
  } catch {
    container.textContent = `Mermaid error:\n${source}`
    container.className = 'text-xs text-red-500 font-mono whitespace-pre'
  }
}
