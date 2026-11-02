import { atom } from 'nanostores'
import { t } from '../../i18n'
import { apiFetch } from '../api'
import { wsUrl } from '../config'
import { resolveAuth, type AuthState } from './auth'
import { getSessionToken } from './session-token'
import type { RpcMethods, BackendGatewayEventMap, GatewayEvent } from './rpc-types'
import { JsonRpcGatewayClient } from './vendor/json-rpc-gateway'
import type { ServerRequestHandler } from './vendor/json-rpc-channel'
import { ensureLiveConnection as ensureTransportLive } from './connection-probe'
import { reconnectBackoffDelayMs } from './vendor/reconnect-backoff'

export type ConnectionState = 'idle' | 'connecting' | 'open' | 'closed' | 'error'

// `prompt.submit` is fire-and-forget: completion arrives via `message.complete`
// events, not the RPC ACK. The ACK itself can take minutes, so bound it by the
// backend's agent-turn ceiling (apps/desktop/src/api/client.ts).
export const PROMPT_SUBMIT_TIMEOUT_MS = 1_800_000

export const connectionState = atom<ConnectionState>('idle')

let auth: AuthState | null = null
let wantOpen = false
let openedOnce = false
let backoffAttempt = 0
let reconnectTimer: ReturnType<typeof setTimeout> | null = null
let lastCloseCode: number | null = null
let dialing = false

// A ticket minted during the boot flow (parallel with `auth/me`), consumed by
// the FIRST dial only. Later (re)connects mint a fresh single-use ticket.
let preMintedTicket: string | null = null

const client = new JsonRpcGatewayClient({
  onSocketClose: event => {
    lastCloseCode = event.code
    return false
  },
})

client.onState(state => {
  connectionState.set(state)
  if (state === 'open') {
    openedOnce = true
    backoffAttempt = 0
  } else if ((state === 'closed' || state === 'error') && wantOpen) {
    scheduleReconnect()
  }
})

export function hasOpenedOnce(): boolean {
  return openedOnce
}

async function buildWsUrl(): Promise<string> {
  const base = wsUrl('/api/ws')
  const sep = base.includes('?') ? '&' : '?'

  if (auth?.mode === 'loopback') {
    return `${base}${sep}token=${encodeURIComponent(getSessionToken() ?? '')}`
  }

  // Gated: consume the boot-minted ticket once, else mint a fresh single-use
  // ticket on this connect (30 s TTL).
  let ticket = preMintedTicket
  preMintedTicket = null
  if (!ticket) {
    ;({ ticket } = await apiFetch<{ ticket: string }>('/api/auth/ws-ticket', {
      method: 'POST',
    }))
  }
  return `${base}${sep}ticket=${encodeURIComponent(ticket)}`
}

async function dial(): Promise<boolean> {
  if (auth?.mode === 'unreachable') {
    connectionState.set('error')
    return false
  }
  if (auth?.mode === 'gated-anonymous') {
    connectionState.set('closed')
    return false
  }

  try {
    const url = await buildWsUrl()
    await client.connect(url)
    return true
  } catch {
    // The client has already moved to 'closed'/'error' via onState.
    return false
  }
}

function scheduleReconnect(): void {
  if (reconnectTimer || !wantOpen) return
  const delay = reconnectBackoffDelayMs(backoffAttempt, { baseDelayMs: 1_000, capMs: 30_000 })
  backoffAttempt += 1
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null
    void runReconnect()
  }, delay)
}

function clearReconnectTimer(): void {
  if (reconnectTimer) {
    clearTimeout(reconnectTimer)
    reconnectTimer = null
  }
}

async function runReconnect(): Promise<void> {
  if (!wantOpen || dialing) return
  dialing = true

  try {
    // Close code 4401 = auth rejection (tui_gateway/chat_ws.py). Re-resolve auth
    // before retrying; if we became anonymous, stop and let the UI show login.
    // The boot ticket died with the rejection too — a retry mints a fresh one.
    if (lastCloseCode === 4401) {
      lastCloseCode = null
      preMintedTicket = null
      auth = await resolveAuth()
    }

    if (!auth) {
      auth = await resolveAuth()
    }

    const ok = await dial()
    if (!ok && wantOpen && auth?.mode !== 'gated-anonymous') {
      scheduleReconnect()
    }
  } finally {
    dialing = false
  }
}

/**
 * Open (or reopen) the gateway connection. Pass the auth already resolved by
 * the boot flow (so `resolveAuth`'s `/api/auth/me` never runs twice) and the
 * ticket minted in parallel with it (a `null` ticket means "mint on dial").
 */
export async function connect(state?: AuthState, preTicket: string | null = null): Promise<void> {
  wantOpen = true
  if (state) auth = state
  if (preTicket) preMintedTicket = preTicket
  await runReconnect()
}

/** Close on purpose; stops the reconnect loop. */
export function close(): void {
  wantOpen = false
  clearReconnectTimer()
  client.close()
}

const OPEN_WAIT_MS = 20_000

/** Resolve once the socket is open, so callers don't race the (re)connect. */
function whenOpen(): Promise<void> {
  if (connectionState.get() === 'open') return Promise.resolve()
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      unsubscribe()
      reject(new Error(t('common.noConnection')))
    }, OPEN_WAIT_MS)
    const unsubscribe = connectionState.listen(state => {
      if (state !== 'open') return
      clearTimeout(timer)
      unsubscribe()
      resolve()
    })
  })
}

/** Typed RPC request over the gateway. Waits for the socket to be open first. */
export async function request<M extends keyof RpcMethods>(
  method: M,
  params: RpcMethods[M]['params'],
  timeoutMs?: number,
): Promise<RpcMethods[M]['result']> {
  await whenOpen()
  const budget = method === 'prompt.submit' ? PROMPT_SUBMIT_TIMEOUT_MS : timeoutMs
  return client.request<RpcMethods[M]['result']>(
    method,
    params as Record<string, unknown>,
    budget,
  )
}

/** Subscribe to a typed gateway event. */
export function on<E extends keyof BackendGatewayEventMap>(
  type: E,
  handler: (event: GatewayEvent<E>) => void,
): () => void {
  return client.on(type, handler)
}

/** Subscribe to every gateway event. */
export function onAny(handler: (event: GatewayEvent) => void): () => void {
  return client.onAny(handler)
}

/**
 * Register a handler for server→client requests (approval, clarify, sudo,
 * secret, …). The vendored channel already advertises `client.capabilities
 * {server_requests:true}` on connect; this just routes inbound requests to
 * callers. Handlers are tried in registration order until one accepts.
 */
export function onRequest(handler: ServerRequestHandler): () => void {
  return client.onRequest(handler)
}

export type { ServerRequest } from './vendor/json-rpc-channel'

// Immediate reconnect on network return / tab becoming visible.
window.addEventListener('online', wake)

// Back from the background: Android freezes the page's timers, so the heartbeat
// can't notice that the server dropped the socket meanwhile. The socket still
// says "open" (a zombie) and events are lost for up to 45 s — the reply never
// shows until the chat is reopened. After more than a few seconds away, don't
// trust it: drop and redial now (~1 s); the open chat then resyncs itself.
const STALE_AFTER_HIDDEN_MS = 8_000
let hiddenAt = 0
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'hidden') {
    hiddenAt = Date.now()
    return
  }
  const away = hiddenAt ? Date.now() - hiddenAt : 0
  hiddenAt = 0
  if (wantOpen && connectionState.get() === 'open' && away > STALE_AFTER_HIDDEN_MS) {
    refreshSocket()
    return
  }
  wake()
})

/** Drop the current socket and dial a fresh one right away (no backoff). */
function refreshSocket(): void {
  client.close()
  clearReconnectTimer()
  backoffAttempt = 0
  void runReconnect()
}

/** Probe and, only on a transport-close error, restore the gateway before upload. */
export async function ensureConnectionForAttachment(): Promise<void> {
  await ensureTransportLive({
    isOpen: () => connectionState.get() === 'open',
    // Hermes answers gateway.ping before normal RPC dispatch; it has no side effect.
    ping: () => client.request('gateway.ping', {}, 5_000),
    reconnect: async () => {
      refreshSocket()
      await whenOpen()
    },
    waitUntilOpen: whenOpen,
  })
}

function wake(): void {
  if (!wantOpen || connectionState.get() === 'open') return
  clearReconnectTimer()
  backoffAttempt = 0
  void runReconnect()
}
