// ============================================================================
// Room membership operations — add/remove agents from rooms with join/leave
// messages. Used by System methods (main.ts) and spawn.ts.
//
// Both functions resolve the agent from team, validate the room, update
// membership, call agent.join/leave, and post a visible chat message.
// ============================================================================

import type { House } from '../core/types/room.ts'
import type { RouteMessage, Team } from '../core/types/agent.ts'
import { makeJoinMetadata } from './shared.ts'

export const addAgentToRoom = async (
  targetId: string,
  targetName: string,
  roomId: string,
  invitedBy: string | undefined,
  team: Team,
  routeMessage: RouteMessage,
  house: House,
): Promise<void> => {
  const target = team.getAgent(targetId)
  if (!target) return

  const room = house.getRoom(roomId)
  if (!room) return

  if (room.hasMember(targetId)) return

  room.addMember(targetId)
  await target.join(room)

  // Live-path auto-switch: Broadcast → Manual on second AI join.
  // Skipped during snapshot restore (which bypasses this function and calls
  // room.addMember directly).
  if (target.kind === 'ai' && room.deliveryMode === 'broadcast') {
    const aiMemberCount = room.getParticipantIds()
      .filter(id => team.getAgent(id)?.kind === 'ai').length
    if (aiMemberCount === 2) {
      room.autoSwitchToManual('second-ai-joined')
    }
  }

  const content = invitedBy
    ? `[${targetName}] has joined (added by [${invitedBy}])`
    : `[${targetName}] has joined`

  routeMessage(
    { rooms: [roomId] },
    { senderId: targetId, senderName: targetName, content, type: 'join', metadata: makeJoinMetadata(target) },
  )
}

export const removeAgentFromRoom = (
  targetId: string,
  targetName: string,
  roomId: string,
  removedBy: string | undefined,
  team: Team,
  routeMessage: RouteMessage,
  house: House,
): void => {
  const target = team.getAgent(targetId)
  if (!target) return

  const room = house.getRoom(roomId)
  if (!room || !room.hasMember(targetId)) return

  room.removeMember(targetId)
  target.leave(roomId)

  const content = removedBy
    ? `[${targetName}] has left (removed by [${removedBy}])`
    : `[${targetName}] has left`

  routeMessage(
    { rooms: [roomId] },
    { senderId: targetId, senderName: targetName, content, type: 'leave' },
  )
}
