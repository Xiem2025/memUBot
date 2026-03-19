import { ipcMain } from 'electron'
import { qqGuildBotService, qqGuildStorage } from '../apps/qq'
import { appEvents } from '../events'
import type { IpcResponse } from '../types'

/**
 * Setup QQ Guild IPC handlers
 */
export function setupQQGuildHandlers(): void {
  // Connect to QQ Guild
  ipcMain.handle('qq:connect', async (): Promise<IpcResponse<void>> => {
    try {
      await qqGuildBotService.connect()
      return { success: true }
    } catch (error) {
      console.error('[QQ IPC] Connect error:', error)
      return {
        success: false,
        error: error instanceof Error ? error.message : String(error)
      }
    }
  })

  // Disconnect from QQ Guild
  ipcMain.handle('qq:disconnect', async (): Promise<IpcResponse<void>> => {
    try {
      await qqGuildBotService.disconnect()
      return { success: true }
    } catch (error) {
      console.error('[QQ IPC] Disconnect error:', error)
      return {
        success: false,
        error: error instanceof Error ? error.message : String(error)
      }
    }
  })

  // Get connection status
  ipcMain.handle('qq:status', async (): Promise<IpcResponse> => {
    try {
      const status = qqGuildBotService.getStatus()
      return { success: true, data: status }
    } catch (error) {
      console.error('[QQ IPC] Status error:', error)
      return {
        success: false,
        error: error instanceof Error ? error.message : String(error)
      }
    }
  })

  // Get messages
  ipcMain.handle('qq:get-messages', async (_event, limit?: number): Promise<IpcResponse> => {
    try {
      const messages = await qqGuildBotService.getMessages(limit)
      return { success: true, data: messages }
    } catch (error) {
      console.error('[QQ IPC] Get messages error:', error)
      return {
        success: false,
        error: error instanceof Error ? error.message : String(error)
      }
    }
  })

  // Clear all messages
  ipcMain.handle('qq:clear-messages', async (): Promise<IpcResponse<{ deletedCount: number }>> => {
    try {
      const count = await qqGuildStorage.getMessageCount()
      await qqGuildStorage.clearMessages()
      
      // Emit refresh event
      appEvents.emitMessagesRefresh('qq')
      
      return { success: true, data: { deletedCount: count } }
    } catch (error) {
      console.error('[QQ IPC] Clear messages error:', error)
      return {
        success: false,
        error: error instanceof Error ? error.message : String(error)
      }
    }
  })

  // Delete recent messages
  ipcMain.handle('qq:delete-recent-messages', async (_event, count: number): Promise<IpcResponse<{ deletedCount: number }>> => {
    try {
      const deletedCount = await qqGuildStorage.deleteRecentMessages(count)
      
      // Emit refresh event
      appEvents.emitMessagesRefresh('qq')
      
      return { success: true, data: { deletedCount } }
    } catch (error) {
      console.error('[QQ IPC] Delete recent messages error:', error)
      return {
        success: false,
        error: error instanceof Error ? error.message : String(error)
      }
    }
  })

  // Get storage info
  ipcMain.handle('qq:get-storage-info', async (): Promise<IpcResponse> => {
    try {
      const messageCount = await qqGuildStorage.getMessageCount()
      return { 
        success: true, 
        data: { 
          messageCount,
          platform: 'qq'
        } 
      }
    } catch (error) {
      console.error('[QQ IPC] Get storage info error:', error)
      return {
        success: false,
        error: error instanceof Error ? error.message : String(error)
      }
    }
  })
}
