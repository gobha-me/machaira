import { defineStore } from 'pinia'
import { api, onUnauthorized, type AuthUser } from '../services/api'

type AuthState = 'loading' | 'bootstrap' | 'anonymous' | 'authenticated'

export const useAuth = defineStore('auth', {
  state: () => ({
    state: 'loading' as AuthState,
    user: null as AuthUser | null
  }),
  getters: {
    authenticated: (state): boolean => state.state === 'authenticated' && state.user !== null,
    isAdmin: (state): boolean => state.user?.role === 'admin'
  },
  actions: {
    async initialize(): Promise<void> {
      onUnauthorized(() => {
        this.user = null
        this.state = 'anonymous'
      })
      try {
        const status = await api.authStatus()
        this.state = status.state
        this.user = status.state === 'authenticated' ? status.user : null
      } catch {
        this.user = null
        this.state = 'anonymous'
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
