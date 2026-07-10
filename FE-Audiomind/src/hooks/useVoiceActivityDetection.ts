import { useEffect, useRef, useState } from 'react'
import { realtimeInfo } from '../utils/realtimeTelemetry'

export type VoiceActivityState = 'listening' | 'silent_paused' | 'listening_resumed'
export type MicSensitivityMode = 'low' | 'normal' | 'high'

export interface UseVoiceActivityDetectionOptions {
  enabled: boolean
  getRmsLevel: () => number | null | undefined
  silenceThreshold?: number
  speechThreshold?: number
  silenceDurationMs?: number
  resumeDurationMs?: number
  sampleIntervalMs?: number
  resumedLabelMs?: number
  dynamicEnabled?: boolean
  sensitivityMode?: MicSensitivityMode
  noiseCalibrationMs?: number
  hangoverMs?: number
}

export interface UseVoiceActivityDetectionResult {
  state: VoiceActivityState
}

type VadThresholds = {
  noiseFloor: number
  speechStartThreshold: number
  speechContinueThreshold: number
}

type SensitivityProfile = {
  minStartRms: number
  minContinueRms: number
  startRatio: number
  continueRatio: number
}

export const DEFAULT_VAD_SILENCE_THRESHOLD = 0.012
export const DEFAULT_VAD_SPEECH_THRESHOLD = 0.02
export const DEFAULT_VAD_SILENCE_DURATION_MS = 1500
export const DEFAULT_VAD_RESUME_DURATION_MS = 120
export const DEFAULT_VAD_SAMPLE_INTERVAL_MS = 100
export const DEFAULT_VAD_RESUMED_LABEL_MS = 900
export const DEFAULT_VAD_NOISE_CALIBRATION_MS = 800
export const DEFAULT_VAD_HANGOVER_MS = 400

const MIN_THRESHOLD = 0.002
const MAX_START_THRESHOLD = 0.08

const SENSITIVITY_PROFILES: Record<MicSensitivityMode, SensitivityProfile> = {
  low: {
    minStartRms: 0.01,
    minContinueRms: 0.006,
    startRatio: 3,
    continueRatio: 2,
  },
  normal: {
    minStartRms: 0.006,
    minContinueRms: 0.004,
    startRatio: 2.2,
    continueRatio: 1.5,
  },
  high: {
    minStartRms: 0.0035,
    minContinueRms: 0.0025,
    startRatio: 1.6,
    continueRatio: 1.2,
  },
}

const normalizeRms = (value: number | null | undefined): number | null => {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return null
  }
  return Math.max(0, value)
}

const clamp = (value: number, min: number, max: number): number => {
  return Math.min(max, Math.max(min, value))
}

export const normalizeMicSensitivityMode = (value?: string | null): MicSensitivityMode => {
  if (value === 'low' || value === 'high') {
    return value
  }
  return 'normal'
}

export const resolveVadThresholds = (
  noiseFloor: number,
  sensitivityMode: MicSensitivityMode,
  fallbackSilenceThreshold = DEFAULT_VAD_SILENCE_THRESHOLD,
  fallbackSpeechThreshold = DEFAULT_VAD_SPEECH_THRESHOLD,
): VadThresholds => {
  const profile = SENSITIVITY_PROFILES[sensitivityMode]
  const normalizedNoiseFloor = clamp(noiseFloor, 0, MAX_START_THRESHOLD)
  const speechStartThreshold = clamp(
    Math.max(profile.minStartRms, normalizedNoiseFloor * profile.startRatio),
    MIN_THRESHOLD,
    Math.max(MIN_THRESHOLD, Math.min(MAX_START_THRESHOLD, fallbackSpeechThreshold * 4)),
  )
  const rawContinueThreshold = Math.max(
    profile.minContinueRms,
    normalizedNoiseFloor * profile.continueRatio,
  )
  const maxContinueThreshold = Math.min(
    speechStartThreshold,
    Math.max(MIN_THRESHOLD, fallbackSilenceThreshold * 4),
  )
  const speechContinueThreshold = clamp(
    Math.min(rawContinueThreshold, speechStartThreshold * 0.85),
    MIN_THRESHOLD,
    maxContinueThreshold,
  )

  return {
    noiseFloor: normalizedNoiseFloor,
    speechStartThreshold,
    speechContinueThreshold,
  }
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
  dynamicEnabled = true,
  sensitivityMode = 'normal',
  noiseCalibrationMs = DEFAULT_VAD_NOISE_CALIBRATION_MS,
  hangoverMs = DEFAULT_VAD_HANGOVER_MS,
}: UseVoiceActivityDetectionOptions): UseVoiceActivityDetectionResult => {
  const [state, setState] = useState<VoiceActivityState>('listening')

  const stateRef = useRef<VoiceActivityState>('listening')
  const silenceStartMsRef = useRef<number | null>(null)
  const speechStartMsRef = useRef<number | null>(null)
  const resumeLabelTimerRef = useRef<number | null>(null)
  const calibrationStartedAtRef = useRef<number | null>(null)
  const calibrationSamplesRef = useRef<number[]>([])
  const thresholdsRef = useRef<VadThresholds>({
    noiseFloor: 0,
    speechStartThreshold: speechThreshold,
    speechContinueThreshold: silenceThreshold,
  })
  const lastSpeechAtMsRef = useRef<number | null>(null)

  const normalizedSensitivityMode = normalizeMicSensitivityMode(sensitivityMode)

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
    thresholdsRef.current = dynamicEnabled
      ? resolveVadThresholds(0, normalizedSensitivityMode, silenceThreshold, speechThreshold)
      : {
          noiseFloor: 0,
          speechStartThreshold: speechThreshold,
          speechContinueThreshold: silenceThreshold,
        }
    calibrationStartedAtRef.current = null
    calibrationSamplesRef.current = []
    lastSpeechAtMsRef.current = null
  }, [dynamicEnabled, normalizedSensitivityMode, silenceThreshold, speechThreshold])

  useEffect(() => {
    if (!enabled) {
      silenceStartMsRef.current = null
      speechStartMsRef.current = null
      calibrationStartedAtRef.current = null
      calibrationSamplesRef.current = []
      lastSpeechAtMsRef.current = null
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

      if (rms === null) {
        silenceStartMsRef.current = null
        speechStartMsRef.current = null
        return
      }

      if (dynamicEnabled && calibrationStartedAtRef.current === null) {
        calibrationStartedAtRef.current = now
      }

      if (dynamicEnabled && calibrationStartedAtRef.current !== null) {
        const calibrationElapsedMs = now - calibrationStartedAtRef.current
        if (calibrationElapsedMs <= noiseCalibrationMs) {
          calibrationSamplesRef.current.push(rms)
        } else if (calibrationSamplesRef.current.length > 0) {
          const samples = calibrationSamplesRef.current
          const noiseFloor = samples.reduce((sum, sample) => sum + sample, 0) / samples.length
          thresholdsRef.current = resolveVadThresholds(
            noiseFloor,
            normalizedSensitivityMode,
            silenceThreshold,
            speechThreshold,
          )
          calibrationSamplesRef.current = []
          realtimeInfo('[Realtime] VAD_CALIBRATED', {
            noiseFloor: Number(thresholdsRef.current.noiseFloor.toFixed(4)),
            speechStartThreshold: Number(thresholdsRef.current.speechStartThreshold.toFixed(4)),
            speechContinueThreshold: Number(thresholdsRef.current.speechContinueThreshold.toFixed(4)),
            sensitivityMode: normalizedSensitivityMode,
          })
        }
      }

      const { speechStartThreshold, speechContinueThreshold } = thresholdsRef.current
      const isSpeechStart = rms >= speechStartThreshold
      const isSpeechContinue = rms >= speechContinueThreshold

      if (isSpeechContinue) {
        lastSpeechAtMsRef.current = now
      }

      if (currentState === 'silent_paused') {
        if (isSpeechStart) {
          if (speechStartMsRef.current === null) {
            speechStartMsRef.current = now
          }
          if (now - speechStartMsRef.current >= resumeDurationMs) {
            silenceStartMsRef.current = null
            speechStartMsRef.current = null
            transitionTo('listening_resumed')
            realtimeInfo('[Realtime] VAD_RESUMED', {
              resumeMinSpeechMs: resumeDurationMs,
              sensitivityMode: normalizedSensitivityMode,
            })
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

      if (!isSpeechContinue) {
        const lastSpeechAt = lastSpeechAtMsRef.current
        if (lastSpeechAt !== null && now - lastSpeechAt < hangoverMs) {
          silenceStartMsRef.current = null
          return
        }

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
          realtimeInfo('[Realtime] VAD_PAUSED', {
            silenceDurationMs,
            sensitivityMode: normalizedSensitivityMode,
          })
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
    dynamicEnabled,
    enabled,
    getRmsLevel,
    hangoverMs,
    noiseCalibrationMs,
    normalizedSensitivityMode,
    resumedLabelMs,
    resumeDurationMs,
    sampleIntervalMs,
    silenceDurationMs,
    silenceThreshold,
    speechThreshold,
  ])

  return { state }
}
