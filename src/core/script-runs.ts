// ============================================================================
// Script run state — pure functions over ScriptRun.
//
// All scene-engine decisions live here as pure, deterministic functions:
//   - evaluateSignal:  match a Signal against the per-scene beats + statuses
//   - selectSpeaker:   pick the next speaker by addressee → longest-quiet → cast-order tiebreak
//   - detectStall:     turns since the last status transition or speech-act
//   - isSceneResolved: every present character is met or abandoned
//
// The driver loop in script-engine.ts mutates ScriptRun via the helpers below
// (advanceTurn, recordBeat, advanceScene). Run state initialisation is also
// here so script-engine has no direct constructor.
// ============================================================================

import type {
  BeatRecord,
  BeatStatus,
  Scene,
  Script,
  ScriptRun,
  Signal,
} from './types/script.ts'

// === Construction ===

export const createScriptRun = (script: Script, roomId: string): ScriptRun => {
  const first = script.scenes[0]
  if (!first) throw new Error(`Script "${script.name}" has no scenes`)
  return {
    script,
    roomId,
    sceneIndex: 0,
    turn: 0,
    beats: [],
    statuses: initialStatuses(first),
    stallStreak: 0,
  }
}

const initialStatuses = (scene: Scene): Record<string, BeatStatus> => {
  const out: Record<string, BeatStatus> = {}
  for (const name of scene.present) out[name] = 'pursuing'
  return out
}

// === Signal evaluation ===

const declaredActsByCharacter = (beats: ReadonlyArray<BeatRecord>): Record<string, Set<string>> => {
  const out: Record<string, Set<string>> = {}
  for (const b of beats) {
    if (!b.speechActs || b.speechActs.length === 0) continue
    const set = out[b.character] ?? new Set<string>()
    for (const act of b.speechActs) set.add(act)
    out[b.character] = set
  }
  return out
}

export const evaluateSignal = (
  signal: Signal,
  beats: ReadonlyArray<BeatRecord>,
  statuses: Readonly<Record<string, BeatStatus>>,
): boolean => {
  if ('any_of' in signal) {
    return signal.any_of.some(s => evaluateSignal(s, beats, statuses))
  }

  if ('acts' in signal) {
    const declared = declaredActsByCharacter(beats)
    for (const [character, required] of Object.entries(signal.acts)) {
      const set = declared[character]
      if (!set) return false
      // ANY of the required acts matches (per-character disjunction)
      const ok = required.some(act => set.has(act))
      if (!ok) return false
    }
    return true
  }

  // 'status' in signal
  for (const [character, required] of Object.entries(signal.status)) {
    if (statuses[character] !== required) return false
  }
  return true
}

// === Speaker selection ===

export interface SelectionContext {
  readonly present: ReadonlyArray<string>     // cast names in this scene, in cast-order
  readonly intentions: Readonly<Record<string, 'speak' | 'hold'>>
  readonly addressedFromLastTurn?: string     // cast name
  readonly lastSpokeTurn: Readonly<Record<string, number>>  // cast name → turn index
}

export const selectSpeaker = (ctx: SelectionContext): string | undefined => {
  // 1. Last-turn addressee, if they bid speak
  const a = ctx.addressedFromLastTurn
  if (a && ctx.present.includes(a) && ctx.intentions[a] === 'speak') return a

  // 2. Longest-quiet bidder. Ties broken by cast-order (alphabetical of definition).
  const candidates = ctx.present.filter(n => ctx.intentions[n] === 'speak')
  if (candidates.length === 0) return undefined

  // Sort by ascending lastSpokeTurn (Infinity for never-spoken), then by
  // their position in the present list (the cast-order tiebreak).
  const ranked = [...candidates].sort((a, b) => {
    const ta = ctx.lastSpokeTurn[a] ?? -1
    const tb = ctx.lastSpokeTurn[b] ?? -1
    if (ta !== tb) return ta - tb
    return ctx.present.indexOf(a) - ctx.present.indexOf(b)
  })
  return ranked[0]
}

// === Stall detection ===

export interface StallInputs {
  // Turns at which a status transition occurred (any character → met/abandoned).
  readonly statusTransitionTurns: ReadonlyArray<number>
  // Turns at which any speech-act was declared.
  readonly speechActTurns: ReadonlyArray<number>
  readonly currentTurn: number
}

// True when at least `threshold` turns have passed without movement.
export const detectStall = (inputs: StallInputs, threshold: number): boolean => {
  // Scene starts at turn 0; treat scene-start as the implicit baseline so a
  // cold-start scene of N turns (zero movement) hits stall at turn N == threshold.
  const lastTransition = inputs.statusTransitionTurns.length > 0
    ? inputs.statusTransitionTurns[inputs.statusTransitionTurns.length - 1]!
    : 0
  const lastAct = inputs.speechActTurns.length > 0
    ? inputs.speechActTurns[inputs.speechActTurns.length - 1]!
    : 0
  const lastMovement = Math.max(lastTransition, lastAct)
  return inputs.currentTurn - lastMovement >= threshold
}

// === Resolution ===

export const isSceneResolved = (
  present: ReadonlyArray<string>,
  statuses: Readonly<Record<string, BeatStatus>>,
): boolean => present.every(n => {
  const s = statuses[n]
  return s === 'met' || s === 'abandoned'
})

// === Mutators (used by script-engine) ===

// Apply a beat to the run. Returns the post-mutation run. Status transitions
// are NOT applied here — the engine evaluates signals after each phase-2 turn
// and calls applyStatus separately. This keeps phase-1 react beats trivially
// pure for state.
export const recordBeat = (run: ScriptRun, beat: BeatRecord): void => {
  run.beats.push(beat)
}

// Apply explicit status changes from the latest beat (a character may
// self-mark abandoned via update_beat).
export const applySelfStatus = (run: ScriptRun, beat: BeatRecord): boolean => {
  const prev = run.statuses[beat.character]
  if (prev === beat.status) return false
  if (prev === 'met' || prev === 'abandoned') return false  // sticky
  run.statuses[beat.character] = beat.status
  return beat.status !== 'pursuing'
}

// Re-evaluate every present character's signal against the current beats +
// statuses; promote 'pursuing' → 'met' where signal fires. Returns the names
// promoted (for the engine to broadcast / log).
export const evaluateSignals = (run: ScriptRun): ReadonlyArray<string> => {
  const scene = run.script.scenes[run.sceneIndex]!
  const promoted: string[] = []
  for (const name of scene.present) {
    if (run.statuses[name] !== 'pursuing') continue
    const obj = scene.objectives[name]
    if (!obj) continue
    if (evaluateSignal(obj.signal, run.beats, run.statuses)) {
      run.statuses[name] = 'met'
      promoted.push(name)
    }
  }
  return promoted
}

// Move to the next scene or end the script. Returns the new sceneIndex or
// undefined if the script has ended.
export const advanceScene = (run: ScriptRun, outcome: 'resolved' | 'fizzled'): number | undefined => {
  run.lastOutcome = outcome
  const next = run.sceneIndex + 1
  if (next >= run.script.scenes.length) {
    run.ended = true
    return undefined
  }
  run.sceneIndex = next
  run.turn = 0
  run.beats = []
  run.statuses = initialStatuses(run.script.scenes[next]!)
  run.stallStreak = 0
  return next
}
