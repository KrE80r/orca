import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'

const { execFileAsyncMock } = vi.hoisted(() => ({
  execFileAsyncMock:
    vi.fn<(cmd: string, args: string[]) => Promise<{ stdout: string; stderr: string }>>()
}))

// Why: the module promisifies execFile; util.promisify.custom is this registered symbol, and
// vi.mock factories run before static imports, so reference it without importing node:util.
vi.mock('node:child_process', () => ({
  execFile: Object.assign(vi.fn(), {
    [Symbol.for('nodejs.util.promisify.custom')]: execFileAsyncMock
  })
}))

import { registerTrayWithSniWatcher } from './tray-sni-registration'

const ownItem = `org.freedesktop.StatusNotifierItem-${process.pid}-1`

/** Answers gdbus calls; `listed(n)` decides whether the n-th watcher query includes this tray. */
function respondWith(listed: (queryCount: number) => boolean): void {
  let queries = 0
  execFileAsyncMock.mockImplementation(async (_cmd, args) => {
    if (!args.includes('org.freedesktop.DBus.Properties.Get')) {
      return { stdout: '()\n', stderr: '' }
    }
    queries++
    // A different item sharing this PID's prefix must not count as registered.
    const items = [':1.80', `${ownItem}1`, ...(listed(queries) ? [ownItem] : [])]
    return {
      stdout: `(<[${items.map((item) => `'${item}/StatusNotifierItem'`).join(', ')}]>,)\n`,
      stderr: ''
    }
  })
}

function registerCalls(): string[][] {
  return execFileAsyncMock.mock.calls
    .map((call) => call[1])
    .filter((args) => args.includes('org.kde.StatusNotifierWatcher.RegisterStatusNotifierItem'))
}

describe('registerTrayWithSniWatcher', () => {
  const originalPlatform = process.platform

  beforeEach(() => {
    vi.clearAllMocks()
    vi.useFakeTimers()
    Object.defineProperty(process, 'platform', { value: 'linux' })
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
    Object.defineProperty(process, 'platform', { value: originalPlatform })
  })

  it('does nothing outside Linux', async () => {
    Object.defineProperty(process, 'platform', { value: 'darwin' })

    await registerTrayWithSniWatcher()

    expect(execFileAsyncMock).not.toHaveBeenCalled()
  })

  it('registers the bare service name and stops once the watcher lists it', async () => {
    respondWith(() => true)

    await registerTrayWithSniWatcher()
    await vi.advanceTimersByTimeAsync(120_000)

    expect(registerCalls()).toHaveLength(1)
    expect(registerCalls()[0].at(-1)).toBe(ownItem)
    expect(execFileAsyncMock.mock.calls[0][0]).toBe('gdbus')
  })

  it('retries with backoff until the watcher lists the item', async () => {
    respondWith((query) => query >= 3)

    await registerTrayWithSniWatcher()
    expect(registerCalls()).toHaveLength(1)

    await vi.advanceTimersByTimeAsync(1_000)
    expect(registerCalls()).toHaveLength(2)

    await vi.advanceTimersByTimeAsync(1_999)
    expect(registerCalls()).toHaveLength(2)
    await vi.advanceTimersByTimeAsync(1)
    expect(registerCalls()).toHaveLength(3)

    await vi.advanceTimersByTimeAsync(120_000)
    expect(registerCalls()).toHaveLength(3)
  })

  it('gives up with one warning when the item never appears', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    respondWith(() => false)

    await registerTrayWithSniWatcher()
    await vi.advanceTimersByTimeAsync(120_000)

    expect(registerCalls()).toHaveLength(7)
    expect(warn).toHaveBeenCalledTimes(1)
    expect(warn.mock.calls[0][0]).toContain('never appeared')
  })

  it('stops quietly when gdbus is not installed', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    execFileAsyncMock.mockRejectedValue(
      Object.assign(new Error('spawn gdbus ENOENT'), { code: 'ENOENT' })
    )

    await expect(registerTrayWithSniWatcher()).resolves.toBeUndefined()
    await vi.advanceTimersByTimeAsync(120_000)

    expect(execFileAsyncMock).toHaveBeenCalledTimes(1)
    expect(warn).not.toHaveBeenCalled()
  })

  it('warns and retries when the watcher call fails', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    execFileAsyncMock.mockRejectedValueOnce(
      Object.assign(new Error('watcher not ready'), { code: 1 })
    )
    respondWith(() => true)

    await registerTrayWithSniWatcher()
    expect(warn.mock.calls[0][0]).toContain('[tray-sni-registration]')

    // The rejected first attempt plus one retry, which succeeds and stops further attempts.
    await vi.advanceTimersByTimeAsync(1_000)
    expect(registerCalls()).toHaveLength(2)
    await vi.advanceTimersByTimeAsync(120_000)
    expect(registerCalls()).toHaveLength(2)
  })
})
