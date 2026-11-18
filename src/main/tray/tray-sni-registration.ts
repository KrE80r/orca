import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

/** Backoff between registration attempts (ms); ~1 minute in total. */
const RETRY_DELAYS_MS = [1_000, 2_000, 4_000, 8_000, 16_000, 30_000]

const WATCHER_ARGS = [
  'call',
  '--session',
  '--dest',
  'org.kde.StatusNotifierWatcher',
  '--object-path',
  '/StatusNotifierWatcher',
  '--method'
]

/**
 * Registers the Electron tray with KDE's StatusNotifierWatcher.
 * Electron registers with object path /StatusNotifierItem/1, but KDE expects
 * the bare service name. This workaround calls RegisterStatusNotifierItem
 * with the bare name so the icon appears in the Plasma panel.
 *
 * Linux-only. Safe to call multiple times (idempotent).
 */
export async function registerTrayWithSniWatcher(): Promise<void> {
  if (process.platform !== 'linux') {
    return
  }

  const serviceName = `org.freedesktop.StatusNotifierItem-${process.pid}-1`

  // Why: the watcher silently ignores a name Electron has not published yet, and Electron
  // publishes it asynchronously, so retry until the watcher actually lists the item.
  const attempt = async (retryIndex: number): Promise<void> => {
    try {
      await execFileAsync('gdbus', [
        ...WATCHER_ARGS,
        'org.kde.StatusNotifierWatcher.RegisterStatusNotifierItem',
        serviceName
      ])
      const { stdout } = await execFileAsync('gdbus', [
        ...WATCHER_ARGS,
        'org.freedesktop.DBus.Properties.Get',
        'org.kde.StatusNotifierWatcher',
        'RegisteredStatusNotifierItems'
      ])
      if (stdout.includes(`'${serviceName}/`)) {
        return
      }
    } catch (error) {
      if (
        typeof error === 'object' &&
        error !== null &&
        'code' in error &&
        error.code === 'ENOENT'
      ) {
        return // gdbus not installed: nothing to retry
      }
      console.warn('[tray-sni-registration] failed to register with watcher:', error)
    }
    const delay = RETRY_DELAYS_MS[retryIndex]
    if (delay === undefined) {
      console.warn('[tray-sni-registration] tray never appeared in StatusNotifierWatcher')
      return
    }
    setTimeout(() => void attempt(retryIndex + 1), delay).unref?.()
  }

  await attempt(0)
}
