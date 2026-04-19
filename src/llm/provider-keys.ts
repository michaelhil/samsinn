// ============================================================================
// Provider keys — in-memory registry of current API keys, mutable at runtime.
//
// Built once at boot from the merged env+store config. The PUT /api/providers
// handler calls `set()` to apply new keys without restarting. The OAI-compat
// adapter reads keys via a getter closure (see openai-compatible.ts) so each
// HTTP request uses the current value.
//
// A provider is considered "enabled" iff its current key is non-empty. For
// env-sourced keys this is effectively immutable (set() still works but the
// UI disables editing in that case).
// ============================================================================

import type { CloudProviderName } from './providers-config.ts'
import type { MergedProviders } from './providers-store.ts'

export interface ProviderKeys {
  readonly get: (name: string) => string
  readonly set: (name: string, key: string) => void
  readonly isEnabled: (name: string) => boolean
  readonly list: () => ReadonlyArray<{ name: string; enabled: boolean }>
}

export const createProviderKeys = (initial: MergedProviders): ProviderKeys => {
  const keys = new Map<string, string>()
  for (const [name, entry] of Object.entries(initial.cloud)) {
    if (entry?.apiKey) keys.set(name, entry.apiKey)
    else keys.set(name, '')
  }

  return {
    get: (name) => keys.get(name) ?? '',
    set: (name, key) => { keys.set(name, key) },
    isEnabled: (name) => (keys.get(name) ?? '').length > 0,
    list: () => Array.from(keys.entries()).map(([name, key]) => ({
      name: name as CloudProviderName,
      enabled: key.length > 0,
    })),
  }
}
