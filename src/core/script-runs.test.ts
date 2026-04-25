import { describe, test, expect } from 'bun:test'
import {
  evaluateSignal,
  selectSpeaker,
  detectStall,
  isSceneResolved,
  createScriptRun,
  evaluateSignals,
  applySelfStatus,
  recordBeat,
  advanceScene,
} from './script-runs.ts'
import type { BeatRecord, Script, Signal } from './types/script.ts'

const mkBeat = (overrides: Partial<BeatRecord> & Pick<BeatRecord, 'character'>): BeatRecord => ({
  turn: 0,
  status: 'pursuing',
  intent: 'hold',
  ...overrides,
})

const mkScript = (): Script => ({
  id: 'script-1',
  name: 'test',
  acts: {
    confess:     { name: 'confess',     description: 'admit' },
    deflect:     { name: 'deflect',     description: 'avoid' },
    acknowledge: { name: 'acknowledge', description: 'recognise' },
  },
  cast: [
    { name: 'Anna', kind: 'ai', agentConfig: { name: 'Anna', model: 'm', persona: 'p' } },
    { name: 'Bob',  kind: 'ai', agentConfig: { name: 'Bob',  model: 'm', persona: 'p' } },
  ],
  scenes: [
    {
      setup: 'Anna and Bob, evening.',
      present: ['Anna', 'Bob'],
      objectives: {
        Anna: { want: 'get Bob to confess', signal: { acts: { Bob: ['confess', 'acknowledge'] } } },
        Bob:  {
          want: 'avoid confessing',
          signal: { any_of: [{ status: { Anna: 'abandoned' } }, { acts: { Bob: ['confess'] } }] },
        },
      },
    },
    {
      setup: 'A year later.',
      present: ['Anna'],
      objectives: { Anna: { want: 'find peace', signal: { acts: { Anna: ['acknowledge'] } } } },
    },
  ],
})

describe('evaluateSignal', () => {
  test('acts: matches when ANY required act was declared by the named character', () => {
    const sig: Signal = { acts: { Bob: ['confess', 'acknowledge'] } }
    expect(evaluateSignal(sig, [mkBeat({ character: 'Bob', speechActs: ['acknowledge'] })], {})).toBe(true)
    expect(evaluateSignal(sig, [mkBeat({ character: 'Bob', speechActs: ['deflect'] })], {})).toBe(false)
  })

  test('status: matches when the named character has the required status', () => {
    const sig: Signal = { status: { Anna: 'abandoned' } }
    expect(evaluateSignal(sig, [], { Anna: 'abandoned' })).toBe(true)
    expect(evaluateSignal(sig, [], { Anna: 'pursuing' })).toBe(false)
  })

  test('any_of: matches when at least one branch matches', () => {
    const sig: Signal = { any_of: [{ acts: { Bob: ['confess'] } }, { status: { Anna: 'abandoned' } }] }
    expect(evaluateSignal(sig, [], { Anna: 'abandoned' })).toBe(true)
    expect(evaluateSignal(sig, [mkBeat({ character: 'Bob', speechActs: ['confess'] })], {})).toBe(true)
    expect(evaluateSignal(sig, [], {})).toBe(false)
  })
})

describe('selectSpeaker', () => {
  test('addressee with intent: speak takes the floor', () => {
    const got = selectSpeaker({
      present: ['Anna', 'Bob'],
      intentions: { Anna: 'speak', Bob: 'speak' },
      addressedFromLastTurn: 'Bob',
      lastSpokeTurn: { Anna: 5, Bob: 1 },
    })
    expect(got).toBe('Bob')
  })

  test('addressee that holds → fall through to longest-quiet', () => {
    const got = selectSpeaker({
      present: ['Anna', 'Bob'],
      intentions: { Anna: 'speak', Bob: 'hold' },
      addressedFromLastTurn: 'Bob',
      lastSpokeTurn: { Anna: 5, Bob: 1 },
    })
    expect(got).toBe('Anna')
  })

  test('cold start: tied lastSpokeTurn → cast-order tiebreak', () => {
    const got = selectSpeaker({
      present: ['Anna', 'Bob'],
      intentions: { Anna: 'speak', Bob: 'speak' },
      lastSpokeTurn: {},
    })
    expect(got).toBe('Anna')
  })

  test('no bidder → undefined', () => {
    const got = selectSpeaker({
      present: ['Anna', 'Bob'],
      intentions: { Anna: 'hold', Bob: 'hold' },
      lastSpokeTurn: {},
    })
    expect(got).toBeUndefined()
  })
})

describe('detectStall', () => {
  test('false when recent movement', () => {
    expect(detectStall({ statusTransitionTurns: [3], speechActTurns: [4], currentTurn: 5 }, 3)).toBe(false)
  })
  test('true when threshold exceeded', () => {
    expect(detectStall({ statusTransitionTurns: [1], speechActTurns: [2], currentTurn: 6 }, 3)).toBe(true)
  })
  test('cold (no movement) hits stall once threshold reached', () => {
    expect(detectStall({ statusTransitionTurns: [], speechActTurns: [], currentTurn: 3 }, 3)).toBe(true)
    expect(detectStall({ statusTransitionTurns: [], speechActTurns: [], currentTurn: 2 }, 3)).toBe(false)
  })
})

describe('isSceneResolved', () => {
  test('true when every present character is met or abandoned', () => {
    expect(isSceneResolved(['Anna', 'Bob'], { Anna: 'met', Bob: 'abandoned' })).toBe(true)
  })
  test('false when any character is still pursuing', () => {
    expect(isSceneResolved(['Anna', 'Bob'], { Anna: 'met', Bob: 'pursuing' })).toBe(false)
  })
})

describe('engine integration via run helpers', () => {
  test('full happy path: Bob confesses → both met → scene resolves → advance', () => {
    const run = createScriptRun(mkScript(), 'room-1')
    expect(run.sceneIndex).toBe(0)
    expect(run.statuses).toEqual({ Anna: 'pursuing', Bob: 'pursuing' })

    // Bob speaks and declares confess
    recordBeat(run, mkBeat({ turn: 1, character: 'Bob', intent: 'speak', speechActs: ['confess'] }))

    // Re-evaluate signals: Anna's signal fires (Bob confessed); Bob's any_of branch fires too
    const promoted = evaluateSignals(run)
    expect([...promoted].sort()).toEqual(['Anna', 'Bob'])
    expect(isSceneResolved(['Anna', 'Bob'], run.statuses)).toBe(true)

    const next = advanceScene(run, 'resolved')
    expect(next).toBe(1)
    expect(run.lastOutcome).toBe('resolved')
    expect(run.statuses).toEqual({ Anna: 'pursuing' })
  })

  test('self-marking abandoned is sticky and does not get reverted', () => {
    const run = createScriptRun(mkScript(), 'room-1')
    applySelfStatus(run, mkBeat({ character: 'Anna', status: 'abandoned' }))
    expect(run.statuses.Anna).toBe('abandoned')

    // A later evaluateSignals must not flip it back
    recordBeat(run, mkBeat({ character: 'Bob', speechActs: ['confess'] }))
    evaluateSignals(run)
    expect(run.statuses.Anna).toBe('abandoned')   // sticky
    expect(run.statuses.Bob).toBe('met')          // his any_of fires on his own confess
  })

  test('script ends after final scene', () => {
    const run = createScriptRun(mkScript(), 'room-1')
    advanceScene(run, 'resolved')   // → scene 1
    const next = advanceScene(run, 'resolved')   // → ended
    expect(next).toBeUndefined()
    expect(run.ended).toBe(true)
  })
})
