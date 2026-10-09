/** What the band above the prompt shows; null shows nothing. */
export type Band = {
  tone: 'warm' | 'cold' | 'big' | 'saved'
  text: string
}

declare module 'claude-code' {
  interface PluginState {
    'session-guardian': { band: Band | null }
  }
}
