# Unified Simplification Plan — Revised
## DM Removal · Tool Removal · Causality Tracking

*This document supersedes docs/causality-tracking.md and the first version of this file.*
*Changes from the first draft are marked **[CHANGE]** with a reason.*

---

## Adversarial Review Findings

The following problems were found in the first plan and are corrected here.

### 1. Fatal: Tombstone propagation is broken [CRITICAL]

The first plan had: "Room posts `room_summary` landmark with `metadata.compressedIds` → agents receive it via normal message delivery → agents update `RoomContext.compressedIds`."

**This doesn't work.** `room.post()` has:
```typescript
const nonDeliverable = message.type === 'system' || message.type === 'mute' || message.type === 'room_summary'
if (nonDeliverable || !deliver) return message
```

`room_summary` messages are explicitly non-deliverable. Agents never receive them. The propagation mechanism described would silently do nothing.

**Fix**: Abandon message-based propagation entirely. Use a `getCompressedIds` function in `BuildContextDeps` — same pattern as `getRoomTodos`. `resolveRef()` fetches live from the Room at context-build time. No agent-side caching needed. No propagation needed.

Consequences: `RoomContext.compressedIds` field is **not needed**. `RoomContext` interface is **unchanged** by V2.

### 2. Missing: Message.roomId should become required

After DM removal every message lives in a room — `roomId` is always set. The first plan left `roomId?: string` optional. Making it required eliminates optional-chaining and null checks across `receive()`, `context-builder.ts`, and filtering expressions.

**Fix**: Change `Message.roomId` from `readonly roomId?: string` to `readonly roomId: string`. Update the Omit in PostParams (roomId is still stamped by Room, so still omitted from PostParams — the structural relationship is unchanged, only the required-ness of the output type changes).

### 3. Missing: RouterDeps.deliver should also be removed

`deliver` in `RouterDeps` was used only by the DM branch — constructing and delivering the DM message directly. After DM removal, `createMessageRouter` only calls `room.post()`, which handles delivery internally via the `DeliverFn` injected into Room via HouseCallbacks. `RouterDeps.deliver` is dead.

**Fix**: Remove `deliver` from `RouterDeps`. Signature becomes `{ house: House }`. The `deliver` field is removed from the interface and the `createMessageRouter` call in `main.ts`.

### 4. Missing: receive() simplification is deeper than planned

With `roomId` required, `receive()` in `ai-agent.ts` restructures significantly:
- The outer `if (message.roomId) { ... } else { ... }` branch disappears
- Own messages get an early return after updating history
- All other messages unconditionally go to `incoming` and may trigger evaluation
- `tryEvaluate` takes a single required `string` (roomId), not optional parameters

### 5. Missing: Breaking WS API change — needs explicit flagging

`WSInbound.post_message` currently accepts `target: MessageTarget` where `target.agents` is used for DMs. After removing `agents` from `MessageTarget`, clients sending `target: { agents: ['Analyst'] }` will silently post to zero rooms. This must be documented as a breaking change. Existing clients must migrate to room-based routing.

### 6. Missing: list_agents tool description references query_agent

The `list_agents` tool description says "Check here before using `query_agent` or `add_to_room`." After removing `query_agent`, this is stale.

### 7. Confirmed: RoomContext.compressedIds is not needed (see fix #1)

V2 uses the `BuildContextDeps` getter pattern. `RoomContext` stays unchanged.

### 8. Confirmed: RouterDeps analysis

After removing `team` (DM branch) and `deliver` (DM delivery), `RouterDeps` reduces to `{ house: House }`. The type can be inlined or kept as a one-field interface — keep the named type for clarity.

### 9. Confirmed: correlationId stays

With single-room routing it always groups exactly one message, so it provides no grouping value today. However it's low-cost, schema-stable, and potentially useful for future multi-room broadcasting. Keep unchanged.

### 10. Tests to delete/replace

`ai-agent.test.ts`: 3 query tests (`query returns LLM response directly`, `query includes asker identity in prompt`, `query rejects concurrent calls`) → delete.

`integration.test.ts`: 5 DM tests (`DM flow — AI agent receives DM and responds`, `DM delivery: recipient and sender both receive`, `correlationId shared across multi-target delivery`, `DM does not go through room — room has no record`, `agent self-DM is prevented`) → delete. The `correlationId` multi-target test should be replaced with a single-room variant since multi-target no longer involves DMs.

---

## Architecture After All Changes

### Data Flow (simplified)

```
Human/WS → post_message { rooms: [roomId] }
         → routeMessage({ rooms }, params)
         → room.post(params) → message with roomId (required)
         → deliver(agentId, message) → agent.receive(message)

agent.receive(message):
  if own message → append to room history, return
  append to incoming
  if evaluable type → tryEvaluate(message.roomId)

tryEvaluate(roomId: string):
  if already generating → addPending
  buildContext(deps, roomId) → ContextResult { messages, flushInfo }
  evaluate(context, ...) → { decision, flushInfo }
  stamp decision.inReplyTo = [...flushInfo.ids]
  onDecision(decision)
  flushIncoming(flushInfo, history)

onDecision(decision):
  routeMessage({ rooms: [decision.triggerRoomId] }, {
    ..., inReplyTo: decision.inReplyTo
  })
```

No DM branches. No peerId anywhere. Every evaluation is room-triggered.

---

## Final Data Model

### Message
```typescript
interface Message {
  readonly id: string
  readonly senderId: string
  readonly senderName?: string
  readonly content: string
  readonly timestamp: number
  readonly type: MessageType
  readonly roomId: string                             // [CHANGE] now required (was optional)
  // REMOVED: recipientId
  readonly correlationId?: string
  readonly generationMs?: number
  readonly metadata?: Record<string, unknown>
  readonly inReplyTo?: ReadonlyArray<string>          // NEW: causal parents
}
```

### PostParams
```typescript
// CHANGE: recipientId removed from Omit (no longer on Message)
type PostParams = Omit<Message, 'id' | 'roomId' | 'timestamp'>
// inReplyTo flows through automatically as optional
```

### AgentHistory
```typescript
interface AgentHistory {
  readonly rooms: Map<string, RoomContext>
  // REMOVED: dms: Map<string, DMContext>
  readonly incoming: Message[]
  readonly agentProfiles: Map<string, AgentProfile>
}
```

### RoomContext — UNCHANGED
```typescript
interface RoomContext {
  readonly profile: RoomProfile
  history: ReadonlyArray<Message>
  lastActiveAt?: number
  // NOTE: compressedIds NOT added here — V2 uses BuildContextDeps getter instead
}
```

### FlushInfo
```typescript
interface FlushInfo {
  readonly ids: Set<string>
  readonly triggerRoomId: string       // [CHANGE] required (was optional)
  // REMOVED: dmMessages, triggerPeerId
}
```

### Decision
```typescript
interface Decision {
  readonly response: AgentResponse
  readonly generationMs: number
  readonly triggerRoomId: string       // [CHANGE] required (was optional)
  // REMOVED: triggerPeerId
  readonly inReplyTo?: ReadonlyArray<string>  // NEW
}
```

### MessageTarget
```typescript
interface MessageTarget {
  readonly rooms: ReadonlyArray<string>   // [CHANGE] required (was optional)
  // REMOVED: agents
}
```

### RouterDeps
```typescript
interface RouterDeps {
  readonly house: House
  // REMOVED: team
  // REMOVED: deliver  [CHANGE vs first plan]
}
```

### RoomState
```typescript
interface RoomState {
  readonly mode: DeliveryMode
  readonly paused: boolean
  readonly muted: ReadonlyArray<string>
  readonly members: ReadonlyArray<string>
  readonly flowExecution?: { flowId: string; stepIndex: number }
  readonly compressedIds?: ReadonlyArray<string>   // NEW (V2)
}
```

### BuildContextDeps
```typescript
interface BuildContextDeps {
  readonly agentId: string
  readonly systemPrompt: string
  readonly housePrompt?: string
  readonly responseFormat?: string
  readonly history: AgentHistory
  readonly toolDescriptions?: string
  readonly historyLimit: number
  readonly resolveName: (senderId: string) => string
  readonly getRoomTodos?: (roomId: string) => ReadonlyArray<TodoItem>
  readonly getCompressedIds?: (roomId: string) => ReadonlySet<string>  // NEW (V2)
}
```

### Room interface additions (V2)
```typescript
readonly getCompressedIds: () => ReadonlySet<string>   // NEW getter
```

---

## inReplyTo LLM Rendering

In `formatMessage()`, when `msg.inReplyTo` is present, resolve each referenced ID to a sender name and prepend attribution:

```
[NEW] [Analyst → Michael, Alice]: The transformer load data shows...
```

Resolution function (rooms only — no DM history exists after Phase 1):

```typescript
type ResolvedRef =
  | { type: 'found'; senderName: string }
  | { type: 'compressed' }
  | { type: 'unknown' }

// Called at format time — deps.history.rooms has all room histories
const resolveRef = (
  id: string,
  triggerRoomCtx: RoomContext,
  allRooms: Map<string, RoomContext>,
  compressedIds?: ReadonlySet<string>,  // V2: fetched from BuildContextDeps.getCompressedIds
): ResolvedRef => {
  // 1. Trigger room (most common)
  const inTrigger = triggerRoomCtx.history.find(m => m.id === id)
  if (inTrigger) return { type: 'found', senderName: inTrigger.senderName ?? inTrigger.senderId }

  // 2. Other rooms (cross-context reference)
  for (const [, ctx] of allRooms) {
    const found = ctx.history.find(m => m.id === id)
    if (found) return { type: 'found', senderName: found.senderName ?? found.senderId }
  }

  // 3. Tombstone (V2 — compressedIds provided via BuildContextDeps getter)
  if (compressedIds?.has(id)) return { type: 'compressed' }

  return { type: 'unknown' }
}
```

Rendered output:
- `found` → `[Analyst → Michael, Alice]:`
- `compressed` → `[Analyst → (summarised earlier)]:`
- `unknown` → `[Analyst → (ref: unknown)]:`

Note: system messages (join summaries) may appear in `inReplyTo` with `senderName = undefined` and `senderId = 'system'` → renders as `[Analyst → system]`. This is technically correct but could be filtered if noise. Acceptable for V1.

---

## Tombstone Infrastructure (V2) — Revised Design

**Room-level** (no change from first plan):
- `compressedIds: Set<string>` internal state in Room
- On splice: collect dropped IDs → add to `compressedIds` → post `room_summary` landmark (factual text, non-deliverable, serves as visible history seam) → splice
- `room.getCompressedIds(): ReadonlySet<string>` new getter

**Agent-level** — **[CHANGE from first plan]**: No message-based propagation. No `RoomContext.compressedIds`. Instead:
- `BuildContextDeps.getCompressedIds?: (roomId: string) => ReadonlySet<string>` — wired in `spawn.ts` via `house.getRoom(roomId)?.getCompressedIds() ?? new Set()`
- `resolveRef()` receives compressedIds fetched at context-build time

**Persistence**:
- `RoomSnapshot.compressedIds?: ReadonlyArray<string>` — serialized alongside messages
- `RoomRestoreParams.compressedIds?: ReadonlyArray<string>` — passed to `restoreState()`
- `restoreState()` repopulates the `compressedIds` Set
- `RoomState.compressedIds` in WS snapshot (for reconnecting clients)

The `room_summary` landmark message serves only as a human-visible history seam. Agents do not parse it. The live compressedIds set on the Room object is the source of truth.

---

## Implementation Phases

---

### Phase 1 — DM Removal

**Scope**: Remove all DM infrastructure. Establish clean foundation for Phases 2–4.
**Net change**: ~-180 lines across 10 files. Zero new code.
**Tests to delete**: 5 DM tests in `integration.test.ts`.

#### `src/core/types.ts`
- Remove `DMContext` interface
- Remove `readonly recipientId?: string` from `Message`
- Change `readonly roomId?: string` → `readonly roomId: string` on `Message` **[CHANGE]**
- Update `PostParams` Omit: remove `recipientId` from Omit list (it no longer exists on `Message`)
- Remove `agents?: ReadonlyArray<string>` from `MessageTarget`; make `rooms` required
- Remove `dms: Map<string, DMContext>` from `AgentHistory`
- Remove `readonly query: (question: string, askerId: string, askerName?: string) => Promise<string>` from `AIAgent`
- Remove `team` and `deliver` from `RouterDeps` **[CHANGE: deliver also removed]**

#### `src/core/delivery.ts`
- Remove `target.agents` DM branch (all DM construction code)
- Remove `team` and `deliver` from `RouterDeps` destructuring
- `createMessageRouter` now takes `{ house: House }` only
- Remove `deliver(recipient.id, dmMessage)` and `deliver(params.senderId, dmMessage)` calls

#### `src/agents/context-builder.ts`
- Delete `triggerKey()` function entirely **[note: update all callers in ai-agent.ts too]**
- Change `buildContext(deps, triggerRoomId?: string, triggerPeerId?: string)` → `buildContext(deps, triggerRoomId: string)`
- Remove `if (triggerPeerId)` DM context section in `buildContext()`
- Simplify room history section: `triggerRoomId` is always defined, remove optional guard
- Change `FlushInfo`: remove `dmMessages`, make `triggerRoomId: string` required, remove `triggerPeerId`
- Update `flushIncoming()`: remove `info.triggerPeerId` DM-flush branch; simplify to always flush to `info.triggerRoomId`
- Remove DM loop from `buildActivitySection()`
- Remove `else if (triggerPeerId)` branch from `buildSystemMessage()`
- Remove `DMContext` import

#### `src/agents/evaluation.ts`
- Remove `triggerPeerId?: string` from `evaluate()` parameters
- Remove `triggerPeerId` from `Decision` interface (make `triggerRoomId` required)
- Remove `triggerPeerId` from all `makeResult()` calls

#### `src/agents/ai-agent.ts`
- Delete `query()` method
- Simplify `receive()`:
  ```typescript
  const receive = (message: Message): void => {
    extractProfile(message, agentId, agentHistory.agentProfiles)
    if (message.senderId === agentId) {
      const ctx = agentHistory.rooms.get(message.roomId)
      if (ctx) ctx.history = [...ctx.history, message]
      return
    }
    agentHistory.incoming.push(message)
    if (message.type === 'system' || message.type === 'leave' || message.type === 'pass') return
    tryEvaluate(message.roomId)
  }
  ```
- Change `tryEvaluate(triggerRoomId?: string, triggerPeerId?: string)` → `tryEvaluate(triggerRoomId: string)`
- Remove `const key = triggerKey(...)` — use `triggerRoomId` directly as the concurrency key **[CHANGE: triggerKey deleted]**
- Remove `agentHistory.dms` field initialisation
- Remove `query` from returned interface
- Remove `DMContext` and related imports

#### `src/agents/spawn.ts`
- Simplify `resolveTarget()`:
  ```typescript
  const resolveTarget = (decision: Decision): MessageTarget => ({
    rooms: [decision.triggerRoomId]
  })
  ```
  Remove null return + error log (triggerRoomId is now always present)
- Remove `triggerPeerId` handling in `onDecision`

#### `src/agents/concurrency.ts`
- Remove `queryCount` variable
- Remove `isQuerying()`, `startQuery()`, `endQuery()` from interface and implementation
- Simplify `checkIdle()`: remove `queryCount === 0` check
- Simplify `whenIdle()`: remove `queryCount === 0` check

#### `src/main.ts`
- Remove `createQueryAgentTool` and `createDelegateTool` from imports and `toolRegistry.registerAll()`
- Change `createMessageRouter({ house, team, deliver })` → `createMessageRouter({ house })`

#### `src/agents/integration.test.ts`
- Delete 5 DM tests listed above

---

### Phase 2 — Tool Removal

**Scope**: Remove `query_agent` and `delegate` tools and their registration.
**Net change**: ~-130 lines, 2 files.
**Tests to delete**: 3 query tests in `ai-agent.test.ts`.

#### `src/tools/built-in/agent-tools.ts`
- Delete `createQueryAgentTool()` function
- Delete `createDelegateTool()` function
- Update `createListAgentsTool()` description: remove "Check here before using `query_agent` or `add_to_room`" → "Check here before using `add_to_room` or addressing agents with [[AgentName]]."

#### `src/tools/built-in/index.ts` (or wherever tools are re-exported)
- Remove exports for `createQueryAgentTool`, `createDelegateTool`

Note: `main.ts` registration was already removed in Phase 1.

#### `src/agents/ai-agent.test.ts`
- Delete 3 query tests listed above

---

### Phase 3 — inReplyTo Stamping + LLM Rendering

**Scope**: Stamp causal parents onto every AI-generated message. Render attribution in LLM context.
**Net change**: ~+55 lines, 5 files.

#### `src/core/types.ts`
- Add `readonly inReplyTo?: ReadonlyArray<string>` to `Message`
- Add `readonly inReplyTo?: ReadonlyArray<string>` to `Decision`
- Update the FRAGILITY comment on `PostParams` to note that `inReplyTo` flows through automatically and this is intentional

#### `src/agents/ai-agent.ts`
- In `tryEvaluate`, after `evaluate()` returns and before calling `flushIncoming`:
  ```typescript
  const stampedDecision: Decision = { ...decision, inReplyTo: [...flushInfo.ids] }
  flushIncoming(flushInfo, agentHistory, agentId)
  onDecision(stampedDecision)
  ```
  Apply to both `respond` and `pass` branches (pass is a conscious evaluation — causal parents apply equally).

#### `src/agents/spawn.ts`
- In `onDecision`, thread `inReplyTo` through to `routeMessage`:
  ```typescript
  routeMessage(
    { rooms: [decision.triggerRoomId] },
    {
      senderId: agent.id,
      senderName: agent.name,
      content: decision.response.content,
      type: 'chat',
      generationMs: decision.generationMs,
      inReplyTo: decision.inReplyTo,     // NEW
    }
  )
  ```
  Same for `pass` responses.

#### `src/core/room.ts`
- Add `inReplyTo: params.inReplyTo` to `createRoomMessage()`:
  ```typescript
  const createRoomMessage = (params: PostParams): Message => ({
    // ... existing fields ...
    inReplyTo: params.inReplyTo,   // NEW
  })
  ```
  No other changes — PostParams already carries `inReplyTo` since it derives from Message.

#### `src/agents/context-builder.ts`
- Add `resolveRef()` function (as designed above, V1 version — `compressedIds` parameter defaults to undefined, `compressed` branch unreachable until V2)
- Update `formatMessage()` to prepend `[Sender → Name1, Name2]:` when `msg.inReplyTo` is non-empty:
  ```typescript
  const inReplyTo = msg.inReplyTo
  if (inReplyTo && inReplyTo.length > 0) {
    const names = inReplyTo
      .map(id => resolveRef(id, triggerRoomCtx, allRooms))
      .filter(r => r.type === 'found')
      .map(r => (r as { type: 'found'; senderName: string }).senderName)
    // ... prepend [name1, name2] attribution
  }
  ```
  `formatMessage()` needs access to `triggerRoomCtx` and `allRooms` — add these as parameters, or pass them via a closure in `buildContext()`. The closure approach avoids changing the signature of the public `formatMessage` export. **Recommendation**: use an internal `formatMessageWithRefs()` inside `buildContext()` that closes over the room contexts. Keep the existing public `formatMessage()` signature unchanged for test compatibility.

No snapshot format change. No migration needed.

---

### Phase 4 — Tombstone Infrastructure

**Scope**: Make room compression safe for `inReplyTo` references.
**Net change**: ~+80 lines, 6 files.

#### `src/core/types.ts`
- Add `readonly compressedIds?: ReadonlyArray<string>` to `RoomState`
- Add `readonly compressedIds?: ReadonlyArray<string>` to `RoomRestoreParams`
- Add `readonly getCompressedIds?: (roomId: string) => ReadonlySet<string>` to `BuildContextDeps` **[CHANGE: was RoomContext field in first plan]**

#### `src/core/room.ts`
- Add `compressedIds: Set<string>` to internal Room state
- Replace silent splice with tombstone-aware compression:
  ```typescript
  if (messages.length > messageLimit) {
    const overBy = messages.length - messageLimit
    const dropped = messages.slice(0, overBy).map(m => m.id)
    for (const id of dropped) compressedIds.add(id)
    const oldest = messages[0]!
    const newest = messages[overBy - 1]!
    messages.splice(0, overBy)
    // Post a non-deliverable landmark (visible seam in history for humans)
    const landmark: Message = {
      id: crypto.randomUUID(),
      roomId: profile.id,
      senderId: SYSTEM_SENDER_ID,
      content: `${overBy} messages archived (${new Date(oldest.timestamp).toISOString()} – ${new Date(newest.timestamp).toISOString()})`,
      timestamp: Date.now(),
      type: 'room_summary',
      metadata: { compressedIds: dropped },
    }
    messages.unshift(landmark)   // insert at start so it appears at the seam
  }
  ```
- Add `getCompressedIds: () => new Set(compressedIds)` to Room interface and return
- Update `getRoomState()` to include `compressedIds: [...compressedIds]` when non-empty
- Update `restoreState()` to accept and repopulate `compressedIds`

#### `src/core/snapshot.ts`
- Add `readonly compressedIds?: ReadonlyArray<string>` to `RoomSnapshot`
- In `serializeSystem()`: include `compressedIds: [...room.getCompressedIds()]` (or omit when empty)
- In `restoreFromSnapshot()`: pass `compressedIds: roomSnap.compressedIds ?? []` to `restoreState()`

#### `src/agents/spawn.ts`
- Wire `getCompressedIds` in `createAIAgent` options:
  ```typescript
  getCompressedIds: (roomId: string) => house.getRoom(roomId)?.getCompressedIds() ?? new Set()
  ```

#### `src/agents/context-builder.ts`
- Update `resolveRef()` to use `deps.getCompressedIds?.(triggerRoomId)` — passes to the function at call time
- **[CHANGE from first plan]**: `resolveRef` does not read from `RoomContext.compressedIds` — reads from the live room getter via `BuildContextDeps`

#### `src/api/ws-handler.ts`
- `compressedIds` flows automatically via `room.getRoomState()` → `buildSnapshot()` — no additional change needed

#### Room interface (`src/core/types.ts` Room interface)
- Add `readonly getCompressedIds: () => ReadonlySet<string>`

---

### Phase 5 — LLM-Quality Compression Summaries (Deferred)

Architecture unchanged from Phase 4. The landmark content improves: an LLM call summarises the dropped batch before splice, result stored as the landmark's `content`. Triggered explicitly (API endpoint or tool call). No structural changes.

---

## Complete File Impact Table

| File | Phases | Direction | Summary |
|---|---|---|---|
| `src/core/types.ts` | 1, 3, 4 | +/- | Remove DMContext, recipientId, dms, AIAgent.query, MessageTarget.agents, RouterDeps.team+deliver; roomId required; add inReplyTo, compressedIds in RoomState+RoomRestoreParams, getCompressedIds in BuildContextDeps |
| `src/core/delivery.ts` | 1 | - | Remove DM branch, team, deliver deps; ~30 lines removed |
| `src/core/room.ts` | 3, 4 | + | Add inReplyTo to createRoomMessage; tombstone compression; getCompressedIds getter |
| `src/core/snapshot.ts` | 4 | + | Add compressedIds to RoomSnapshot; ~8 lines |
| `src/agents/ai-agent.ts` | 1, 3 | - | Remove query(), DM receive branch; stamp inReplyTo in tryEvaluate; ~50 lines net removed |
| `src/agents/context-builder.ts` | 1, 3, 4 | -/+ | Remove DM paths, triggerKey fn, triggerPeerId; add resolveRef(), inReplyTo rendering; getCompressedIds in deps |
| `src/agents/evaluation.ts` | 1 | - | Remove triggerPeerId; required triggerRoomId; ~10 lines |
| `src/agents/spawn.ts` | 1, 3, 4 | -/+ | Simplify resolveTarget; thread inReplyTo; wire getCompressedIds |
| `src/agents/concurrency.ts` | 1 | - | Remove query tracking; ~20 lines removed |
| `src/tools/built-in/agent-tools.ts` | 2 | - | Remove query_agent, delegate; update list_agents description |
| `src/tools/built-in/index.ts` | 2 | - | Remove 2 exports |
| `src/main.ts` | 1, 2 | - | Remove tool registrations; simplify createMessageRouter call |
| `src/agents/ai-agent.test.ts` | 2 | - | Delete 3 query tests |
| `src/agents/integration.test.ts` | 1 | - | Delete 5 DM tests; replace correlationId multi-target test |

---

## Files Not Affected

| File | Reason |
|---|---|
| `src/core/house.ts` | Room management only; no message content |
| `src/core/delivery-modes.ts` | Flow/broadcast logic; untouched |
| `src/core/room-flows.ts` / `room-todos.ts` | Sub-systems unaffected |
| `src/tools/built-in/*.ts` (except agent-tools.ts) | No DM or query dependencies |
| `src/agents/actions.ts` | Already uses `{ rooms: [roomId] }` target; roomId required |
| `src/agents/human-agent.ts` | receive() never processes own messages; no DM logic |
| `src/integrations/mcp/server.ts` | Posts to rooms; inReplyTo included automatically |
| `src/api/http-routes.ts` | Reads messages; inReplyTo included automatically |
| UI | inReplyTo available for threaded rendering; no V1/V2 changes required |

---

## Breaking Changes

### WS API: target.agents removed from post_message

Before: `{ type: 'post_message', target: { agents: ['Analyst'] }, content: '...' }`
After: `target.agents` is no longer valid. Message will silently be posted to zero rooms.

Migration: clients must create a room with the target agent and post to that room. The room can be pre-created at agent spawn time if a persistent 1:1 channel is desired.

---

## Edge Cases and Known Gaps

### join() summaries and inReplyTo
`join()` calls `llmProvider.chat()` directly, bypassing evaluation. The summary does not carry `inReplyTo`. The summary message ID will appear in `inReplyTo` of the agent's first response in the room (because the summary sits in `incoming` when the first evaluation runs). It resolves with `senderName = 'system'`, rendering as `[AgentName → system]`. Cosmetically odd but semantically correct.

### post_to_room tool
Tool-loop messages posted via `post_to_room` are causally unanchored — `ToolContext` doesn't carry `flushInfo.ids`. Fix requires threading inReplyTo through ToolContext; accepted gap for V1.

### correlationId grouping
With single-room routing, correlationId always groups exactly one message. Dead as a grouping mechanism but kept for future multi-room scenarios. Cost is one UUID field per message.

### History window vs. inReplyTo
LLM sees `historyLimit` messages. `inReplyTo` IDs may reference messages outside the current window. The causal graph is system-level; LLM context window is a separate concern. `resolveRef` searches the full unbounded `ctx.history`, not just the historyLimit window.

### compressedIds Set growth
A room with 10,000 lifetime messages at a 500-message cap accumulates ~9,500 IDs in the compressedIds set. Manageable for now. Future: pruning policy (discard IDs older than N days).

### landmark message splice position
The compression landmark is `messages.unshift()`-ed to the start of the post-splice array, not appended. This places it at the seam where old messages were dropped, which is the natural position for humans reading history.
