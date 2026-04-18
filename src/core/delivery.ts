// ============================================================================
// Message Router — Routes messages to rooms.
//
// Room.post() handles storage and member delivery internally.
// correlationId is shared across all rooms in a single routing call.
// ============================================================================

import type { Message, MessageTarget } from './types/messaging.ts'
import type { RouterDeps, RouteMessage } from './types/agent.ts'

export const createMessageRouter = ({ house }: RouterDeps): RouteMessage => {
  return (target: MessageTarget, params) => {
    const correlationId = crypto.randomUUID()
    const delivered: Message[] = []

    for (const roomId of target.rooms) {
      const room = house.getRoom(roomId)
      if (!room) continue
      const message = room.post({ ...params, correlationId })
      delivered.push(message)
    }

    return delivered
  }
}
