import { useEffect, useRef, useState } from 'react'

export type VoiceActivityState = 'listening' | 'silent_paused' | 'listening_resumed'

export interface UseVoiceActivityDetectionOptions {
  enabled: boolean
  getRmsLevel: () => number | null | undefined
  silenceThreshold?: number
  speechThreshold?: number
  silenceDurationMs?: number
  resumeDurationMs?: number
  sampleIntervalMs?: number
  resumedLabelMs?: number
}

export interface UseVoiceActivityDetectionResult {
  state: VoiceActivityState
}

export const DEFAULT_VAD_SILENCE_THRESHOLD = 0.012
export const DEFAULT_VAD_SPEECH_THRESHOLD = 0.02
export const DEFAULT_VAD_SILENCE_DURATION_MS = 2000
export const DEFAULT_VAD_RESUME_DURATION_MS = 300
export const DEFAULT_VAD_SAMPLE_INTERVAL_MS = 100
export const DEFAULT_VAD_RESUMED_LABEL_MS = 900

const normalizeRms = (value: number | null | undefined): number => {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return 0
  }
  return Math.max(0, value)
}

export const useVoiceActivityDetection = ({
  enabled,
  getRmsLevel,
  silenceThreshold = DEFAULT_VAD_SILENCE_THRESHOLD,
  speechThreshold = DEFAULT_VAD_SPEECH_THRESHOLD,
  silenceDurationMs = DEFAULT_VAD_SILENCE_DURATION_MS,
  resumeDurationMs = DEFAULT_VAD_RESUME_DURATION_MS,
  sampleIntervalMs = DEFAULT_VAD_SAMPLE_INTERVAL_MS,
  resumedLabelMs = DEFAULT_VAD_RESUMED_LABEL_MS,
}: UseVoiceActivityDetectionOptions): UseVoiceActivityDetectionResult => {
  const [state, setState] = useState<VoiceActivityState>('listening')

  const stateRef = useRef<VoiceActivityState>('listening')
  const silenceStartMsRef = useRef<number | null>(null)
  const speechStartMsRef = useRef<number | null>(null)
  const resumeLabelTimerRef = useRef<number | null>(null)

  const transitionTo = (nextState: VoiceActivityState) => {
    if (stateRef.current === nextState) {
      return
    }
    stateRef.current = nextState
    setState(nextState)
  }

  useEffect(() => {
    return () => {
      if (resumeLabelTimerRef.current !== null) {
        window.clearTimeout(resumeLabelTimerRef.current)
      }
    }
  }, [])

  useEffect(() => {
    if (!enabled) {
      silenceStartMsRef.current = null
      speechStartMsRef.current = null
      if (resumeLabelTimerRef.current !== null) {
        window.clearTimeout(resumeLabelTimerRef.current)
        resumeLabelTimerRef.current = null
      }
      transitionTo('listening')
      return
    }

    const tick = () => {
      const rms = normalizeRms(getRmsLevel())
      const now = Date.now()
      const currentState = stateRef.current

      if (currentState === 'silent_paused') {
        if (rms >= speechThreshold) {
          if (speechStartMsRef.current === null) {
            speechStartMsRef.current = now
          }
          if (now - speechStartMsRef.current >= resumeDurationMs) {
            silenceStartMsRef.current = null
            speechStartMsRef.current = null
            transitionTo('listening_resumed')
            if (resumeLabelTimerRef.current !== null) {
              window.clearTimeout(resumeLabelTimerRef.current)
              resumeLabelTimerRef.current = null
            }
            if (resumedLabelMs > 0) {
              resumeLabelTimerRef.current = window.setTimeout(() => {
                resumeLabelTimerRef.current = null
                if (stateRef.current === 'listening_resumed') {
                  transitionTo('listening')
                }
              }, resumedLabelMs)
            } else {
              transitionTo('listening')
            }
          }
        } else {
          speechStartMsRef.current = null
        }
        return
      }

      if (rms <= silenceThreshold) {
        if (silenceStartMsRef.current === null) {
          silenceStartMsRef.current = now
        }
        if (now - silenceStartMsRef.current >= silenceDurationMs) {
          speechStartMsRef.current = null
          if (resumeLabelTimerRef.current !== null) {
            window.clearTimeout(resumeLabelTimerRef.current)
            resumeLabelTimerRef.current = null
          }
          transitionTo('silent_paused')
        }
        return
      }

      silenceStartMsRef.current = null
    }

    tick()
    const intervalId = window.setInterval(tick, Math.max(16, sampleIntervalMs))

    return () => {
      window.clearInterval(intervalId)
      if (resumeLabelTimerRef.current !== null) {
        window.clearTimeout(resumeLabelTimerRef.current)
        resumeLabelTimerRef.current = null
      }
    }
  }, [
    enabled,
    getRmsLevel,
    resumedLabelMs,
    resumeDurationMs,
    sampleIntervalMs,
    silenceDurationMs,
    silenceThreshold,
    speechThreshold,
  ])

  return { state }
}
