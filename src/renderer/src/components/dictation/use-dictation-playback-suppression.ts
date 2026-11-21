import { useCallback, useEffect, useRef } from 'react'
import { toast } from 'sonner'
import { translate } from '@/i18n/i18n'
import type { VoiceSettings } from '../../../../shared/speech/speech-types'

type MutePreference = Pick<VoiceSettings, 'muteSystemAudioDuringDictation'> | undefined

export function useDictationPlaybackSuppression(): {
  /** False when the session was canceled while muting was being acquired. */
  acquire: (sessionId: string, voice: MutePreference) => Promise<boolean>
  release: (sessionId: string) => Promise<void>
} {
  const sessionIdsRef = useRef(new Set<string>())
  const warningShownRef = useRef(false)
  const restoreWarningShownRef = useRef(false)

  const acquire = useCallback(
    async (sessionId: string, voice: MutePreference): Promise<boolean> => {
      if (!voice?.muteSystemAudioDuringDictation) {
        return true
      }
      sessionIdsRef.current.add(sessionId)
      const result = await window.api.speech
        .acquirePlaybackSuppression(sessionId)
        .catch(() => ({ active: false as const, reason: 'unavailable' as const }))
      if (result.active) {
        return true
      }

      sessionIdsRef.current.delete(sessionId)
      if (result.reason === 'canceled') {
        return false
      }
      if (!warningShownRef.current) {
        warningShownRef.current = true
        toast.message(
          translate(
            'auto.components.dictation.DictationController.c97ad62022',
            'Could not mute other audio. Dictation will continue.'
          )
        )
      }
      return true
    },
    []
  )

  const release = useCallback(async (sessionId: string): Promise<void> => {
    if (!sessionIdsRef.current.delete(sessionId)) {
      return
    }
    try {
      await window.api.speech.releasePlaybackSuppression(sessionId)
    } catch {
      if (!restoreWarningShownRef.current) {
        restoreWarningShownRef.current = true
        toast.error(
          translate(
            'auto.components.dictation.DictationController.0080b89cf5',
            'Could not restore other audio. Unmute it in system controls.'
          )
        )
      }
    }
  }, [])

  useEffect(() => {
    const sessionIds = sessionIdsRef.current
    return () => {
      for (const sessionId of sessionIds) {
        void window.api.speech.releasePlaybackSuppression(sessionId).catch(() => undefined)
      }
      sessionIds.clear()
    }
  }, [])

  return { acquire, release }
}
