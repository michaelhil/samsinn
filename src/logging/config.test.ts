import { describe, test, expect } from 'bun:test'
import { matchesKindFilter, parseLogConfigFromEnv, validateLogConfig } from './config.ts'

describe('matchesKindFilter', () => {
  test('* matches everything', () => {
    expect(matchesKindFilter('message.posted', ['*'])).toBe(true)
    expect(matchesKindFilter('any.weird.kind', ['*'])).toBe(true)
  })

  test('exact match', () => {
    expect(matchesKindFilter('message.posted', ['message.posted'])).toBe(true)
    expect(matchesKindFilter('message.deleted', ['message.posted'])).toBe(false)
  })

  test('prefix glob', () => {
    expect(matchesKindFilter('message.posted', ['message.*'])).toBe(true)
    expect(matchesKindFilter('message.deleted', ['message.*'])).toBe(true)
    expect(matchesKindFilter('room.created', ['message.*'])).toBe(false)
  })

  test('union of multiple patterns', () => {
    const patterns = ['message.*', 'room.created']
    expect(matchesKindFilter('message.posted', patterns)).toBe(true)
    expect(matchesKindFilter('room.created', patterns)).toBe(true)
    expect(matchesKindFilter('room.deleted', patterns)).toBe(false)
  })

  test('empty pattern list matches nothing', () => {
    expect(matchesKindFilter('anything', [])).toBe(false)
  })
})

describe('parseLogConfigFromEnv', () => {
  test('defaults when unset → disabled + defaults', () => {
    const c = parseLogConfigFromEnv({})
    expect(c.enabled).toBe(false)
    expect(c.dir).toMatch(/\.samsinn\/logs$/)
    expect(c.sessionId).toMatch(/^session-\d+-[a-f0-9]{8}$/)
    expect(c.kinds).toEqual(['*'])
  })

  test('reads SAMSINN_LOG_ENABLED=1', () => {
    const c = parseLogConfigFromEnv({ SAMSINN_LOG_ENABLED: '1' })
    expect(c.enabled).toBe(true)
  })

  test('any other value → disabled', () => {
    expect(parseLogConfigFromEnv({ SAMSINN_LOG_ENABLED: 'yes' }).enabled).toBe(false)
    expect(parseLogConfigFromEnv({ SAMSINN_LOG_ENABLED: '0' }).enabled).toBe(false)
    expect(parseLogConfigFromEnv({ SAMSINN_LOG_ENABLED: 'true' }).enabled).toBe(false)
  })

  test('SAMSINN_LOG_DIR overrides default', () => {
    const c = parseLogConfigFromEnv({ SAMSINN_LOG_DIR: '/tmp/custom-logs' })
    expect(c.dir).toBe('/tmp/custom-logs')
  })

  test('SAMSINN_SESSION_ID overrides default', () => {
    const c = parseLogConfigFromEnv({ SAMSINN_SESSION_ID: 'study-A-operator-1' })
    expect(c.sessionId).toBe('study-A-operator-1')
  })

  test('SAMSINN_LOG_KINDS comma-splits + trims', () => {
    const c = parseLogConfigFromEnv({ SAMSINN_LOG_KINDS: ' message.* , tool.* ' })
    expect(c.kinds).toEqual(['message.*', 'tool.*'])
  })
})

describe('validateLogConfig', () => {
  test('accepts a minimal valid config', () => {
    expect(() => validateLogConfig({ enabled: true, dir: '/tmp/x', sessionId: 'abc', kinds: ['*'] })).not.toThrow()
  })

  test('rejects non-boolean enabled', () => {
    expect(() => validateLogConfig({ enabled: 'yes' as unknown as boolean })).toThrow('enabled')
  })

  test('rejects empty dir', () => {
    expect(() => validateLogConfig({ dir: '' })).toThrow('dir')
  })

  test('rejects invalid sessionId chars', () => {
    expect(() => validateLogConfig({ sessionId: 'has/slash' })).toThrow('sessionId')
    expect(() => validateLogConfig({ sessionId: 'has space' })).toThrow('sessionId')
  })

  test('accepts session ids with dots, dashes, underscores', () => {
    expect(() => validateLogConfig({ sessionId: 'study.A_operator-1' })).not.toThrow()
  })

  test('rejects non-array kinds', () => {
    expect(() => validateLogConfig({ kinds: 'message.*' as unknown as string[] })).toThrow('kinds')
  })
})
