import { json, errorResponse, parseBody } from './helpers.ts'
import type { MessageTarget } from '../../core/types/messaging.ts'
import type { RouteEntry } from './types.ts'

export const messageRoutes: RouteEntry[] = [
  {
    method: 'POST',
    pattern: /^\/api\/messages$/,
    handler: async (req, _match, { system }) => {
      const body = await parseBody(req)
      if (!body.content || !body.senderId) return errorResponse('content and senderId are required')
      const target = (body.target as MessageTarget) ?? {}
      const senderId = body.senderId as string
      const senderAgent = system.team.getAgent(senderId)
      // Arbitrary metadata is no longer accepted; external callers that need
      // typed fields (stepPrompt, provider, …) can send them as top-level
      // keys which flow through Message's Omit-derived PostParams.
      const messages = system.routeMessage(target, {
        senderId,
        senderName: (body.senderName as string | undefined) ?? senderAgent?.name,
        content: body.content as string,
        type: (body.messageType as 'chat') ?? 'chat',
      })
      return json(messages, 201)
    },
  },
]
