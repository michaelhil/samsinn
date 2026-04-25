// ============================================================================
// Auth gate — runs before the rest of the UI boots.
//
// Server tells us whether auth is required (via GET /api/auth) and whether
// our cookie is currently valid. If auth is on and we're not authed, we
// show a token prompt; on submit we POST /api/auth which sets the
// HttpOnly cookie. After that, the page is reloaded and the regular boot
// flow runs.
//
// Returns a Promise that resolves only when the page is authed (or auth
// is disabled). Callers `await ensureAuthenticated()` before connecting WS.
// ============================================================================

interface AuthStatus {
  authEnabled: boolean
  authenticated: boolean
}

const fetchStatus = async (): Promise<AuthStatus> => {
  try {
    const res = await fetch('/api/auth', { method: 'GET' })
    if (!res.ok) return { authEnabled: true, authenticated: false }
    return await res.json() as AuthStatus
  } catch {
    return { authEnabled: true, authenticated: false }
  }
}

const submitToken = async (token: string): Promise<boolean> => {
  try {
    const res = await fetch('/api/auth', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token }),
    })
    return res.ok
  } catch {
    return false
  }
}

const showTokenPrompt = (errorMsg?: string): Promise<string> =>
  new Promise(resolve => {
    const overlay = document.createElement('div')
    overlay.style.cssText = 'position:fixed;inset:0;background:var(--surface-muted);display:flex;align-items:center;justify-content:center;z-index:9999;font-family:system-ui,sans-serif'

    const card = document.createElement('div')
    card.style.cssText = 'background:var(--surface);padding:24px;border-radius:8px;box-shadow:0 4px 24px var(--shadow-overlay);max-width:380px;width:90%'

    const title = document.createElement('h2')
    title.textContent = 'Sandbox access'
    title.style.cssText = 'margin:0 0 8px;font-size:16px;font-weight:600;color:var(--text-strong)'

    const desc = document.createElement('p')
    desc.textContent = 'Enter the access token to use this Samsinn sandbox.'
    desc.style.cssText = 'margin:0 0 16px;font-size:13px;color:var(--text-subtle)'

    const form = document.createElement('form')
    form.style.cssText = 'display:flex;flex-direction:column;gap:8px'

    const input = document.createElement('input')
    input.type = 'password'
    input.autocomplete = 'off'
    input.placeholder = 'Token'
    input.required = true
    input.style.cssText = 'padding:8px 10px;border:1px solid var(--border-strong);border-radius:4px;font-size:13px;background:var(--surface);color:var(--text)'

    const submit = document.createElement('button')
    submit.type = 'submit'
    submit.textContent = 'Continue'
    submit.style.cssText = 'padding:8px 12px;border:none;border-radius:4px;background:var(--accent);color:#fff;font-size:13px;cursor:pointer'

    const err = document.createElement('div')
    err.style.cssText = 'font-size:12px;color:var(--danger);min-height:1em'
    if (errorMsg) err.textContent = errorMsg

    form.appendChild(input)
    form.appendChild(submit)
    form.appendChild(err)
    card.appendChild(title)
    card.appendChild(desc)
    card.appendChild(form)
    overlay.appendChild(card)
    document.body.appendChild(overlay)
    input.focus()

    form.onsubmit = (e) => {
      e.preventDefault()
      const value = input.value.trim()
      if (!value) return
      overlay.remove()
      resolve(value)
    }
  })

// Resolves only when the page is authenticated. If auth is enabled and we
// don't have a valid session, keep prompting until the user enters a
// correct token.
export const ensureAuthenticated = async (): Promise<void> => {
  const status = await fetchStatus()
  if (!status.authEnabled) return
  if (status.authenticated) return

  let lastErr: string | undefined
  while (true) {
    const token = await showTokenPrompt(lastErr)
    const ok = await submitToken(token)
    if (ok) return
    lastErr = 'Token rejected — try again.'
  }
}
