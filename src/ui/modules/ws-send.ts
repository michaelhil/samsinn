// ============================================================================
// Shared WS send reference.
//
// A tiny module that holds the active WSClient so any UI module can dispatch
// messages without being passed the client through multiple layers. Set
// once after connect; every caller
// reads the same reference.
//
// If the client is null (pre-connect or post-disconnect), send() is a
// no-op — callers don't need to guard.
// ============================================================================

import type { WSClient } from './ws-client.ts'

let client: WSClient | null = null

export const setWSClient = (c: WSClient | null): void => {
  client = c
}

export const send = (data: unknown): void => {
  client?.send(data)
}
