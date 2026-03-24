import { describe, test, expect } from 'bun:test'
import { createRoom } from './room.ts'
import type { Message, RoomProfile } from './types.ts'
import { SYSTEM_SENDER_ID } from './types.ts'

const makeProfile = (overrides?: Partial<RoomProfile>): RoomProfile => ({
  id: 'test-room',
  name: 'Test Room',
  visibility: 'public',
  createdBy: 'creator-1',
  createdAt: Date.now(),
  ...overrides,
})

describe('Room — self-contained component', () => {
  test('starts with zero messages and no participants', () => {
    const room = createRoom(makeProfile())
    expect(room.getMessageCount()).toBe(0)
    expect(room.getParticipantIds()).toEqual([])
    expect(room.getRecent(10)).toEqual([])
  })

  test('post appends message with auto-generated id, timestamp, and roomId', () => {
    const room = createRoom(makeProfile({ id: 'my-room' }))
    const message = room.post({
      senderId: 'alice',
      content: 'Hello',
      type: 'chat',
    })

    expect(message.id).toBeTruthy()
    expect(message.timestamp).toBeGreaterThan(0)
    expect(message.roomId).toBe('my-room') // room stamps its own ID
    expect(message.content).toBe('Hello')
    expect(message.senderId).toBe('alice')
    expect(message.type).toBe('chat')
    expect(room.getMessageCount()).toBe(1)
  })

  test('post delivers to all members including sender', () => {
    const delivered: Array<{ agentId: string; message: Message; historyLen: number }> = []
    const room = createRoom(makeProfile(), (agentId, message, history) => {
      delivered.push({ agentId, message, historyLen: history.length })
    })

    room.addMember('alice')
    room.addMember('bob')

    // Alice posts — delivered to both Alice and Bob
    room.post({ senderId: 'alice', content: 'Hi', type: 'chat' })
    expect(delivered).toHaveLength(2)
    expect(delivered.map(d => d.agentId).sort()).toEqual(['alice', 'bob'])
    expect(delivered[0]!.historyLen).toBe(0) // no prior messages

    delivered.length = 0

    // Bob posts — delivered to both, with 1 message of history
    room.post({ senderId: 'bob', content: 'Hey', type: 'chat' })
    expect(delivered).toHaveLength(2)
    expect(delivered.every(d => d.historyLen === 1)).toBe(true)
  })

  test('post delivers history excluding the new message', () => {
    const histories: ReadonlyArray<Message>[] = []
    const room = createRoom(makeProfile(), (_agentId, _message, history) => {
      histories.push(history)
    })

    room.addMember('alice')
    room.addMember('bob')

    room.post({ senderId: 'alice', content: 'msg-1', type: 'chat' })
    room.post({ senderId: 'alice', content: 'msg-2', type: 'chat' })
    room.post({ senderId: 'alice', content: 'msg-3', type: 'chat' })

    // Third post: history should contain msg-1 and msg-2 but NOT msg-3
    const lastHistory = histories[histories.length - 1]!
    expect(lastHistory).toHaveLength(2)
    expect(lastHistory[0]!.content).toBe('msg-1')
    expect(lastHistory[1]!.content).toBe('msg-2')
  })

  test('works without deliver callback', () => {
    const room = createRoom(makeProfile())
    room.addMember('alice')
    const message = room.post({ senderId: 'alice', content: 'Hi', type: 'chat' })
    expect(message.content).toBe('Hi')
    expect(room.getMessageCount()).toBe(1)
  })

  test('getParticipantIds derives from message senders, excludes system', () => {
    const room = createRoom(makeProfile())

    room.post({ senderId: SYSTEM_SENDER_ID, content: 'Room created', type: 'system' })
    room.post({ senderId: 'alice', content: 'Hi', type: 'chat' })
    room.post({ senderId: 'bob', content: 'Hey', type: 'chat' })
    room.post({ senderId: 'alice', content: 'Again', type: 'chat' })

    const ids = room.getParticipantIds()
    expect(ids).toContain('alice')
    expect(ids).toContain('bob')
    expect(ids).not.toContain(SYSTEM_SENDER_ID)
    expect(ids).toHaveLength(2)
  })

  test('getRecent returns last N messages', () => {
    const room = createRoom(makeProfile())

    for (let i = 0; i < 20; i++) {
      room.post({ senderId: 'alice', content: `msg-${i}`, type: 'chat' })
    }

    const recent5 = room.getRecent(5)
    expect(recent5).toHaveLength(5)
    expect(recent5[0]!.content).toBe('msg-15')
    expect(recent5[4]!.content).toBe('msg-19')

    const all = room.getRecent(100)
    expect(all).toHaveLength(20)
  })

  test('getRecent with n=0 or negative returns empty array', () => {
    const room = createRoom(makeProfile())
    room.post({ senderId: 'alice', content: 'Hi', type: 'chat' })
    expect(room.getRecent(0)).toEqual([])
    expect(room.getRecent(-1)).toEqual([])
  })

  test('profile is accessible', () => {
    const profile = makeProfile({ description: 'A test room', roomPrompt: 'Be nice' })
    const room = createRoom(profile)

    expect(room.profile.id).toBe('test-room')
    expect(room.profile.name).toBe('Test Room')
    expect(room.profile.description).toBe('A test room')
    expect(room.profile.roomPrompt).toBe('Be nice')
    expect(room.profile.visibility).toBe('public')
  })

  test('join messages make the joiner a participant', () => {
    const room = createRoom(makeProfile())
    room.post({ senderId: 'alice', content: '[alice] has joined', type: 'join' })
    expect(room.getParticipantIds()).toContain('alice')
  })

  test('preserves generationMs when provided', () => {
    const room = createRoom(makeProfile())
    const message = room.post({
      senderId: 'bot-1',
      content: 'Analyzed data',
      type: 'chat',
      generationMs: 2400,
    })
    expect(message.generationMs).toBe(2400)
  })

  test('preserves metadata when provided', () => {
    const room = createRoom(makeProfile())
    const message = room.post({
      senderId: 'alice',
      content: 'With meta',
      type: 'chat',
      metadata: { source: 'test', priority: 1 },
    })
    expect(message.metadata).toEqual({ source: 'test', priority: 1 })
  })

  test('message IDs are unique (UUID-based)', () => {
    const room = createRoom(makeProfile())
    const ids = new Set<string>()

    for (let i = 0; i < 100; i++) {
      const message = room.post({ senderId: 'alice', content: `msg-${i}`, type: 'chat' })
      ids.add(message.id)
    }

    expect(ids.size).toBe(100)
  })

  test('message IDs are unique across different rooms', () => {
    const room1 = createRoom(makeProfile({ id: 'room-1' }))
    const room2 = createRoom(makeProfile({ id: 'room-2' }))
    const ids = new Set<string>()

    for (let i = 0; i < 50; i++) {
      ids.add(room1.post({ senderId: 'alice', content: `r1-${i}`, type: 'chat' }).id)
      ids.add(room2.post({ senderId: 'bob', content: `r2-${i}`, type: 'chat' }).id)
    }

    expect(ids.size).toBe(100)
  })

  // === Message eviction ===

  test('evicts oldest messages when exceeding maxMessages', () => {
    const room = createRoom(makeProfile(), undefined, 5)

    for (let i = 0; i < 8; i++) {
      room.post({ senderId: 'alice', content: `msg-${i}`, type: 'chat' })
    }

    expect(room.getMessageCount()).toBe(5)
    const recent = room.getRecent(10)
    expect(recent[0]!.content).toBe('msg-3')
    expect(recent[4]!.content).toBe('msg-7')
  })

  test('eviction does not affect member tracking', () => {
    const room = createRoom(makeProfile(), undefined, 3)

    room.post({ senderId: 'alice', content: 'a', type: 'chat' })
    room.post({ senderId: 'bob', content: 'b', type: 'chat' })
    room.post({ senderId: 'charlie', content: 'c', type: 'chat' })
    // All 3 messages evicted after next 3 posts
    room.post({ senderId: 'dave', content: 'd', type: 'chat' })
    room.post({ senderId: 'dave', content: 'e', type: 'chat' })
    room.post({ senderId: 'dave', content: 'f', type: 'chat' })

    // Alice/bob/charlie messages are gone but they're still members
    expect(room.hasMember('alice')).toBe(true)
    expect(room.hasMember('bob')).toBe(true)
    expect(room.hasMember('charlie')).toBe(true)
    expect(room.hasMember('dave')).toBe(true)
    expect(room.getParticipantIds()).toHaveLength(4)
  })

  // === Member management ===

  test('addMember adds without requiring a post', () => {
    const room = createRoom(makeProfile())

    room.addMember('invited-agent')
    expect(room.hasMember('invited-agent')).toBe(true)
    expect(room.getParticipantIds()).toContain('invited-agent')
  })

  test('addMember is idempotent', () => {
    const room = createRoom(makeProfile())

    room.addMember('alice')
    room.addMember('alice')
    room.addMember('alice')
    expect(room.getParticipantIds().filter(id => id === 'alice')).toHaveLength(1)
  })

  test('removeMember removes agent from members and future delivery', () => {
    const delivered: string[] = []
    const room = createRoom(makeProfile(), (agentId) => { delivered.push(agentId) })

    room.addMember('alice')
    room.addMember('bob')

    room.removeMember('alice')
    expect(room.hasMember('alice')).toBe(false)
    expect(room.getParticipantIds()).not.toContain('alice')

    // Alice no longer receives messages (bob gets his own echo)
    room.post({ senderId: 'bob', content: 'Still here?', type: 'chat' })
    expect(delivered).toEqual(['bob'])
  })

  test('removeMember is safe for non-existent members', () => {
    const room = createRoom(makeProfile())
    room.removeMember('nonexistent') // should not throw
    expect(room.hasMember('nonexistent')).toBe(false)
  })

  test('hasMember returns false for system sender', () => {
    const room = createRoom(makeProfile())
    room.post({ senderId: SYSTEM_SENDER_ID, content: 'System msg', type: 'system' })
    expect(room.hasMember(SYSTEM_SENDER_ID)).toBe(false)
  })

  // === Input validation ===

  test('post throws on empty senderId', () => {
    const room = createRoom(makeProfile())
    expect(() => room.post({ senderId: '', content: 'Hi', type: 'chat' })).toThrow()
  })

  test('post throws on whitespace-only senderId', () => {
    const room = createRoom(makeProfile())
    expect(() => room.post({ senderId: '   ', content: 'Hi', type: 'chat' })).toThrow()
  })
})
