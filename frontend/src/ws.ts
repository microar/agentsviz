/**
 * Minimal WebSocket client with automatic reconnect + exponential backoff.
 *
 * Connects to the event server's broadcast endpoint (see server/README.md,
 * `ws://localhost:<port>/ws`, default port 4000) and re-establishes the
 * connection whenever it drops, whether from a clean close, a network
 * error, or the server restarting.
 */

export type ConnectionStatus = 'connecting' | 'open' | 'closed'

export interface WsClientOptions {
  /** Called with every parsed JSON message received from the server. */
  onMessage: (data: unknown) => void
  /** Called whenever the connection status changes. */
  onStatusChange?: (status: ConnectionStatus) => void
  /** Base delay (ms) for the first reconnect attempt. Default 500ms. */
  initialRetryDelayMs?: number
  /** Maximum backoff delay (ms) between reconnect attempts. Default 15s. */
  maxRetryDelayMs?: number
}

export interface WsClient {
  /** Tears down the socket and stops any pending reconnect attempts. */
  disconnect: () => void
}

/**
 * Shared viewer token (issue #52). The event server requires a token on
 * the `/ws` handshake and the `/events/history` fetch; with no
 * `AGENTSVIZ_API_KEYS` configured server-side it accepts only this
 * built-in value, so this default keeps `npm run dev` working with no
 * setup. Override at build time with `VITE_AGENTSVIZ_TOKEN`.
 */
const DEV_FALLBACK_TOKEN = 'dev-local-token'

/** The viewer token to authenticate WS/history requests with. */
export function viewerToken(): string {
  const fromEnv = import.meta.env.VITE_AGENTSVIZ_TOKEN as string | undefined
  return fromEnv && fromEnv.length > 0 ? fromEnv : DEV_FALLBACK_TOKEN
}

/**
 * Returns `url` with the `token` query param set — browser `WebSocket`
 * clients can't send an `Authorization` header on the handshake, so the
 * token rides on the URL instead.
 */
export function withToken(url: string, token: string = viewerToken()): string {
  const base = typeof window !== 'undefined' ? window.location.href : 'http://localhost'
  try {
    const parsed = new URL(url, base)
    parsed.searchParams.set('token', token)
    return parsed.toString()
  } catch {
    const sep = url.includes('?') ? '&' : '?'
    return `${url}${sep}token=${encodeURIComponent(token)}`
  }
}

/** Resolves the default WebSocket URL for the event server, honoring VITE_WS_URL. */
export function defaultWsUrl(): string {
  const fromEnv = import.meta.env.VITE_WS_URL as string | undefined
  if (fromEnv) return fromEnv

  // Fall back to same-host dev default: server listens on port 4000 (see
  // server/README.md) with the broadcast endpoint mounted at /ws.
  const protocol = typeof window !== 'undefined' && window.location.protocol === 'https:' ? 'wss' : 'ws'
  const host = typeof window !== 'undefined' ? window.location.hostname : 'localhost'
  return `${protocol}://${host}:4000/ws`
}

/**
 * Opens a self-reconnecting WebSocket connection. Backoff doubles on each
 * consecutive failed/dropped attempt (with jitter), capped at
 * `maxRetryDelayMs`, and resets back to `initialRetryDelayMs` after a
 * successful connection.
 */
export function connectWebSocket(url: string, options: WsClientOptions): WsClient {
  const { onMessage, onStatusChange, initialRetryDelayMs = 500, maxRetryDelayMs = 15000 } = options

  let socket: WebSocket | null = null
  let retryDelay = initialRetryDelayMs
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null
  let stopped = false

  function setStatus(status: ConnectionStatus) {
    onStatusChange?.(status)
  }

  function scheduleReconnect() {
    if (stopped) return
    const jitter = Math.random() * 0.3 * retryDelay
    const delay = Math.min(retryDelay + jitter, maxRetryDelayMs)
    reconnectTimer = setTimeout(() => {
      retryDelay = Math.min(retryDelay * 2, maxRetryDelayMs)
      open()
    }, delay)
  }

  function open() {
    if (stopped) return
    setStatus('connecting')

    let ws: WebSocket
    try {
      ws = new WebSocket(url)
    } catch {
      scheduleReconnect()
      return
    }
    socket = ws

    ws.onopen = () => {
      retryDelay = initialRetryDelayMs
      setStatus('open')
    }

    ws.onmessage = (event) => {
      try {
        const parsed = JSON.parse(event.data as string)
        onMessage(parsed)
      } catch {
        // Ignore malformed frames rather than crashing the store.
      }
    }

    ws.onerror = () => {
      // The subsequent 'close' event drives reconnect; nothing to do here.
    }

    ws.onclose = () => {
      socket = null
      setStatus('closed')
      scheduleReconnect()
    }
  }

  open()

  return {
    disconnect: () => {
      stopped = true
      if (reconnectTimer) clearTimeout(reconnectTimer)
      socket?.close()
      socket = null
    },
  }
}
