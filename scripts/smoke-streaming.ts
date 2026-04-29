#!/usr/bin/env bun
// ============================================================================
// Post-restart smoke test: WS broadcast wiring is alive.
//
// What it proves: a freshly issued cookie-bound instance has its
// broadcast slots wired, so events fired via routeMessage actually reach
// connected WebSockets. Catches the silent-skip class of bug fixed in
// 5d73a8e — where streaming events were dropped on the floor for every
// non-boot instance.
//
// What it does NOT exercise: real LLM streaming. The eval-event chain is
// covered by the integration test in src/api/streaming.test.ts; this
// script is the deploy-time check, kept fast and dependency-free (no
// real provider, no pack install, no agent creation).
//
// Usage:
//   set -a; source /etc/samsinn/env; set +a
//   bun run scripts/smoke-streaming.ts            # localhost:3000
//   bun run scripts/smoke-streaming.ts --url https://samsinn.app
//
// Exit codes:
//   0 — green: broadcasts arrive within timeout
//   1 — red: missing token, auth failed, or no broadcast within timeout
// ============================================================================

const TIMEOUT_MS = 5_000

const args = process.argv.slice(2)
const urlIdx = args.indexOf('--url')
const baseUrl = urlIdx >= 0 ? args[urlIdx + 1]! : 'http://localhost:3000'
const wsBaseUrl = baseUrl.replace(/^http/, 'ws')

// SAMSINN_TOKEN is now optional. When set, we authenticate via /api/auth
// to get a session cookie (deploy-mode token gate). When unset, the gate
// is inert server-side and we skip the auth step entirely.
const token = process.env.SAMSINN_TOKEN

const fail = (msg: string): never => {
  console.error(`FAIL: ${msg}`)
  process.exit(1)
}

const main = async (): Promise<void> => {
  // 1. Authenticate (only when a token is configured).
  let sessionCookie: string | undefined
  if (token) {
    const authRes = await fetch(`${baseUrl}/api/auth`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token }),
    })
    if (!authRes.ok) fail(`/api/auth returned ${authRes.status}`)
    sessionCookie = authRes.headers
      .getSetCookie()
      .find(c => c.startsWith('samsinn_session='))
      ?.split(';')[0]
    if (!sessionCookie) fail('no session cookie returned by /api/auth')
  }

  // 2. Hit diagnostics: at least one wired instance must exist already.
  const diagRes = await fetch(`${baseUrl}/api/system/diagnostics`, {
    ...(sessionCookie ? { headers: { Cookie: sessionCookie } } : {}),
  })
  if (!diagRes.ok) fail(`/api/system/diagnostics returned ${diagRes.status}`)
  const diag = await diagRes.json() as {
    instances: Array<{ id: string; wired: boolean; lastBroadcastAt: number | null }>
    wsSessions: number
  }
  const wiredCount = diag.instances.filter(i => i.wired).length
  if (wiredCount === 0) {
    fail(`no wired instances visible (instances=${diag.instances.length}). wireSystemEvents skipped?`)
  }

  // 3. Pick the first wired instance; open a WS bound to it; expect to
  //    receive a snapshot. Then send a synthetic chat message via REST
  //    and wait for the corresponding WS broadcast.
  const targetInstance = diag.instances.find(i => i.wired)!.id
  const cookie = sessionCookie
    ? `${sessionCookie}; samsinn_instance=${targetInstance}`
    : `samsinn_instance=${targetInstance}`
  // v15+: WS is a viewer; no `?name=` required.
  const ws = new WebSocket(`${wsBaseUrl}/ws`, {
    headers: { Cookie: cookie },
  } as unknown as undefined)

  const seen = new Set<string>()
  let snapshotReceived = false
  let messageReceived = false
  ws.addEventListener('message', (ev) => {
    try {
      const data = JSON.parse(ev.data as string)
      if (data.type === 'snapshot') snapshotReceived = true
      if (data.type === 'message') messageReceived = true
      seen.add(data.type)
    } catch { /* ignore non-JSON */ }
  })

  // Wait for socket to open + snapshot to arrive.
  await new Promise<void>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('WS did not open within 3s')), 3_000)
    ws.addEventListener('open', () => { clearTimeout(t); resolve() })
    ws.addEventListener('error', () => { clearTimeout(t); reject(new Error('WS errored')) })
  }).catch(e => fail(e.message))

  // Find a room to send into.
  const roomsRes = await fetch(`${baseUrl}/api/rooms`, {
    headers: { Cookie: cookie },
  })
  if (!roomsRes.ok) fail(`/api/rooms returned ${roomsRes.status}`)
  const rooms = await roomsRes.json() as Array<{ id: string }>
  if (rooms.length === 0) fail('instance has no rooms — seed should have created one')

  // POST a chat message; expect a 'message' broadcast back via WS.
  const postRes = await fetch(`${baseUrl}/api/messages`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: cookie },
    body: JSON.stringify({
      senderId: 'system',
      messageType: 'chat',
      content: `smoke-test ${new Date().toISOString()}`,
      target: { rooms: [rooms[0]!.id] },
    }),
  })
  if (!postRes.ok) fail(`/api/messages returned ${postRes.status}`)

  // Wait up to TIMEOUT_MS for a 'message' broadcast.
  await new Promise<void>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`no 'message' broadcast within ${TIMEOUT_MS}ms — broadcast wiring is broken`)), TIMEOUT_MS)
    const poll = setInterval(() => {
      if (messageReceived) { clearInterval(poll); clearTimeout(t); resolve() }
    }, 50)
  }).catch(e => fail(e.message))

  ws.close()

  if (!snapshotReceived) fail('no snapshot received on WS open — protocol regression')

  console.log(`OK: ws snapshot + message broadcast received (instance=${targetInstance.slice(0, 8)}, sessions=${diag.wsSessions}, eventTypes=${[...seen].join(',')})`)
}

main().catch(e => fail(e.message))
