/**
 * QQ Bot Service v2
 * Uses AccessToken-based authentication (QQ Bot API v2)
 * Supports: Guild (频道), Group (群聊), C2C (私聊)
 */

import WebSocket from 'ws'
import { qqGuildStorage } from './storage'
import { getSetting } from '../../config/settings.config'
import { agentService } from '../../services/agent.service'
import { infraService } from '../../services/infra.service'

import { appEvents } from '../../events'
import type { BotStatus, AppMessage, MessageAttachment } from '../types'
import type { 
  StoredQQGuildMessage, 
  StoredQQGuildAttachment,
  QQGuildUser 
} from './types'

// AccessToken response
interface AccessTokenResponse {
  access_token: string
  expires_in: number
}

// WebSocket message types
interface WSMessage {
  op: number
  d?: any
  s?: number
  t?: string
  id?: string
}

// OpCodes
const OpCode = {
  DISPATCH: 0,
  HEARTBEAT: 1,
  IDENTIFY: 2,
  RESUME: 6,
  RECONNECT: 7,
  INVALID_SESSION: 9,
  HELLO: 10,
  HEARTBEAT_ACK: 11,
}

// Session events
const SessionEvents = {
  READY: 'READY',
  RESUMED: 'RESUMED',
  ERROR: 'ERROR',
  DISCONNECT: 'DISCONNECT',
}

// QQ Bot intents - 按权限级别分组
// 基础权限（默认有）
// GUILDS: 1 << 0,                    // 频道相关
// GUILD_MEMBERS: 1 << 1,             // 频道成员
// PUBLIC_GUILD_MESSAGES: 1 << 30,    // 频道公开消息（公域）
// 需要申请的权限
// DIRECT_MESSAGE: 1 << 12,           // 频道私信
// GROUP_AND_C2C: 1 << 25,            // 群聊和 C2C 私聊（需申请）

// 使用完整权限（群聊 + 私信 + 频道）
const FULL_INTENTS = (1 << 30) | (1 << 12) | (1 << 25)

// Message types for different scenarios
type MessageType = 'guild' | 'group' | 'c2c'

interface MessageContext {
  type: MessageType
  senderId: string
  senderName: string
  content: string
  messageId: string
  timestamp: string
  channelId?: string
  guildId?: string
  groupOpenid?: string
  userOpenid?: string
  attachments?: any[]
}

/**
 * QQ Bot Service v2
 * Implements AccessToken authentication with full support for Guild/Group/C2C
 */
export class QQGuildBotServiceV2 {
  private ws: WebSocket | null = null
  private status: BotStatus = {
    platform: 'qq',
    isConnected: false
  }
  private currentChannelId: string | null = null
  private botInfo: QQGuildUser | null = null
  
  // AccessToken management
  private accessToken: string | null = null
  private tokenExpiresAt: number = 0
  private appId: string = ''
  private appSecret: string = ''
  private sandbox: boolean = false
  
  // WebSocket state
  private heartbeatInterval: number = 0
  private heartbeatTimer: NodeJS.Timeout | null = null
  private sessionId: string = ''
  private seq: number = 0
  private eventEmitter = new (require('events').EventEmitter)()

  /**
   * Get AccessToken from QQ API
   */
  private async fetchAccessToken(): Promise<string> {
    const url = 'https://bots.qq.com/app/getAppAccessToken'
    
    console.log('[QQ Bot v2] Fetching AccessToken...')
    console.log('[QQ Bot v2] AppID:', this.appId)

    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          appId: this.appId,
          clientSecret: this.appSecret
        })
      })

      if (!response.ok) {
        const errorText = await response.text()
        throw new Error(`Failed to get AccessToken: ${response.status} - ${errorText}`)
      }

      const data: AccessTokenResponse = await response.json()
      
      if (!data.access_token) {
        throw new Error('Invalid response: no access_token')
      }

      this.accessToken = data.access_token
      this.tokenExpiresAt = Date.now() + (data.expires_in * 1000)

      console.log('[QQ Bot v2] AccessToken obtained successfully')
      console.log('[QQ Bot v2] Expires in:', data.expires_in, 'seconds')

      return data.access_token
    } catch (error) {
      console.error('[QQ Bot v2] Failed to fetch AccessToken:', error)
      throw error
    }
  }

  /**
   * Get valid AccessToken (refresh if needed)
   */
  private async getAccessToken(): Promise<string> {
    // Refresh if expired or about to expire (60s buffer)
    if (!this.accessToken || this.tokenExpiresAt < Date.now() + 60000) {
      return this.fetchAccessToken()
    }
    return this.accessToken
  }

  /**
   * Get WebSocket gateway URL
   */
  private async getGatewayUrl(): Promise<string> {
    const token = await this.getAccessToken()
    const baseUrl = this.sandbox 
      ? 'https://sandbox.api.sgroup.qq.com' 
      : 'https://api.sgroup.qq.com'
    
    console.log('[QQ Bot v2] Fetching gateway URL...')
    console.log('[QQ Bot v2] Environment:', this.sandbox ? 'sandbox' : 'production')

    const response = await fetch(`${baseUrl}/gateway/bot`, {
      headers: {
        'Authorization': `QQBot ${token}`,
        'User-Agent': 'memU-Bot/1.0.0'
      }
    })

    const responseText = await response.text()
    console.log('[QQ Bot v2] Gateway response:', response.status, responseText)

    if (!response.ok) {
      let errorMessage = `Failed to get gateway: ${response.status}`
      try {
        const errorData = JSON.parse(responseText)
        // Handle QQ-specific error codes
        if (errorData.code === 11298 || errorData.err_code === 40023002) {
          errorMessage = 'IP不在白名单 (IP not in whitelist)。请在QQ开放平台将当前服务器IP添加到白名单。'
        } else if (errorData.message) {
          errorMessage = `${errorData.message} (code: ${errorData.code})`
        }
      } catch {
        errorMessage = `${errorMessage} - ${responseText}`
      }
      throw new Error(errorMessage)
    }

    const data = JSON.parse(responseText)
    console.log('[QQ Bot v2] Gateway URL:', data.url)
    return data.url
  }

  /**
   * Connect to QQ Bot
   */
  async connect(): Promise<void> {
    try {
      console.log('[QQ Bot v2] Starting connection...')

      // Get credentials
      this.appId = await getSetting('qqGuildAppID') || ''
      this.appSecret = await getSetting('qqGuildAppSecret') || ''
      this.sandbox = await getSetting('qqGuildSandbox') ?? false

      if (!this.appId || !this.appSecret) {
        throw new Error('QQ Bot AppID or AppSecret not configured. Please set it in Settings.')
      }

      // Initialize storage
      await qqGuildStorage.initialize()
      console.log('[QQ Bot v2] Storage initialized')

      // Get AccessToken
      await this.getAccessToken()

      // Get WebSocket URL
      const wsUrl = await this.getGatewayUrl()

      // Connect WebSocket
      await this.connectWebSocket(wsUrl)

    } catch (error) {
      console.error('[QQ Bot v2] Connection error:', error)
      this.status = {
        platform: 'qq',
        isConnected: false,
        error: error instanceof Error ? error.message : String(error)
      }
      appEvents.emitQQGuildStatusChanged(this.status)
      throw error
    }
  }

  /**
   * Connect WebSocket
   */
  private async connectWebSocket(url: string): Promise<void> {
    return new Promise((resolve, reject) => {
      console.log('[QQ Bot v2] Connecting WebSocket...')

      this.ws = new WebSocket(url)

      const timeout = setTimeout(() => {
        reject(new Error('WebSocket connection timeout'))
      }, 30000)

      this.ws.on('open', () => {
        console.log('[QQ Bot v2] WebSocket connected')
      })

      this.ws.on('message', (data: Buffer) => {
        try {
          const msg: WSMessage = JSON.parse(data.toString())
          this.handleWSMessage(msg, resolve, timeout)
        } catch (e) {
          console.error('[QQ Bot v2] Failed to parse message:', e)
        }
      })

      this.ws.on('error', (error) => {
        clearTimeout(timeout)
        console.error('[QQ Bot v2] WebSocket error:', error)
        reject(error)
      })

      this.ws.on('close', (code, reason) => {
        console.log('[QQ Bot v2] WebSocket closed:', code, reason.toString())
        this.handleClose(code)
      })
    })
  }

  /**
   * Handle WebSocket message
   */
  private handleWSMessage(
    msg: WSMessage, 
    resolve?: (value: void) => void, 
    timeout?: NodeJS.Timeout
  ): void {
    // Update sequence number
    if (msg.s) {
      this.seq = msg.s
    }

    switch (msg.op) {
      case OpCode.HELLO:
        // Server says hello, send identify
        console.log('[QQ Bot v2] Received HELLO')
        this.heartbeatInterval = msg.d?.heartbeat_interval || 30000
        this.sendIdentify()
        break

      case OpCode.HEARTBEAT_ACK:
        // Heartbeat acknowledged
        console.log('[QQ Bot v2] Heartbeat ACK')
        break

      case OpCode.DISPATCH:
        // Event dispatch
        this.handleDispatch(msg)
        
        // READY event means connection successful
        if (msg.t === SessionEvents.READY && resolve) {
          clearTimeout(timeout!)
          this.sessionId = msg.d?.session_id || ''
          this.status = {
            platform: 'qq',
            isConnected: true,
            username: msg.d?.user?.username,
            botName: msg.d?.user?.username,
          }
          this.botInfo = {
            id: msg.d?.user?.id,
            username: msg.d?.user?.username,
            avatar: msg.d?.user?.avatar,
            bot: true
          }
          console.log('[QQ Bot v2] Bot ready:', this.botInfo.username)
          appEvents.emitQQGuildStatusChanged(this.status)
          this.startHeartbeat()
          resolve()
        }
        break

      case OpCode.RECONNECT:
        // Server requests reconnect
        console.log('[QQ Bot v2] Server requested reconnect')
        this.reconnect()
        break

      case OpCode.INVALID_SESSION:
        // Session invalid, need to re-identify
        console.log('[QQ Bot v2] Invalid session')
        this.sendIdentify()
        break
    }
  }

  /**
   * Send identify payload
   */
  private async sendIdentify(): Promise<void> {
    const token = await this.getAccessToken()
    
    const identify = {
      op: OpCode.IDENTIFY,
      d: {
        token: `QQBot ${token}`,
        intents: FULL_INTENTS,
        shard: [0, 1],
        properties: {
          $os: 'windows',
          $browser: 'memU-Bot',
          $device: 'memU-Bot'
        }
      }
    }

    console.log('[QQ Bot v2] Sending IDENTIFY with intents:', FULL_INTENTS)
    this.ws?.send(JSON.stringify(identify))
  }

  /**
   * Handle dispatch events
   */
  private handleDispatch(msg: WSMessage): void {
    if (!msg.t || !msg.d) return

    console.log('[QQ Bot v2] Dispatch event:', msg.t)

    switch (msg.t) {
      case 'AT_MESSAGE_CREATE':
        // Guild public message with @mention
        this.handleGuildMessage(msg.d)
        break
      case 'MESSAGE_CREATE':
        // Guild direct message or guild message
        this.handleGuildMessage(msg.d)
        break
      case 'DIRECT_MESSAGE_CREATE':
        // Guild DM
        this.handleGuildMessage(msg.d)
        break
      case 'C2C_MESSAGE_CREATE':
        // C2C private message
        this.handleC2CMessage(msg.d)
        break
      case 'GROUP_AT_MESSAGE_CREATE':
        // Group message with @mention
        this.handleGroupMessage(msg.d)
        break
    }
  }

  /**
   * Handle guild message
   */
  private async handleGuildMessage(event: any): Promise<void> {
    const context: MessageContext = {
      type: 'guild',
      senderId: event.author?.id,
      senderName: event.member?.nick || event.author?.username || 'Unknown',
      content: event.content || '',
      messageId: event.id,
      timestamp: event.timestamp,
      channelId: event.channel_id,
      guildId: event.guild_id,
      attachments: event.attachments
    }

    console.log('[QQ Bot v2] Guild message from:', context.senderName, ':', context.content.substring(0, 50))
    await this.processMessage(context)
  }

  /**
   * Handle C2C message
   */
  private async handleC2CMessage(event: any): Promise<void> {
    const context: MessageContext = {
      type: 'c2c',
      senderId: event.author?.user_openid,
      senderName: event.author?.username || 'User',
      content: event.content || '',
      messageId: event.id,
      timestamp: event.timestamp,
      userOpenid: event.author?.user_openid,
      attachments: event.attachments
    }

    console.log('[QQ Bot v2] C2C message from:', context.senderName, ':', context.content.substring(0, 50))
    await this.processMessage(context)
  }

  /**
   * Handle group message
   */
  private async handleGroupMessage(event: any): Promise<void> {
    const context: MessageContext = {
      type: 'group',
      senderId: event.author?.member_openid,
      senderName: event.author?.username || 'User',
      content: event.content || '',
      messageId: event.id,
      timestamp: event.timestamp,
      groupOpenid: event.group_openid,
      attachments: event.attachments
    }

    console.log('[QQ Bot v2] Group message from:', context.senderName, ':', context.content.substring(0, 50))
    await this.processMessage(context)
  }

  /**
   * Process message with Agent
   */
  private async processMessage(context: MessageContext): Promise<void> {
    // Remove @ mentions from content
    const content = context.content.replace(/<@!?\d+>/g, '').trim()
    
    console.log('[QQ Bot v2] Processing message:', content)

    // Store message
    const storedMsg: StoredQQGuildMessage = {
      messageId: context.messageId,
      channelId: context.channelId || context.groupOpenid || context.userOpenid || 'unknown',
      guildId: context.guildId,
      fromId: context.senderId,
      fromUsername: context.senderName,
      fromAvatar: undefined,
      text: content,
      date: Math.floor(Date.now() / 1000),
      isFromBot: false
    }
    await qqGuildStorage.storeMessage(storedMsg)

    // Emit event
    const appMessage = this.convertToAppMessage(storedMsg)
    appEvents.emitQQGuildNewMessage(appMessage)

    // Process with Agent
    if (content) {
      try {
        // Check if should be consumed
        if (await infraService.tryConsumeUserInput(content, 'qq')) {
          return
        }

        const response = await agentService.processMessage(content, 'qq')

        if (response.success && response.message) {
          // Send reply based on message type
          let sent
          if (context.type === 'c2c') {
            sent = await this.sendC2CMessage(context.userOpenid!, {
              content: response.message,
              msg_id: context.messageId
            })
          } else if (context.type === 'group') {
            sent = await this.sendGroupMessage(context.groupOpenid!, {
              content: response.message,
              msg_id: context.messageId
            })
          } else {
            sent = await this.sendChannelMessage(context.channelId!, {
              content: response.message,
              msg_id: context.messageId
            })
          }

          if (sent.success) {
            // Store bot reply
            const botReply: StoredQQGuildMessage = {
              messageId: sent.messageId || 'unknown',
              channelId: storedMsg.channelId,
              guildId: context.guildId,
              fromId: this.botInfo?.id || 'bot',
              fromUsername: this.botInfo?.username || 'Bot',
              fromAvatar: this.botInfo?.avatar,
              text: response.message,
              date: Math.floor(Date.now() / 1000),
              replyToMessageId: context.messageId,
              isFromBot: true
            }
            await qqGuildStorage.storeMessage(botReply)
            appEvents.emitQQGuildNewMessage(this.convertToAppMessage(botReply))
          }
        }
      } catch (error) {
        console.error('[QQ Bot v2] Agent error:', error)
        // Send error reply
        if (context.type === 'c2c') {
          await this.sendC2CMessage(context.userOpenid!, {
            content: '抱歉，处理消息时出错了。',
            msg_id: context.messageId
          })
        } else if (context.type === 'group') {
          await this.sendGroupMessage(context.groupOpenid!, {
            content: '抱歉，处理消息时出错了。',
            msg_id: context.messageId
          })
        } else {
          await this.sendChannelMessage(context.channelId!, {
            content: '抱歉，处理消息时出错了。',
            msg_id: context.messageId
          })
        }
      }
    }
  }

  /**
   * Send message to channel (Guild)
   */
  private async sendChannelMessage(
    channelId: string,
    message: { content: string; msg_id?: string }
  ): Promise<{ success: boolean; messageId?: string }> {
    try {
      const token = await this.getAccessToken()
      const baseUrl = this.sandbox 
        ? 'https://sandbox.api.sgroup.qq.com' 
        : 'https://api.sgroup.qq.com'

      const response = await fetch(`${baseUrl}/channels/${channelId}/messages`, {
        method: 'POST',
        headers: {
          'Authorization': `QQBot ${token}`,
          'Content-Type': 'application/json',
          'User-Agent': 'memU-Bot/1.0.0'
        },
        body: JSON.stringify({
          content: message.content,
          msg_id: message.msg_id
        })
      })

      if (!response.ok) {
        throw new Error(`Failed to send message: ${response.status}`)
      }

      const data = await response.json()
      return { success: true, messageId: data.id }
    } catch (error) {
      console.error('[QQ Bot v2] Failed to send channel message:', error)
      return { success: false }
    }
  }

  /**
   * Send message to C2C user (v2 API)
   */
  private async sendC2CMessage(
    openid: string,
    message: { content: string; msg_id?: string }
  ): Promise<{ success: boolean; messageId?: string }> {
    try {
      const token = await this.getAccessToken()
      const baseUrl = this.sandbox 
        ? 'https://sandbox.api.sgroup.qq.com' 
        : 'https://api.sgroup.qq.com'

      // Use v2 API for C2C messages
      const response = await fetch(`${baseUrl}/v2/users/${openid}/messages`, {
        method: 'POST',
        headers: {
          'Authorization': `QQBot ${token}`,
          'Content-Type': 'application/json',
          'User-Agent': 'memU-Bot/1.0.0'
        },
        body: JSON.stringify({
          content: message.content,
          msg_type: 0,
          msg_id: message.msg_id
        })
      })

      if (!response.ok) {
        const errorText = await response.text()
        throw new Error(`Failed to send C2C message: ${response.status} - ${errorText}`)
      }

      const data = await response.json()
      return { success: true, messageId: data.id }
    } catch (error) {
      console.error('[QQ Bot v2] Failed to send C2C message:', error)
      return { success: false }
    }
  }

  /**
   * Send message to group (v2 API)
   */
  private async sendGroupMessage(
    groupOpenid: string,
    message: { content: string; msg_id?: string }
  ): Promise<{ success: boolean; messageId?: string }> {
    try {
      const token = await this.getAccessToken()
      const baseUrl = this.sandbox 
        ? 'https://sandbox.api.sgroup.qq.com' 
        : 'https://api.sgroup.qq.com'

      // Use v2 API for group messages
      const response = await fetch(`${baseUrl}/v2/groups/${groupOpenid}/messages`, {
        method: 'POST',
        headers: {
          'Authorization': `QQBot ${token}`,
          'Content-Type': 'application/json',
          'User-Agent': 'memU-Bot/1.0.0'
        },
        body: JSON.stringify({
          content: message.content,
          msg_type: 0,
          msg_id: message.msg_id
        })
      })

      if (!response.ok) {
        const errorText = await response.text()
        throw new Error(`Failed to send group message: ${response.status} - ${errorText}`)
      }

      const data = await response.json()
      return { success: true, messageId: data.id }
    } catch (error) {
      console.error('[QQ Bot v2] Failed to send group message:', error)
      return { success: false }
    }
  }

  /**
   * Start heartbeat
   */
  private startHeartbeat(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer)
    }

    this.heartbeatTimer = setInterval(() => {
      if (this.ws?.readyState === WebSocket.OPEN) {
        this.ws.send(JSON.stringify({
          op: OpCode.HEARTBEAT,
          d: this.seq || null
        }))
        console.log('[QQ Bot v2] Heartbeat sent')
      }
    }, this.heartbeatInterval)

    console.log('[QQ Bot v2] Heartbeat started, interval:', this.heartbeatInterval)
  }

  /**
   * Handle WebSocket close
   */
  private handleClose(code: number): void {
    console.log('[QQ Bot v2] Connection closed with code:', code)
    
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer)
      this.heartbeatTimer = null
    }

    this.status.isConnected = false
    appEvents.emitQQGuildStatusChanged(this.status)

    // Auto reconnect for certain codes
    if (code === 4009 || code === 4008) {
      console.log('[QQ Bot v2] Will attempt reconnect...')
      setTimeout(() => this.reconnect(), 5000)
    }
  }

  /**
   * Reconnect
   */
  private async reconnect(): Promise<void> {
    console.log('[QQ Bot v2] Reconnecting...')
    try {
      await this.connect()
    } catch (error) {
      console.error('[QQ Bot v2] Reconnect failed:', error)
    }
  }

  /**
   * Disconnect
   */
  async disconnect(): Promise<void> {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer)
      this.heartbeatTimer = null
    }

    if (this.ws) {
      this.ws.close()
      this.ws = null
    }

    this.status = {
      platform: 'qq',
      isConnected: false
    }
    appEvents.emitQQGuildStatusChanged(this.status)
    console.log('[QQ Bot v2] Disconnected')
  }

  /**
   * Get status
   */
  getStatus(): BotStatus {
    return this.status
  }

  /**
   * Get messages
   */
  async getMessages(limit = 200): Promise<AppMessage[]> {
    const messages = await qqGuildStorage.getMessages(limit)
    return messages.map((msg) => this.convertToAppMessage(msg))
  }

  /**
   * Convert to AppMessage
   */
  private convertToAppMessage(msg: StoredQQGuildMessage): AppMessage {
    const attachments: MessageAttachment[] | undefined = msg.attachments?.map(att => ({
      id: att.id,
      name: att.name,
      url: att.url,
      contentType: att.contentType,
      size: att.size || 0,
      width: att.width,
      height: att.height
    }))

    return {
      id: msg.messageId,
      platform: 'qq',
      chatId: msg.channelId,
      senderId: msg.fromId,
      senderName: msg.fromUsername,
      content: msg.text || '',
      attachments,
      timestamp: new Date(msg.date * 1000),
      isFromBot: msg.isFromBot,
      replyToId: msg.replyToMessageId
    }
  }
}

// Export singleton
export const qqGuildBotService = new QQGuildBotServiceV2()
