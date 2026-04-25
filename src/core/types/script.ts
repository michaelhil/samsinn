// ============================================================================
// Script types — multi-agent improvisational drama.
//
// Authoring surface:
//   - Script: cast (one entry per character) + acts glossary + scenes.
//   - Scene:  setup paragraph, present cast, per-character objectives.
//   - Objective: free-text `want` + structural `signal`.
//   - Signal: composable predicate over speech-acts and status transitions.
//
// Run state lives in ScriptRun and is updated by src/core/script-runs.ts (pure
// functions) and src/core/script-engine.ts (the driver loop).
//
// See docs/scripts.md for the full design.
// ============================================================================

import type { AIAgentConfig } from './agent.ts'

// === Speech-act glossary entry ===

export interface SpeechActDef {
  readonly name: string         // identifier the LLM declares; arbitrary string
  readonly description: string  // one-line gloss for the LLM and the author
}

// === Cast member ===

export type CastKind = 'ai' | 'human'

export interface CastMember {
  readonly name: string                 // display name (within the script)
  readonly kind: CastKind
  // Required when kind === 'ai'. The persona and tools used for this character.
  // Spawned per-room with a scoped agent id (`script::{roomId}::{name}`).
  readonly agentConfig?: AIAgentConfig
  // Optional. When kind === 'human' and a binding is desired, the script
  // engine resolves this to an existing human agent in the room. Empty / unset
  // means "any human in the room can play the part" (single-human rooms).
  readonly humanAgentName?: string
}

// === Signals ===

export type Signal =
  | { readonly acts: Readonly<Record<string, ReadonlyArray<string>>> }
  | { readonly status: Readonly<Record<string, 'met' | 'abandoned'>> }
  | { readonly any_of: ReadonlyArray<Signal> }

// === Objectives ===

export interface Objective {
  readonly want: string         // free-text pursuit shown to the character
  readonly signal: Signal       // structural success criterion
}

// === Scenes ===

export interface Scene {
  readonly setup: string                              // narration injected privately to each entering character
  readonly present: ReadonlyArray<string>             // cast names present in this scene
  readonly objectives: Readonly<Record<string, Objective>>  // keyed by cast name
}

// === Top-level script ===

export interface Script {
  readonly id: string                                 // crypto.randomUUID() at load
  readonly name: string                               // unique within the store
  readonly acts: Readonly<Record<string, SpeechActDef>>
  readonly cast: ReadonlyArray<CastMember>
  readonly scenes: ReadonlyArray<Scene>
}

// === Run state ===

export type BeatStatus = 'pursuing' | 'met' | 'abandoned'
export type BeatIntent = 'speak' | 'hold'

// One BeatRecord per call to `update_beat`. Phase-1 calls have no speech_acts;
// phase-2 calls (the elected speaker) declare them.
export interface BeatRecord {
  readonly turn: number
  readonly character: string                          // cast name
  readonly status: BeatStatus
  readonly intent: BeatIntent
  readonly addressedTo?: string                       // cast name
  readonly mood?: string                              // one-word peer-visible tag
  readonly speechActs?: ReadonlyArray<string>         // glossary names; phase-2 only
}

export type SceneOutcome = 'resolved' | 'fizzled'

export interface ScriptRun {
  readonly script: Script
  readonly roomId: string
  sceneIndex: number
  turn: number
  // Per-scene state. Reset on advance.
  beats: BeatRecord[]
  statuses: Record<string, BeatStatus>                // keyed by cast name; 'pursuing' default
  stallStreak: number
  // Outcome of the most recently resolved/fizzled scene; cleared at scene advance.
  lastOutcome?: SceneOutcome
  // Set when the entire script ends. The engine emits script_completed and
  // tears down spawned cast agents.
  ended?: boolean
}

// === Wire-level events for UI ===

export interface ScriptEvent {
  readonly script_started: { readonly scriptId: string; readonly scriptName: string }
  readonly script_scene_advanced: { readonly scriptId: string; readonly sceneIndex: number; readonly setup: string }
  readonly script_beat: { readonly scriptId: string; readonly beat: BeatRecord }
  readonly script_completed: { readonly scriptId: string; readonly outcomes: ReadonlyArray<SceneOutcome> }
}

export type ScriptEventName = keyof ScriptEvent
export type ScriptEventDetail<E extends ScriptEventName = ScriptEventName> = ScriptEvent[E]
