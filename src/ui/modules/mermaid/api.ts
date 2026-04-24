// Mermaid API loader — lazy ESM import from jsdelivr, cached in module scope.
//
// Mermaid 11's ESM build does not auto-attach to globalThis.mermaid the way
// older UMD builds did. We hold the resolved API as `mermaidApi` for
// synchronous access (e.g. from reRenderAllMermaid).
//
// `suppressErrorRendering: true` makes render() throw on bad syntax instead
// of returning the bomb-icon SVG — callers substitute their own fallback UI.
//
// Failure policy: if the CDN import rejects, ensureMermaid() resolves to
// `null` (not rejects). A rejected load stays null for the session — no
// auto-retry, since retrying a broken CDN hammers the network without a
// realistic recovery path. The user fixes connectivity and reloads the page.

export type MermaidApi = {
  render: (id: string, source: string) => Promise<{ svg: string }>
  initialize: (config: Record<string, unknown>) => void
}

const MERMAID_CDN = 'https://cdn.jsdelivr.net/npm/mermaid@11/dist/mermaid.esm.min.mjs'

let mermaidReady: Promise<MermaidApi | null> | null = null
let mermaidApi: MermaidApi | null = null

export const mermaidThemeForCurrentMode = (): string =>
  document.documentElement.classList.contains('dark') ? 'dark' : 'neutral'

const initConfig = () => ({
  startOnLoad: false,
  theme: mermaidThemeForCurrentMode(),
  suppressErrorRendering: true,
})

export const ensureMermaid = (): Promise<MermaidApi | null> => {
  if (mermaidReady) return mermaidReady
  mermaidReady = import(MERMAID_CDN)
    .then((m: { default: MermaidApi }) => {
      m.default.initialize(initConfig())
      mermaidApi = m.default
      return m.default
    })
    .catch((err: unknown) => {
      console.warn('[mermaid] load failed — diagram rendering unavailable:', err)
      mermaidApi = null
      return null
    })
  return mermaidReady
}

// Synchronous accessor — returns null before the first successful load and
// after a failed load. Used by reRenderAllMermaid which only makes sense
// when the api is already known to be available.
export const getMermaidApi = (): MermaidApi | null => mermaidApi

// Re-apply configuration (e.g. after a theme flip). No-op if api unavailable.
export const reinitMermaid = (): void => {
  if (mermaidApi) mermaidApi.initialize(initConfig())
}
