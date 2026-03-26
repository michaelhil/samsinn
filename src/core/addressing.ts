// ============================================================================
// Addressing — Parse [[AgentName]] patterns from message content.
//
// Used by Room to determine directed delivery targets.
// Works in both TT and non-TT mode as a general delivery filter.
// ============================================================================

const AGENT_ADDRESS_RE = /\[\[([^\]]+)\]\]/g

export const parseAddressedAgents = (content: string): ReadonlyArray<string> => {
  const seen = new Set<string>()
  const names: string[] = []
  let match: RegExpExecArray | null
  AGENT_ADDRESS_RE.lastIndex = 0
  while ((match = AGENT_ADDRESS_RE.exec(content)) !== null) {
    const name = match[1]!.trim()
    if (name.length > 0 && !seen.has(name)) {
      seen.add(name)
      names.push(name)
    }
  }
  return names
}
