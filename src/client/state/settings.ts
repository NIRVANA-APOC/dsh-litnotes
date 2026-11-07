/**
 * Settings store: preferences (host-persisted), MinerU token state, translator
 * providers and local-engine capabilities.
 *
 * Preference writes are optimistic: the store applies the patch immediately
 * (the reader must feel instant) and reconciles with the Host's normalized
 * result; a rejected write rolls back and surfaces a toast.
 */

import { create } from 'zustand'
import { getHostClient, ApiError } from '../api/client.ts'
import { DEFAULT_PREFERENCES, mergePreferences } from '../../shared/preferences.ts'
import type { LocalCapabilities, Preferences, SettingsValue } from '../../shared/model.ts'
import { adoptPersistedView, useUiStore } from './ui.ts'

/** Settings store shape. */
export interface SettingsState {
  loaded: boolean
  loading: boolean
  error: string | null
  preferences: Preferences
  tokenConfigured: boolean
  tokenPersistent: boolean
  providers: Array<{ id: string; label: string }>
  local: LocalCapabilities | null
  load: () => Promise<void>
  patch: (patch: Partial<Preferences>) => Promise<void>
  setToken: (token: string) => Promise<void>
  clearToken: () => Promise<void>
  /** Replace local state after the library store refreshes `settings.get`. */
  adopt: (value: SettingsValue) => void
}

/** The settings store. */
export const useSettingsStore = create<SettingsState>((set, get) => ({
  loaded: false,
  loading: false,
  error: null,
  preferences: { ...DEFAULT_PREFERENCES },
  tokenConfigured: false,
  tokenPersistent: true,
  providers: [],
  local: null,

  load: async () => {
    if (get().loading) return
    set({ loading: true, error: null })
    try {
      const value = await getHostClient().call('settings.get', {})
      get().adopt(value)
      adoptPersistedView(value.preferences)
    } catch (error) {
      const message = error instanceof ApiError ? error.message : String(error)
      set({ error: message })
    } finally {
      set({ loading: false })
    }
  },

  adopt: (value) => {
    set({
      loaded: true,
      preferences: value.preferences,
      tokenConfigured: value.tokenConfigured,
      tokenPersistent: value.tokenPersistent,
      providers: value.providers,
      local: value.local,
    })
  },

  patch: async (patch) => {
    const previous = get().preferences
    const optimistic = mergePreferences(previous, patch)
    set({ preferences: optimistic })
    try {
      const value = await getHostClient().call('settings.update', { preferences: optimistic })
      set({ preferences: value.preferences })
    } catch (error) {
      set({ preferences: previous })
      const message = error instanceof ApiError ? error.message : String(error)
      useUiStore.getState().toast(message, 'error')
    }
  },

  setToken: async (token) => {
    try {
      const value = await getHostClient().call('settings.setToken', { token })
      set({ tokenConfigured: value.tokenConfigured, tokenPersistent: value.tokenPersistent })
      useUiStore.getState().toast('令牌已保存', 'success')
    } catch (error) {
      const message = error instanceof ApiError ? error.message : String(error)
      useUiStore.getState().toast(message, 'error')
      throw error
    }
  },

  clearToken: async () => {
    try {
      const value = await getHostClient().call('settings.clearToken', {})
      set({ tokenConfigured: value.tokenConfigured, tokenPersistent: value.tokenPersistent })
      useUiStore.getState().toast('令牌已清除', 'success')
    } catch (error) {
      const message = error instanceof ApiError ? error.message : String(error)
      useUiStore.getState().toast(message, 'error')
    }
  },
}))
