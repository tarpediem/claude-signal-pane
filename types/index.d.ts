export type SignalAttachment = {
  id: string
  contentType: string
  filename?: string
  width?: number
  height?: number
}

export type SignalReaction = { emoji: string; from: string }

export type DeliveryStatus = 'sent' | 'delivered' | 'read'

export type SignalMessage = {
  timestamp: number
  sender: string
  // Conversation-style id of the author (`u:<uuid>`, `n:<number>`), or `me`.
  authorId: string
  isMine: boolean
  text: string
  attachments: SignalAttachment[]
  reactions: SignalReaction[]
  status?: DeliveryStatus
}

export type Conversation = {
  id: string
  name: string
  isGroup: boolean
  lastAt: number
  messages: SignalMessage[]
  typing?: { name: string; at: number }
}

export type SignalModel = {
  conversations: Conversation[]
  status: string
}

declare module 'claude-code' {
  interface PluginState {
    'signal-pane': {
      model: SignalModel
      selected: string | null
      sentCount: number
      reactingTo: number | null
      historyOffset: number
    }
  }
}
