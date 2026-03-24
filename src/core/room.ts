// ============================================================================
// Room — Self-contained component: messages + members + delivery.
// post() appends the message, delivers to all members, and returns it.
// Room stamps its own roomId on messages — caller never passes roomId.
// Delivery includes message history (all messages before the new one) so
// recipients can distinguish old context from fresh arrivals.
//
// Members are tracked via addMember/removeMember/hasMember for access control.
// post() implicitly adds the sender as a member.
// Messages are capped at maxMessages to prevent unbounded growth.
// ============================================================================

import type { DeliverFn, Message, PostParams, Room, RoomProfile } from './types.ts'
import { DEFAULTS, SYSTEM_SENDER_ID } from './types.ts'

export const createRoom = (initialProfile: RoomProfile, deliver?: DeliverFn, maxMessages?: number): Room => {
  let profile = initialProfile
  const messages: Message[] = []
  const members = new Set<string>()
  const messageLimit = maxMessages ?? DEFAULTS.roomMessageLimit

  const post = (params: PostParams): Message => {
    // Validate sender
    if (!params.senderId || params.senderId.trim() === '') {
      throw new Error('post() requires a non-empty senderId')
    }

    const message: Message = {
      id: crypto.randomUUID(),
      roomId: profile.id,
      senderId: params.senderId,
      content: params.content,
      timestamp: Date.now(),
      type: params.type,
      correlationId: params.correlationId,
      generationMs: params.generationMs,
      metadata: params.metadata,
    }
    messages.push(message)

    // Sender becomes a member implicitly
    if (params.senderId !== SYSTEM_SENDER_ID) {
      members.add(params.senderId)
    }

    // Evict oldest messages if over limit
    if (messages.length > messageLimit) {
      messages.splice(0, messages.length - messageLimit)
    }

    // Deliver to all members (including sender, so agents see their own responses in history)
    if (deliver) {
      const history = messages.slice(0, -1)
      for (const id of members) {
        deliver(id, message, history)
      }
    }

    return message
  }

  const getRecent = (n: number): ReadonlyArray<Message> => {
    if (n <= 0) return []
    if (messages.length <= n) return [...messages]
    return messages.slice(-n)
  }

  const getParticipantIds = (): ReadonlyArray<string> => [...members]

  const addMember = (id: string): void => {
    members.add(id)
  }

  const removeMember = (id: string): void => {
    members.delete(id)
  }

  const hasMember = (id: string): boolean => members.has(id)

  const getMessageCount = (): number => messages.length

  return {
    get profile() { return profile },
    post,
    getRecent,
    getParticipantIds,
    addMember,
    removeMember,
    hasMember,
    getMessageCount,
    setRoomPrompt: (prompt: string) => {
      profile = { ...profile, roomPrompt: prompt }
    },
  }
}
