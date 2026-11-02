import { describe, expect, it, vi } from 'vitest'
import { ensureLiveConnection } from './connection-probe'

describe('ensureLiveConnection', () => {
  it('keeps a live socket and confirms it responds before an upload', async () => {
    const ping = vi.fn().mockResolvedValue({ ok: true })
    const reconnect = vi.fn()
    const waitUntilOpen = vi.fn().mockResolvedValue(undefined)

    await ensureLiveConnection({
      isOpen: () => true,
      ping,
      reconnect,
      waitUntilOpen,
    })

    expect(ping).toHaveBeenCalledTimes(1)
    expect(reconnect).not.toHaveBeenCalled()
  })

  it('redials a socket that still looks open after a transport-closed probe', async () => {
    let open = true
    const ping = vi.fn()
      .mockRejectedValueOnce(new Error('gateway not connected'))
      .mockResolvedValueOnce({ ok: true })
    const reconnect = vi.fn(async () => { open = true })

    await ensureLiveConnection({
      isOpen: () => open,
      ping,
      reconnect,
      waitUntilOpen: vi.fn().mockResolvedValue(undefined),
    })

    expect(reconnect).toHaveBeenCalledOnce()
    expect(ping).toHaveBeenCalledTimes(2)
  })

  it('waits for the normal reconnect when the close event already changed state', async () => {
    let open = true
    const ping = vi.fn()
      .mockImplementationOnce(async () => {
        open = false
        throw new Error('WebSocket closed')
      })
      .mockResolvedValueOnce({ ok: true })
    const waitUntilOpen = vi.fn(async () => { open = true })
    const reconnect = vi.fn()

    await ensureLiveConnection({
      isOpen: () => open,
      ping,
      reconnect,
      waitUntilOpen,
    })

    expect(waitUntilOpen).toHaveBeenCalledTimes(2)
    expect(reconnect).not.toHaveBeenCalled()
    expect(ping).toHaveBeenCalledTimes(2)
  })

  it('does not reconnect or retry for an application-level probe error', async () => {
    const error = new Error('permission denied')
    const ping = vi.fn().mockRejectedValue(error)
    const reconnect = vi.fn()

    await expect(ensureLiveConnection({
      isOpen: () => true,
      ping,
      reconnect,
      waitUntilOpen: vi.fn().mockResolvedValue(undefined),
    })).rejects.toBe(error)

    expect(ping).toHaveBeenCalledOnce()
    expect(reconnect).not.toHaveBeenCalled()
  })
})
