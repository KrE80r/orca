import { ipcMain } from 'electron'
import { getPlaybackSuppressionService } from '../speech/speech-runtime-service'

const suppressionOwnersBySender = new Map<number, Set<string>>()
const suppressionCleanupRegistered = new Set<number>()

/** Owner id must match the dictation owner, so a destroyed renderer releases the same lease. */
export function registerSpeechPlaybackSuppressionHandlers(
  getDesktopOwner: (senderId: number, sessionId: string) => string
): void {
  // Why: a hard exit can bypass renderer cleanup; initialize the local audio
  // service at startup so a recent same-device mute is repaired immediately.
  void getPlaybackSuppressionService()
    .getCapability()
    .catch(() => undefined)

  ipcMain.handle('speech:getPlaybackSuppressionCapability', () => {
    return getPlaybackSuppressionService().getCapability()
  })

  ipcMain.handle('speech:acquirePlaybackSuppression', async (event, sessionId: string) => {
    const senderId = event.sender.id
    const owner = getDesktopOwner(senderId, sessionId)
    let owners = suppressionOwnersBySender.get(senderId)
    if (!owners) {
      owners = new Set()
      suppressionOwnersBySender.set(senderId, owners)
    }
    owners.add(owner)
    if (!suppressionCleanupRegistered.has(senderId)) {
      suppressionCleanupRegistered.add(senderId)
      event.sender.once('destroyed', () => {
        const staleOwners = suppressionOwnersBySender.get(senderId) ?? []
        suppressionOwnersBySender.delete(senderId)
        suppressionCleanupRegistered.delete(senderId)
        for (const staleOwner of staleOwners) {
          void getPlaybackSuppressionService()
            .release(staleOwner)
            .catch(() => undefined)
        }
      })
    }
    const result = await getPlaybackSuppressionService().acquire(owner)
    if (!result.active) {
      owners.delete(owner)
    }
    return result
  })

  ipcMain.handle('speech:releasePlaybackSuppression', async (event, sessionId: string) => {
    const senderId = event.sender.id
    const owner = getDesktopOwner(senderId, sessionId)
    suppressionOwnersBySender.get(senderId)?.delete(owner)
    await getPlaybackSuppressionService().release(owner)
  })
}
