/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** Overrides the default WebSocket URL the frontend connects to (see ws.ts). */
  readonly VITE_WS_URL?: string
}

interface ImportMeta {
  readonly env: ImportMetaEnv
}
