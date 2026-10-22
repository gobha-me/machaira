import { defineStore } from 'pinia'
import { api, onUnauthorized, type AuthUser } from '../services/api'

type AuthState = 'loading' | 'error' | 'bootstrap' | 'anonymous' | 'authenticated'

export const useAuth = defineStore('auth', {
  state: () => ({
    state: 'loading' as AuthState,
    error: null as string | null,
    user: null as AuthUser | null
  }),
  getters: {
    authenticated: (state): boolean => state.state === 'authenticated' && state.user !== null,
    isAdmin: (state): boolean => state.user?.role === 'admin'
  },
  actions: {
    async initialize(): Promise<void> {
      this.state = 'loading'
      this.error = null
      onUnauthorized(() => {
        this.user = null
        this.state = 'anonymous'
      })
      try {
        const status = await api.authStatus()
        this.state = status.state
        this.user = status.state === 'authenticated' ? status.user : null
      } catch (error) {
        this.user = null
        this.error = error instanceof Error ? error.message : 'Could not load your session.'
        this.state = 'error'
      }
    },
    async bootstrap(username: string, password: string): Promise<void> {
      this.user = await api.bootstrap(username, password)
      this.state = 'authenticated'
    },
    async login(username: string, password: string): Promise<void> {
      this.user = await api.login(username, password)
      this.state = 'authenticated'
    },
    async logout(): Promise<void> {
      try {
        await api.logout()
      } catch {
        // Local sign-out must still complete if the session already expired or the server is down.
      } finally {
        this.user = null
        this.state = 'anonymous'
      }
    }
  }
})
