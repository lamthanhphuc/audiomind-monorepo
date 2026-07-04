import { AUDIO_DEBUG_ENABLED } from '../services/config'

export const TAB_AUDIO_PIPELINE_MARKERS = {
  TRACK_STATE: 'TAB_TRACK_STATE',
  AUDIO_CONTEXT_STATE: 'TAB_AUDIO_CONTEXT_STATE',
  AUDIO_LEVEL: 'TAB_AUDIO_LEVEL',
  RECORDER_CHUNK: 'TAB_RECORDER_CHUNK',
  PIPELINE_STALLED: 'TAB_AUDIO_PIPELINE_STALLED',
  PIPELINE_RECOVERY_ATTEMPTED: 'TAB_AUDIO_PIPELINE_RECOVERY_ATTEMPTED',
  SILENCE_DETECTED: 'TAB_AUDIO_SILENCE_DETECTED',
  TRACK_ENDED: 'TAB_AUDIO_TRACK_ENDED',
  TRACK_MUTED: 'TAB_AUDIO_TRACK_MUTED',
  TRACK_UNMUTED: 'TAB_AUDIO_TRACK_UNMUTED',
} as const

export type TabAudioStreamRole = 'tab' | 'mic' | 'mixed'

export type TabTrackSnapshot = {
  trackId: string
  readyState: MediaStreamTrackState
  muted: boolean
  enabled: boolean
  kind: string
}

export type TabAudioStallDetails = {
  streamId: TabAudioStreamRole
  inputRms: number
  outputRms: number | null
  mixedOutputRms?: number | null
  track: TabTrackSnapshot | null
  lastNonSilentAtMs: number | null
  elapsedSinceLastNonSilentMs: number | null
  chunkSeq: number
  chunkBytes: number
}

export type TabAudioPipelineMonitorOptions = {
  stream: MediaStream
  sourceStream?: MediaStream | null
  sourceTrack?: MediaStreamTrack | null
  streamId?: TabAudioStreamRole
  meetingId?: number | null
  sessionId?: number
  audioContext?: AudioContext | null
  preGainAnalyser?: AnalyserNode | null
  postGainAnalyser?: AnalyserNode | null
  mixedOutputAnalyser?: AnalyserNode | null
  tabGain?: GainNode | null
  minTabGain?: number
  levelIntervalMs?: number
  stallThresholdMs?: number
  silenceRmsThreshold?: number
  onTrackEnded?: (track: MediaStreamTrack) => void
  onTrackMuted?: (track: MediaStreamTrack) => void
  onTrackUnmuted?: (track: MediaStreamTrack) => void
  onPipelineStalled?: (details: TabAudioStallDetails) => void
  onCaptureError?: (message: string) => void
}

export type TabAudioPipelineMonitor = {
  notifyRecorderChunk: (chunk: { seq: number; bytes: number; elapsedMs: number }) => void
  getInputRms: () => number | null
  getOutputRms: () => number | null
  cleanup: () => void
}

const DEFAULT_LEVEL_INTERVAL_MS = 2000
const DEFAULT_STALL_THRESHOLD_MS = 8000
const DEFAULT_SILENCE_RMS_THRESHOLD = 0.004

export const shouldLogTabAudioPipeline = (): boolean =>
  AUDIO_DEBUG_ENABLED || import.meta.env.DEV

export const snapshotTabTrack = (track: MediaStreamTrack): TabTrackSnapshot => ({
  trackId: track.id,
  readyState: track.readyState,
  muted: track.muted,
  enabled: track.enabled,
  kind: track.kind,
})

export const measureAnalyserRms = (analyser: AnalyserNode, buffer: Uint8Array): number => {
  analyser.getByteTimeDomainData(buffer as Uint8Array<ArrayBuffer>)
  let sumSq = 0
  for (let i = 0; i < buffer.length; i += 1) {
    const centered = (buffer[i] - 128) / 128
    sumSq += centered * centered
  }
  return Math.sqrt(sumSq / buffer.length)
}

export const isTabCaptureSilent = (
  rms: number | null | undefined,
  threshold = DEFAULT_SILENCE_RMS_THRESHOLD,
): boolean => typeof rms !== 'number' || !Number.isFinite(rms) || rms <= threshold

export const resolveTabMicGateGains = (input: {
  micPriority: boolean
  tabPassGain: number
  tabDuckGain: number
  micPassGain: number
  micIdleGain: number
}): { tabGain: number; micGain: number } => {
  // Tab+Mic recording must never use mic activity as a hard source selector.
  // Keep both sources present in the STT mix; micPriority is diagnostic only.
  if (input.micPriority) {
    return {
      tabGain: Math.max(input.tabDuckGain, input.tabPassGain * 0.75),
      micGain: input.micPassGain,
    }
  }
  return {
    tabGain: input.tabPassGain,
    micGain: input.micPassGain,
  }
}

export const ensureAudioContextRunning = async (
  audioContext: AudioContext | null | undefined,
): Promise<AudioContextState | null> => {
  if (!audioContext) {
    return null
  }
  if (audioContext.state === 'suspended') {
    try {
      await audioContext.resume()
    } catch {
      // browser may reject resume without gesture
    }
  }
  return audioContext.state
}

export const createTabAudioPipelineMonitor = (
  options: TabAudioPipelineMonitorOptions,
): TabAudioPipelineMonitor => {
  const {
    stream,
    sourceStream = null,
    sourceTrack = null,
    streamId = 'tab',
    meetingId = null,
    sessionId,
    audioContext = null,
    preGainAnalyser = null,
    postGainAnalyser = null,
    mixedOutputAnalyser = null,
    tabGain = null,
    minTabGain = 0.01,
    levelIntervalMs = DEFAULT_LEVEL_INTERVAL_MS,
    stallThresholdMs = DEFAULT_STALL_THRESHOLD_MS,
    silenceRmsThreshold = DEFAULT_SILENCE_RMS_THRESHOLD,
    onTrackEnded,
    onTrackMuted,
    onTrackUnmuted,
    onPipelineStalled,
  } = options

  const AudioContextCtor = window.AudioContext
    || (window as Window & { webkitAudioContext?: typeof AudioContext }).webkitAudioContext

  let inputContext: AudioContext | null = null
  let inputAnalyser: AnalyserNode | null = preGainAnalyser
  let inputBuffer: Uint8Array | null = null
  let outputBuffer: Uint8Array | null = null
  let mixedOutputBuffer: Uint8Array | null = null
  let levelTimerId: number | null = null
  let contextWatchId: number | null = null
  let lastNonSilentAtMs: number | null = null
  let stallReported = false
  let silenceReported = false
  const monitorStream = sourceStream ?? stream
  const trackHandlers = new Map<MediaStreamTrack, {
    ended: () => void
    mute: () => void
    unmute: () => void
  }>()

  const getPrimaryTrack = (): MediaStreamTrack | null =>
    sourceTrack
    ?? monitorStream.getAudioTracks().find((track) => track.readyState === 'live')
    ?? monitorStream.getAudioTracks()[0]
    ?? null

  const getTracksToMonitor = (): MediaStreamTrack[] => {
    if (sourceTrack) {
      return [sourceTrack]
    }
    return monitorStream.getAudioTracks()
  }

  const readInputRms = (): number | null => {
    if (!inputAnalyser || !inputBuffer) {
      return null
    }
    return measureAnalyserRms(inputAnalyser, inputBuffer)
  }

  const readOutputRms = (): number | null => {
    if (!postGainAnalyser) {
      return readInputRms()
    }
    if (!outputBuffer || outputBuffer.length !== postGainAnalyser.fftSize) {
      outputBuffer = new Uint8Array(postGainAnalyser.fftSize)
    }
    return measureAnalyserRms(postGainAnalyser, outputBuffer)
  }

  const readMixedOutputRms = (): number | null => {
    if (!mixedOutputAnalyser) {
      return null
    }
    if (!mixedOutputBuffer || mixedOutputBuffer.length !== mixedOutputAnalyser.fftSize) {
      mixedOutputBuffer = new Uint8Array(mixedOutputAnalyser.fftSize)
    }
    return measureAnalyserRms(mixedOutputAnalyser, mixedOutputBuffer)
  }

  const logTrackState = (track: MediaStreamTrack, reason: string) => {
    if (!shouldLogTabAudioPipeline()) {
      return
    }
    console.info('[Realtime]', TAB_AUDIO_PIPELINE_MARKERS.TRACK_STATE, {
      meetingId,
      sessionId,
      streamId,
      reason,
      ...snapshotTabTrack(track),
    })
  }

  const logAudioContextState = (reason: string) => {
    if (!audioContext || !shouldLogTabAudioPipeline()) {
      return
    }
    console.info('[Realtime]', TAB_AUDIO_PIPELINE_MARKERS.AUDIO_CONTEXT_STATE, {
      meetingId,
      sessionId,
      streamId,
      reason,
      state: audioContext.state,
    })
  }

  const attemptPipelineRecovery = () => {
    void ensureAudioContextRunning(audioContext)
    void ensureAudioContextRunning(inputContext)
    if (tabGain && Number.isFinite(tabGain.gain.value) && tabGain.gain.value < minTabGain) {
      tabGain.gain.value = Math.max(minTabGain, 0.01)
    }
    lastNonSilentAtMs = performance.now()
    silenceReported = false
    if (shouldLogTabAudioPipeline()) {
      console.info('[Realtime]', TAB_AUDIO_PIPELINE_MARKERS.PIPELINE_RECOVERY_ATTEMPTED, {
        meetingId,
        sessionId,
        streamId,
        audioContextState: audioContext?.state ?? null,
        restoredTabGain: tabGain ? Number(tabGain.gain.value.toFixed(3)) : null,
      })
    }
  }

  const maybeReportStall = (chunkSeq: number, chunkBytes: number) => {
    if (stallReported) {
      return
    }
    const inputRms = readInputRms()
    const outputRms = readOutputRms()
    const mixedOutputRms = readMixedOutputRms()
    const track = getPrimaryTrack()
    const silentOutput = isTabCaptureSilent(outputRms, silenceRmsThreshold)
    const silentInput = isTabCaptureSilent(inputRms, silenceRmsThreshold)
    const trackEnded = !track || track.readyState !== 'live'
    const trackTemporarilyUnavailable = Boolean(track?.muted || track?.enabled === false)
    const elapsedSinceLastNonSilentMs = lastNonSilentAtMs === null
      ? null
      : performance.now() - lastNonSilentAtMs

    if (!silentInput || !silentOutput) {
      silenceReported = false
    }

    if (
      chunkBytes > 0
      && chunkSeq >= 3
      && silentInput
      && silentOutput
      && !trackEnded
      && !trackTemporarilyUnavailable
      && elapsedSinceLastNonSilentMs !== null
      && elapsedSinceLastNonSilentMs >= stallThresholdMs
    ) {
      if (!silenceReported && shouldLogTabAudioPipeline()) {
        silenceReported = true
        console.warn('[Realtime]', TAB_AUDIO_PIPELINE_MARKERS.SILENCE_DETECTED, {
          meetingId,
          sessionId,
          streamId,
          inputRms: inputRms ?? 0,
          outputRms,
          mixedOutputRms,
          elapsedSinceLastNonSilentMs,
          chunkSeq,
          chunkBytes,
        })
      }
      return
    }

    if (
      onPipelineStalled !== undefined
      &&
      chunkBytes > 0
      && chunkSeq >= 3
      && silentOutput
      && !silentInput
      && !trackEnded
      && elapsedSinceLastNonSilentMs !== null
      && elapsedSinceLastNonSilentMs >= stallThresholdMs
    ) {
      stallReported = true
      const details: TabAudioStallDetails = {
        streamId,
        inputRms: inputRms ?? 0,
        outputRms,
        mixedOutputRms,
        track: track ? snapshotTabTrack(track) : null,
        lastNonSilentAtMs,
        elapsedSinceLastNonSilentMs,
        chunkSeq,
        chunkBytes,
      }
      console.warn('[Realtime]', TAB_AUDIO_PIPELINE_MARKERS.PIPELINE_STALLED, {
        meetingId,
        sessionId,
        ...details,
      })
      attemptPipelineRecovery()
      onPipelineStalled(details)
    }
  }

  const sampleLevels = () => {
    const inputRms = readInputRms()
    const outputRms = readOutputRms()
    const mixedOutputRms = readMixedOutputRms()
    const track = getPrimaryTrack()

    if (!isTabCaptureSilent(outputRms, silenceRmsThreshold) || !isTabCaptureSilent(inputRms, silenceRmsThreshold)) {
      lastNonSilentAtMs = performance.now()
    }

    if (track) {
      logTrackState(track, 'interval')
    }
    logAudioContextState('interval')

    if (shouldLogTabAudioPipeline()) {
      console.info('[Realtime]', TAB_AUDIO_PIPELINE_MARKERS.AUDIO_LEVEL, {
        meetingId,
        sessionId,
        streamId,
        inputRms: inputRms === null ? null : Number(inputRms.toFixed(4)),
        outputRms: outputRms === null ? null : Number(outputRms.toFixed(4)),
        mixedOutputRms: mixedOutputRms === null ? null : Number(mixedOutputRms.toFixed(4)),
      })
    }

    void ensureAudioContextRunning(audioContext)
    void ensureAudioContextRunning(inputContext)

  }

  const attachTrack = (track: MediaStreamTrack) => {
    logTrackState(track, 'attach')
    const ended = () => {
      console.info('[Realtime]', TAB_AUDIO_PIPELINE_MARKERS.TRACK_ENDED, {
        meetingId,
        sessionId,
        streamId,
        ...snapshotTabTrack(track),
      })
      onTrackEnded?.(track)
    }
    const mute = () => {
      console.warn('[Realtime]', TAB_AUDIO_PIPELINE_MARKERS.TRACK_MUTED, {
        meetingId,
        sessionId,
        streamId,
        ...snapshotTabTrack(track),
      })
      onTrackMuted?.(track)
    }
    const unmute = () => {
      console.info('[Realtime]', TAB_AUDIO_PIPELINE_MARKERS.TRACK_UNMUTED, {
        meetingId,
        sessionId,
        streamId,
        ...snapshotTabTrack(track),
      })
      lastNonSilentAtMs = performance.now()
      stallReported = false
      silenceReported = false
      onTrackUnmuted?.(track)
    }

    trackHandlers.set(track, { ended, mute, unmute })
    track.addEventListener('ended', ended)
    track.addEventListener('mute', mute)
    track.addEventListener('unmute', unmute)
  }

  try {
    if (preGainAnalyser) {
      inputBuffer = new Uint8Array(preGainAnalyser.fftSize)
    } else if (AudioContextCtor) {
      inputContext = new AudioContextCtor()
      const source = inputContext.createMediaStreamSource(monitorStream)
      inputAnalyser = inputContext.createAnalyser()
      inputAnalyser.fftSize = 512
      inputBuffer = new Uint8Array(inputAnalyser.frequencyBinCount)
      source.connect(inputAnalyser)
      void ensureAudioContextRunning(inputContext)
    }
  } catch {
    inputContext = null
    inputAnalyser = null
    inputBuffer = null
  }

  getTracksToMonitor().forEach(attachTrack)
  lastNonSilentAtMs = performance.now()

  const onVisibilityChange = () => {
    if (document.visibilityState === 'visible') {
      void ensureAudioContextRunning(audioContext)
      void ensureAudioContextRunning(inputContext)
      logAudioContextState('visibility_visible')
    }
  }
  document.addEventListener('visibilitychange', onVisibilityChange)

  levelTimerId = window.setInterval(sampleLevels, Math.max(500, levelIntervalMs))
  contextWatchId = window.setInterval(() => {
    void ensureAudioContextRunning(audioContext)
    void ensureAudioContextRunning(inputContext)
  }, 1000)

  sampleLevels()

  return {
    getInputRms: readInputRms,
    getOutputRms: readOutputRms,
    notifyRecorderChunk: ({ seq, bytes, elapsedMs }) => {
      if (shouldLogTabAudioPipeline()) {
        console.info('[Realtime]', TAB_AUDIO_PIPELINE_MARKERS.RECORDER_CHUNK, {
          meetingId,
          sessionId,
          streamId,
          seq,
          bytes,
          elapsedMs,
        })
      }
      maybeReportStall(seq, bytes)
    },
    cleanup: () => {
      if (levelTimerId !== null) {
        window.clearInterval(levelTimerId)
      }
      if (contextWatchId !== null) {
        window.clearInterval(contextWatchId)
      }
      document.removeEventListener('visibilitychange', onVisibilityChange)
      trackHandlers.forEach((handlers, track) => {
        track.removeEventListener('ended', handlers.ended)
        track.removeEventListener('mute', handlers.mute)
        track.removeEventListener('unmute', handlers.unmute)
      })
      trackHandlers.clear()
      try {
        if (!preGainAnalyser) {
          inputAnalyser?.disconnect()
        }
      } catch {
        // ignore
      }
      void inputContext?.close().catch(() => {})
      inputContext = null
      inputAnalyser = null
      inputBuffer = null
      outputBuffer = null
      mixedOutputBuffer = null
    },
  }
}
