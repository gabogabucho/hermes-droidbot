interface ConnectionProbe {
  isOpen: () => boolean
  ping: () => Promise<unknown>
  reconnect: () => Promise<void>
  waitUntilOpen: () => Promise<void>
}

const transportClosed = (error: unknown): boolean =>
  error instanceof Error && (error.message === 'WebSocket closed' || error.message === 'gateway not connected')

/** Confirm the gateway can answer before starting an attachment upload. */
export async function ensureLiveConnection({ isOpen, ping, reconnect, waitUntilOpen }: ConnectionProbe): Promise<void> {
  await waitUntilOpen()

  try {
    await ping()
  } catch (error) {
    if (!transportClosed(error)) throw error

    if (isOpen()) await reconnect()
    else await waitUntilOpen()

    await ping()
  }
}
