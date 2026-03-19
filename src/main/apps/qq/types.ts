/**
 * QQ Bot specific types
 * Native WebSocket implementation for QQ Bot API v2
 */

// QQ Guild bot configuration
export interface QQGuildConfig {
  appID: string
  token: string
  sandbox?: boolean
  intents?: string[]
}

// Attachment type for stored messages
export interface StoredQQGuildAttachment {
  id: string
  name: string
  url: string
  contentType?: string
  size?: number
  width?: number
  height?: number
}

// Stored QQ Guild message (simplified for single-user mode)
export interface StoredQQGuildMessage {
  messageId: string
  channelId: string
  guildId?: string
  fromId: string
  fromUsername: string
  fromAvatar?: string
  text?: string
  attachments?: StoredQQGuildAttachment[]
  date: number // Unix timestamp in seconds
  replyToMessageId?: string
  isFromBot: boolean
}

// QQ Guild message from SDK
export interface QQGuildMessageEvent {
  eventType: string
  eventId: string
  msg: {
    id: string
    channel_id: string
    guild_id: string
    content: string
    timestamp: string
    author: {
      id: string
      username: string
      avatar?: string
      bot?: boolean
    }
    member?: {
      nick?: string
    }
    attachments?: Array<{
      url: string
      content_type?: string
      filename?: string
      size?: number
      width?: number
      height?: number
    }>
    message_reference?: {
      message_id?: string
    }
    mentions?: Array<{
      id: string
      username: string
      avatar?: string
    }>
  }
}

// QQ Guild user info
export interface QQGuildUser {
  id: string
  username: string
  avatar?: string
  bot?: boolean
}

// QQ Guild channel info
export interface QQGuildChannel {
  id: string
  name: string
  type: number
  guildId: string
}

// QQ Guild info
export interface QQGuildInfo {
  id: string
  name: string
  icon?: string
  ownerId: string
  memberCount?: number
}

// Connection status
export interface QQGuildConnectionStatus {
  state: 'disconnected' | 'connecting' | 'connected' | 'error'
  error?: string
}
