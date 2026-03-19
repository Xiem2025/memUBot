/**
 * QQ Guild Authentication Service
 * Handles AccessToken-based authentication for QQ Bot API v2
 */

import { getSetting } from '../../config/settings.config'

interface AccessTokenResponse {
  access_token: string
  expires_in: number
}

interface TokenInfo {
  token: string
  expiresAt: number
}

/**
 * QQ Authentication Service
 * Manages AccessToken lifecycle for QQ Bot API
 */
export class QQAuthService {
  private tokenInfo: TokenInfo | null = null
  private appId: string = ''
  private appSecret: string = ''
  private sandbox: boolean = false

  /**
   * Initialize with credentials
   */
  async initialize(): Promise<void> {
    const appId = await getSetting('qqGuildAppID')
    const appSecret = await getSetting('qqGuildAppSecret')  // New field needed
    const sandbox = await getSetting('qqGuildSandbox') ?? false

    if (!appId || !appSecret) {
      throw new Error('QQ Guild AppID or AppSecret not configured')
    }

    this.appId = appId
    this.appSecret = appSecret
    this.sandbox = sandbox
  }

  /**
   * Get valid AccessToken
   * Automatically refreshes if expired or about to expire
   */
  async getAccessToken(): Promise<string> {
    // Check if we have a valid token (with 60s buffer for refresh)
    if (this.tokenInfo && this.tokenInfo.expiresAt > Date.now() + 60000) {
      return this.tokenInfo.token
    }

    // Need to fetch new token
    return this.fetchAccessToken()
  }

  /**
   * Fetch new AccessToken from QQ API
   */
  private async fetchAccessToken(): Promise<string> {
    const url = 'https://bots.qq.com/app/getAppAccessToken'
    
    console.log('[QQ Auth] Fetching AccessToken...')
    console.log('[QQ Auth] AppID:', this.appId)

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

      // Store token with expiration
      this.tokenInfo = {
        token: data.access_token,
        expiresAt: Date.now() + (data.expires_in * 1000)
      }

      console.log('[QQ Auth] AccessToken obtained successfully')
      console.log('[QQ Auth] Expires in:', data.expires_in, 'seconds')

      return data.access_token
    } catch (error) {
      console.error('[QQ Auth] Failed to fetch AccessToken:', error)
      throw error
    }
  }

  /**
   * Get Authorization header for API requests
   */
  async getAuthorizationHeader(): Promise<string> {
    const token = await this.getAccessToken()
    return `QQBot ${token}`
  }

  /**
   * Clear cached token (for logout/reconnect)
   */
  clearToken(): void {
    this.tokenInfo = null
    console.log('[QQ Auth] Token cleared')
  }
}

// Export singleton
export const qqAuthService = new QQAuthService()
