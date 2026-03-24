// ============================================================================
// Delivery — Creates the postAndDeliver function.
// Room messages: Room handles delivery internally via its DeliverFn.
// DMs: Delivered explicitly to both sender and recipient.
// ============================================================================

import type { House, Message, MessageTarget, PostAndDeliver, Team } from './types.ts'

export const createPostAndDeliver = (house: House, team: Team): PostAndDeliver => {
  const deliver = (id: string, message: Message): void => {
    try {
      team.getAgent(id)?.receive(message)
    } catch (err) {
      console.error(`[deliver] Failed for ${id}:`, err)
    }
  }

  return (target: MessageTarget, params) => {
    const correlationId = crypto.randomUUID()
    const delivered: Message[] = []

    // Room messages — Room.post() handles member delivery internally
    if (target.rooms) {
      for (const roomId of target.rooms) {
        const room = house.getRoom(roomId)
        if (!room) continue
        const message = room.post({ ...params, correlationId })
        delivered.push(message)
      }
    }

    // DMs — no Room involved, deliver explicitly to both parties
    if (target.agents) {
      for (const agentRef of target.agents) {
        const recipient = team.getAgent(agentRef)
        if (!recipient || recipient.id === params.senderId) continue
        const dmMessage: Message = {
          id: crypto.randomUUID(),
          recipientId: recipient.id,
          senderId: params.senderId,
          content: params.content,
          timestamp: Date.now(),
          type: params.type,
          correlationId,
          generationMs: params.generationMs,
          metadata: params.metadata,
        }
        delivered.push(dmMessage)
        deliver(recipient.id, dmMessage)
        deliver(params.senderId, dmMessage)
      }
    }

    return delivered
  }
}
