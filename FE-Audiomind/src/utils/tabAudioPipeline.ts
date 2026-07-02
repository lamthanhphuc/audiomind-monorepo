import { AUDIO_DEBUG_ENABLED } from '../services/config'

export const TAB_AUDIO_PIPELINE_MARKERS = {
  TRACK_STATE: 'TAB_TRACK_STATE',
  AUDIO_CONTEXT_STATE: 'TAB_AUDIO_CONTEXT_STATE',
  AUDIO_LEVEL: 'TAB_AUDIO_LEVEL',
  RECORDER_CHUNK: 'TAB_RECORDER_CHUNK',
  PIPELINE_STALLED: 'TAB_AUDIO_PIPELINE_STALLED',
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
  track: TabTrackSnapshot | null
  lastNonSilentAtMs: number | null
  elapsedSinceLastNonSilentMs: number | null
  chunkSeq: number
  chunkBytes: number
}

export type TabAudioPipelineMonitorOptions = {
  stream: MediaStream
  streamId?: TabAudioStreamRole
  meetingId?: number | null
  sessionId?: number
  audioContext?: AudioContext | null
  postGainAnalyser?: AnalyserNode | null
  levelIntervalMs?: number
  stallThresholdMs?: number
  silenceRmsThreshold?: number
  onTrackEnded?: (track: MediaStreamTrack) => void
  onTrackMuted?: (track: MediaStreamTrack) => void
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
  if (input.micPriority) {
    return {
      tabGain: input.tabDuckGain,
      micGain: input.micPassGain,
    }
  }
  return {
    tabGain: input.tabPassGain,
    micGain: input.micIdleGain,
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
    streamId = 'tab',
    meetingId = null,
    sessionId,
    audioContext = null,
    postGainAnalyser = null,
    levelIntervalMs = DEFAULT_LEVEL_INTERVAL_MS,
    stallThresholdMs = DEFAULT_STALL_THRESHOLD_MS,
    silenceRmsThreshold = DEFAULT_SILENCE_RMS_THRESHOLD,
    onTrackEnded,
    onTrackMuted,
    onPipelineStalled,
    onCaptureError,
  } = options

  const AudioContextCtor = window.AudioContext
    || (window as Window & { webkitAudioContext?: typeof AudioContext }).webkitAudioContext

  let inputContext: AudioContext | null = null
  let inputAnalyser: AnalyserNode | null = null
  let inputBuffer: Uint8Array | null = null
  let outputBuffer: Uint8Array | null = null
  let levelTimerId: number | null = null
  let contextWatchId: number | null = null
  let lastNonSilentAtMs: number | null = null
  let lastChunkSeq = 0
  let lastChunkBytes = 0
  let stallReported = false
  const trackHandlers = new Map<MediaStreamTrack, {
    ended: () => void
    mute: () => void
    unmute: () => void
  }>()

  const getPrimaryTrack = (): MediaStreamTrack | null =>
    stream.getAudioTracks().find((track) => track.readyState === 'live') ?? stream.getAudioTracks()[0] ?? null

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

  const maybeReportStall = (chunkSeq: number, chunkBytes: number) => {
    if (stallReported || !onPipelineStalled) {
      return
    }
    const inputRms = readInputRms()
    const outputRms = readOutputRms()
    const track = getPrimaryTrack()
    const silentOutput = isTabCaptureSilent(outputRms, silenceRmsThreshold)
    const silentInput = isTabCaptureSilent(inputRms, silenceRmsThreshold)
    const trackInactive = !track || track.readyState !== 'live' || track.muted || !track.enabled
    const elapsedSinceLastNonSilentMs = lastNonSilentAtMs === null
      ? null
      : performance.now() - lastNonSilentAtMs

    if (
      chunkBytes > 0
      && chunkSeq >= 3
      && silentOutput
      && (silentInput || trackInactive)
      && elapsedSinceLastNonSilentMs !== null
      && elapsedSinceLastNonSilentMs >= stallThresholdMs
    ) {
      stallReported = true
      const details: TabAudioStallDetails = {
        streamId,
        inputRms: inputRms ?? 0,
        outputRms,
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
      onPipelineStalled(details)
    }
  }

  const sampleLevels = () => {
    const inputRms = readInputRms()
    const outputRms = readOutputRms()
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
      })
    }

    void ensureAudioContextRunning(audioContext)
    void ensureAudioContextRunning(inputContext)

    if (track?.muted) {
      onCaptureError?.('Tab audio track is muted by the browser. Check that the captured tab is still playing audio.')
    }
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
      onCaptureError?.('Browser tab audio track ended. Re-select the tab to continue capture.')
    }
    const mute = () => {
      console.warn('[Realtime]', TAB_AUDIO_PIPELINE_MARKERS.TRACK_MUTED, {
        meetingId,
        sessionId,
        streamId,
        ...snapshotTabTrack(track),
      })
      onTrackMuted?.(track)
      onCaptureError?.('Browser tab audio was muted. Ensure the captured tab is still playing sound.')
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
    }

    trackHandlers.set(track, { ended, mute, unmute })
    track.addEventListener('ended', ended)
    track.addEventListener('mute', mute)
    track.addEventListener('unmute', unmute)
  }

  try {
    if (AudioContextCtor) {
      inputContext = new AudioContextCtor()
      const source = inputContext.createMediaStreamSource(stream)
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

  stream.getAudioTracks().forEach(attachTrack)
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
      lastChunkSeq = seq
      lastChunkBytes = bytes
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
        inputAnalyser?.disconnect()
      } catch {
        // ignore
      }
      void inputContext?.close().catch(() => {})
      inputContext = null
      inputAnalyser = null
      inputBuffer = null
      outputBuffer = null
    },
  }
}
