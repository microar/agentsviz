/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** Overrides the default WebSocket URL the frontend connects to (see ws.ts). */
  readonly VITE_WS_URL?: string
  /**
   * Viewer token sent on the `/ws` handshake and the `/events/history`
   * fetch (issue #52). Defaults to the shared local-dev token when unset.
   */
  readonly VITE_AGENTSVIZ_TOKEN?: string
}

interface ImportMeta {
  readonly env: ImportMetaEnv
}
