import type { RecordingSource } from '../constants/recordingSource'
import { BROWSER_TAB_CAPTURE_TELEMETRY, RECORDING_SOURCE_ERRORS } from '../constants/recordingSource'
import {
  ensureAudioContextRunning,
  measureAnalyserRms,
  resolveTabMicGateGains,
} from './tabAudioPipeline'
import { realtimeInfo, realtimeWarn } from './realtimeTelemetry'

export type AudioSourceErrorCode =
  | 'permission_denied'
  | 'not_supported'
  | 'no_audio_track'
  | 'cancelled'
  | 'unknown'

export class AudioSourceError extends Error {
  readonly code: AudioSourceErrorCode

  constructor(message: string, code: AudioSourceErrorCode) {
    super(message)
    this.name = 'AudioSourceError'
    this.code = code
  }
}

export type AcquiredAudioSource = {
  stream: MediaStream
  cleanup: () => void
  source: RecordingSource
  tabMixerHandles?: TabMicMixerHandles
}

type AcquireAudioSourceOptions = {
  source: RecordingSource
  noiseSuppressionEnabled?: boolean
  meetingId?: number | null
}

const PREFERRED_SAMPLE_RATE = 48_000

type DisplayMediaAudioConstraints = MediaTrackConstraints & {
  /** Chrome/Edge-specific hint. Keep local playback audible unless the user/browser decides otherwise. */
  suppressLocalAudioPlayback?: boolean
}

const buildTabCaptureConstraints = (): DisplayMediaStreamOptions => ({
  video: true,
  audio: {
    echoCancellation: false,
    noiseSuppression: false,
    autoGainControl: false,
    suppressLocalAudioPlayback: false,
  } as DisplayMediaAudioConstraints,
})

const prepareTabAudioTracks = (stream: MediaStream): void => {
  stream.getAudioTracks().forEach((track) => {
    track.enabled = true
  })
}

const isNoiseSuppressionConstraintSupported = (): boolean =>
  Boolean(navigator.mediaDevices?.getSupportedConstraints?.().noiseSuppression)

export type MicrophoneAcquisitionOptions = {
  noiseSuppressionEnabled?: boolean
  /** Mic-only / dual default true. Mixed mode keeps false for RMS/gate compatibility. */
  echoCancellationEnabled?: boolean
  /** Mic-only / dual default true. Mixed mode keeps false for RMS/gate compatibility. */
  autoGainControlEnabled?: boolean
}

const buildMicrophoneConstraints = (
  options: MicrophoneAcquisitionOptions = {},
): MediaStreamConstraints => {
  const noiseSuppressionEnabled = options.noiseSuppressionEnabled !== false
  const echoCancellationEnabled = options.echoCancellationEnabled !== false
  const autoGainControlEnabled = options.autoGainControlEnabled !== false
  const audio: MediaTrackConstraints = {
    echoCancellation: echoCancellationEnabled,
    autoGainControl: autoGainControlEnabled,
    channelCount: 1,
    sampleRate: { ideal: PREFERRED_SAMPLE_RATE },
  }

  if (isNoiseSuppressionConstraintSupported()) {
    audio.noiseSuppression = noiseSuppressionEnabled
  }

  return { audio }
}

const stopTracks = (stream: MediaStream | null | undefined) => {
  stream?.getTracks().forEach((track) => {
    try {
      track.stop()
    } catch {
      // ignore cleanup errors
    }
  })
}

const resolveCaptureError = (error: unknown, source: RecordingSource): AudioSourceError => {
  const resolvedName = error instanceof DOMException
    ? error.name
    : error instanceof Error
      ? error.name
      : undefined

  if (resolvedName === 'NotAllowedError' || resolvedName === 'PermissionDeniedError') {
    if (source === 'microphone') {
      return new AudioSourceError(
        RECORDING_SOURCE_ERRORS.micPermissionDenied,
        'permission_denied',
      )
    }
    return new AudioSourceError(
      RECORDING_SOURCE_ERRORS.tabPermissionDenied,
      'permission_denied',
    )
  }

  if (resolvedName === 'NotFoundError') {
    return new AudioSourceError(
      source === 'microphone'
        ? 'Không tìm thấy thiết bị microphone khả dụng.'
        : 'Không tìm thấy tab phù hợp để chia sẻ âm thanh.',
      'not_supported',
    )
  }

  if (resolvedName === 'NotSupportedError' || resolvedName === 'TypeError') {
    return new AudioSourceError(
      source === 'microphone'
        ? 'Trình duyệt không hỗ trợ ghi âm WebM/Opus.'
        : 'Trình duyệt không hỗ trợ chia sẻ âm thanh tab. Hãy dùng Chrome hoặc Edge mới nhất.',
      'not_supported',
    )
  }

  if (resolvedName === 'AbortError') {
    return new AudioSourceError(
      RECORDING_SOURCE_ERRORS.tabPickerCancelled,
      'cancelled',
    )
  }

  if (error instanceof AudioSourceError) {
    return error
  }

  if (error instanceof Error && error.message.trim()) {
    return new AudioSourceError(error.message, 'unknown')
  }

  return new AudioSourceError('Không thể khởi tạo nguồn âm thanh. Vui lòng thử lại.', 'unknown')
}

const validateBrowserTabAudioTracks = (stream: MediaStream): void => {
  const audioTracks = stream.getAudioTracks()
  if (audioTracks.length === 0) {
    realtimeWarn('[Realtime]', BROWSER_TAB_CAPTURE_TELEMETRY.MISSING, {
      videoTracks: stream.getVideoTracks().length,
    })
    stopTracks(stream)
    throw new AudioSourceError(
      RECORDING_SOURCE_ERRORS.tabNoAudioTrack,
      'no_audio_track',
    )
  }

  const liveTrack = audioTracks.find((track) => track.readyState === 'live')
  if (!liveTrack) {
    realtimeWarn('[Realtime]', BROWSER_TAB_CAPTURE_TELEMETRY.MISSING, {
      reason: 'no_live_audio_track',
    })
    stopTracks(stream)
    throw new AudioSourceError(
      RECORDING_SOURCE_ERRORS.tabNoAudioTrack,
      'no_audio_track',
    )
  }

  realtimeInfo('[Realtime]', BROWSER_TAB_CAPTURE_TELEMETRY.TRACK_READY, {
    trackCount: audioTracks.length,
    muted: liveTrack.muted,
    enabled: liveTrack.enabled,
    label: liveTrack.label,
  })
}

const discardDisplayVideoTracks = (stream: MediaStream) => {
  stream.getVideoTracks().forEach((track) => {
    track.stop()
    stream.removeTrack(track)
  })
}

const acquireMicrophoneStream = async (
  options: MicrophoneAcquisitionOptions = {},
): Promise<MediaStream> => {
  if (!navigator.mediaDevices?.getUserMedia) {
    throw new AudioSourceError('Trình duyệt không hỗ trợ getUserMedia cho microphone.', 'not_supported')
  }
  return navigator.mediaDevices.getUserMedia(buildMicrophoneConstraints(options))
}

const acquireBrowserTabStream = async (): Promise<MediaStream> => {
  if (!navigator.mediaDevices?.getDisplayMedia) {
    throw new AudioSourceError(
      'Trình duyệt không hỗ trợ chia sẻ âm thanh tab. Hãy dùng Chrome hoặc Edge mới nhất.',
      'not_supported',
    )
  }

  realtimeInfo('[Realtime]', BROWSER_TAB_CAPTURE_TELEMETRY.STARTED)
  const stream = await navigator.mediaDevices.getDisplayMedia(buildTabCaptureConstraints())
  prepareTabAudioTracks(stream)
  discardDisplayVideoTracks(stream)
  validateBrowserTabAudioTracks(stream)
  return stream
}

export type TabMicMixerHandles = {
  audioContext: AudioContext
  mixedStream: MediaStream
  sourceTabStream: MediaStream
  sourceMicStream: MediaStream | null
  sourceTabTrack: MediaStreamTrack | null
  micAnalyser: AnalyserNode | null
  tabAnalyser: AnalyserNode
  tabPostGainAnalyser: AnalyserNode
  outputAnalyser: AnalyserNode
  tabGain: GainNode
  tabDuckGain: number
  cleanupGraph: () => void
}

type CreateTabMicMixOptions = {
  /** When true, cleanupGraph also stops mic tracks (mixed single-stream ownership). Dual keeps false. */
  stopMicTracksOnCleanup?: boolean
}

/**
 * Mix existing tab + mic streams without re-acquiring microphone.
 * cleanupGraph disconnects nodes and closes AudioContext but does not stop tab tracks.
 */
export const createTabMicMixFromStreams = async (
  tabStream: MediaStream,
  micStream: MediaStream,
  options: CreateTabMicMixOptions = {},
): Promise<TabMicMixerHandles> => {
  const stopMicTracksOnCleanup = options.stopMicTracksOnCleanup === true
  const AudioContextCtor = window.AudioContext
    || (window as Window & { webkitAudioContext?: typeof AudioContext }).webkitAudioContext

  if (!AudioContextCtor) {
    throw new AudioSourceError('Trình duyệt không hỗ trợ Web Audio API để mix tab + mic.', 'not_supported')
  }

  let audioContext: AudioContext | null = null
  let rafId = 0
  let contextWatchId = 0
  let onVisibilityChange: (() => void) | null = null
  const connectedNodes: AudioNode[] = []

  const rollbackPartialMixer = () => {
    if (rafId) {
      window.cancelAnimationFrame(rafId)
      rafId = 0
    }
    if (contextWatchId) {
      window.clearInterval(contextWatchId)
      contextWatchId = 0
    }
    if (onVisibilityChange) {
      document.removeEventListener('visibilitychange', onVisibilityChange)
      onVisibilityChange = null
    }
    for (const node of connectedNodes) {
      try {
        node.disconnect()
      } catch {
        // ignore
      }
    }
    connectedNodes.length = 0
    if (audioContext) {
      const context = audioContext
      audioContext = null
      void context.close().catch(() => {})
    }
  }

  try {
    audioContext = new AudioContextCtor()
    const destination = audioContext.createMediaStreamDestination()
    const tabSource = audioContext.createMediaStreamSource(tabStream)
    const micSource = audioContext.createMediaStreamSource(micStream)
    connectedNodes.push(tabSource, micSource, destination)

    // Stable mix: mic activity is diagnostic only and must never mute tab audio.
    const TAB_PASS_GAIN = 0.5
    const TAB_DUCK_GAIN = 0.42
    const MIC_PASS_GAIN = 1.15
    const MIC_IDLE_GAIN = MIC_PASS_GAIN
    const MIC_ENTER_RMS = 0.013
    const MIC_SUSTAIN_RMS = 0.01
    const MIC_VS_TAB_ENTER_RATIO = 0.28
    const QUIET_TAB_RMS = 0.02
    const SPEECH_HOLD_MS = 3000
    const MIN_MIC_WINDOW_MS = 900
    const GATE_ARM_DELAY_MS = 500
    const GAIN_RELEASE = 0.06
    const mixReadyAt = performance.now()

    const tabGain = audioContext.createGain()
    const micGain = audioContext.createGain()
    tabGain.gain.value = TAB_PASS_GAIN
    micGain.gain.value = MIC_IDLE_GAIN
    connectedNodes.push(tabGain, micGain)

    const micAnalyser = audioContext.createAnalyser()
    micAnalyser.fftSize = 512
    const micAnalyserData = new Uint8Array(micAnalyser.frequencyBinCount)
    const tabAnalyser = audioContext.createAnalyser()
    tabAnalyser.fftSize = 512
    const tabAnalyserData = new Uint8Array(tabAnalyser.frequencyBinCount)
    const tabPostGainAnalyser = audioContext.createAnalyser()
    tabPostGainAnalyser.fftSize = 512
    const tabPostGainAnalyserData = new Uint8Array(tabPostGainAnalyser.frequencyBinCount)
    const outputAnalyser = audioContext.createAnalyser()
    outputAnalyser.fftSize = 512
    connectedNodes.push(micAnalyser, tabAnalyser, tabPostGainAnalyser, outputAnalyser)

    let micPriorityActive = false
    let lastMicSpeechAt = 0
    let micWindowStartedAt = 0
    let micActiveMs = 0
    let tabActiveMs = 0
    let lastTickAt = performance.now()
    let lastStatsAt = performance.now()

    const tick = () => {
      try {
        const micRms = measureAnalyserRms(micAnalyser, micAnalyserData)
        const tabRms = measureAnalyserRms(tabAnalyser, tabAnalyserData)
        const tabPostGainRms = measureAnalyserRms(tabPostGainAnalyser, tabPostGainAnalyserData)
        const now = performance.now()
        const deltaMs = now - lastTickAt
        lastTickAt = now

        const inMicHold = now - lastMicSpeechAt < SPEECH_HOLD_MS
        const tabQuiet = tabRms < QUIET_TAB_RMS
        const micDominatesTab = micRms >= tabRms * MIC_VS_TAB_ENTER_RATIO
        const gateArmed = now - mixReadyAt >= GATE_ARM_DELAY_MS
        const canEnterMic = gateArmed && micRms >= MIC_ENTER_RMS && (tabQuiet || micDominatesTab)
        const canSustainMic = inMicHold && micRms >= MIC_SUSTAIN_RMS

        if (canEnterMic || canSustainMic) {
          lastMicSpeechAt = now
        }

        let micPriority = now - lastMicSpeechAt < SPEECH_HOLD_MS
        if (micPriority && !micPriorityActive) {
          micWindowStartedAt = now
        }
        if (micPriorityActive && !micPriority && now - micWindowStartedAt < MIN_MIC_WINDOW_MS) {
          micPriority = true
        }

        const targetGains = resolveTabMicGateGains({
          micPriority,
          tabPassGain: TAB_PASS_GAIN,
          tabDuckGain: TAB_DUCK_GAIN,
          micPassGain: MIC_PASS_GAIN,
          micIdleGain: MIC_IDLE_GAIN,
        })
        tabGain.gain.value += (targetGains.tabGain - tabGain.gain.value) * GAIN_RELEASE
        micGain.gain.value += (targetGains.micGain - micGain.gain.value) * GAIN_RELEASE
        if (tabGain.gain.value < TAB_DUCK_GAIN) {
          tabGain.gain.value = TAB_DUCK_GAIN
        }
        if (micGain.gain.value <= 0) {
          micGain.gain.value = MIC_PASS_GAIN
        }
        if (micPriority) {
          micActiveMs += deltaMs
        } else {
          tabActiveMs += deltaMs
        }

        if (micPriority !== micPriorityActive) {
          micPriorityActive = micPriority
          realtimeInfo('[Realtime] TAB_MIC_GATE', {
            activeSource: micPriority ? 'microphone' : 'browser_tab',
            policy: 'stable_mix',
            micRms: Number(micRms.toFixed(4)),
            tabInputRms: Number(tabRms.toFixed(4)),
            tabPostGainRms: Number(tabPostGainRms.toFixed(4)),
            tabGain: Number(tabGain.gain.value.toFixed(3)),
            micGain: Number(micGain.gain.value.toFixed(3)),
            holdMs: micPriority ? SPEECH_HOLD_MS : 0,
            reason: micPriority ? 'mic_detected_without_tab_mute' : 'tab_default',
          })
        }

        if (now - lastStatsAt >= 5000) {
          micActiveMs = 0
          tabActiveMs = 0
          lastStatsAt = now
        }
      } catch {
        // ignore sampling errors
      }
      rafId = window.requestAnimationFrame(tick)
    }

    tabSource.connect(tabGain)
    tabGain.connect(tabPostGainAnalyser)
    tabGain.connect(destination)
    tabGain.connect(outputAnalyser)
    micSource.connect(micGain)
    micGain.connect(destination)
    micGain.connect(outputAnalyser)
    micSource.connect(micAnalyser)
    tabSource.connect(tabAnalyser)
    rafId = window.requestAnimationFrame(tick)

    const resumeMixerContext = () => {
      if (audioContext) {
        void ensureAudioContextRunning(audioContext)
      }
    }
    onVisibilityChange = () => {
      if (document.visibilityState === 'visible') {
        resumeMixerContext()
      }
    }
    document.addEventListener('visibilitychange', onVisibilityChange)
    contextWatchId = window.setInterval(resumeMixerContext, 1000)
    await ensureAudioContextRunning(audioContext)

    const mixedStream = destination.stream
    realtimeInfo('[Realtime] TAB_MIC_MIX_READY', {
      contextState: audioContext.state,
      mode: 'stable_mix',
      tabPassGain: TAB_PASS_GAIN,
      tabMinGain: TAB_DUCK_GAIN,
      micPassGain: MIC_PASS_GAIN,
      suppressLocalAudioPlayback: false,
      mixedTrackCount: mixedStream.getAudioTracks().length,
    })

    const settledContext = audioContext
    audioContext = null
    const cleanupGraph = () => {
      if (rafId) {
        window.cancelAnimationFrame(rafId)
        rafId = 0
      }
      if (contextWatchId) {
        window.clearInterval(contextWatchId)
        contextWatchId = 0
      }
      if (onVisibilityChange) {
        document.removeEventListener('visibilitychange', onVisibilityChange)
        onVisibilityChange = null
      }
      for (const node of [tabSource, micSource, tabGain, micGain, micAnalyser, tabAnalyser, tabPostGainAnalyser, outputAnalyser]) {
        try {
          node.disconnect()
        } catch {
          // ignore
        }
      }
      if (stopMicTracksOnCleanup) {
        stopTracks(micStream)
      }
      void settledContext.close().catch(() => {})
    }

    return {
      audioContext: settledContext,
      mixedStream,
      sourceTabStream: tabStream,
      sourceMicStream: micStream,
      sourceTabTrack: tabStream.getAudioTracks()[0] ?? null,
      micAnalyser,
      tabAnalyser,
      tabPostGainAnalyser,
      outputAnalyser,
      tabGain,
      tabDuckGain: TAB_DUCK_GAIN,
      cleanupGraph,
    }
  } catch (error) {
    rollbackPartialMixer()
    throw error
  }
}

export type StandaloneMicAnalyser = {
  audioContext: AudioContext
  analyser: AnalyserNode
  cleanup: () => void
}

/**
 * Lightweight mic-only analyser for dual RMS/health.
 * Does not touch speakers and does not re-acquire microphone tracks.
 */
export const createStandaloneMicAnalyser = async (
  micStream: MediaStream,
): Promise<StandaloneMicAnalyser> => {
  const AudioContextCtor = window.AudioContext
    || (window as Window & { webkitAudioContext?: typeof AudioContext }).webkitAudioContext
  if (!AudioContextCtor) {
    throw new AudioSourceError('Trình duyệt không hỗ trợ Web Audio API.', 'not_supported')
  }

  let audioContext: AudioContext | null = new AudioContextCtor()
  let source: MediaStreamAudioSourceNode | null = null
  let analyser: AnalyserNode | null = null

  const cleanup = () => {
    try {
      source?.disconnect()
    } catch {
      // ignore
    }
    try {
      analyser?.disconnect()
    } catch {
      // ignore
    }
    source = null
    analyser = null
    if (audioContext) {
      const context = audioContext
      audioContext = null
      void context.close().catch(() => {})
    }
  }

  try {
    source = audioContext.createMediaStreamSource(micStream)
    analyser = audioContext.createAnalyser()
    analyser.fftSize = 512
    source.connect(analyser)
    await ensureAudioContextRunning(audioContext)
    const settledContext = audioContext
    const settledAnalyser = analyser
    const settledSource = source
    audioContext = null
    source = null
    analyser = null
    return {
      audioContext: settledContext,
      analyser: settledAnalyser,
      cleanup: () => {
        try {
          settledSource.disconnect()
        } catch {
          // ignore
        }
        try {
          settledAnalyser.disconnect()
        } catch {
          // ignore
        }
        void settledContext.close().catch(() => {})
      },
    }
  } catch (error) {
    cleanup()
    throw error
  }
}

const mixTabAndMicrophoneStreams = async (
  tabStream: MediaStream,
  noiseSuppressionEnabled: boolean,
): Promise<{
  stream: MediaStream
  cleanup: () => void
  micIncluded: boolean
  mixerHandles?: TabMicMixerHandles
}> => {
  let micStream: MediaStream | null = null
  try {
    // Mixed mode: keep AEC/AGC off for RMS/gate compatibility; honor NS toggle.
    micStream = await acquireMicrophoneStream({
      noiseSuppressionEnabled,
      echoCancellationEnabled: false,
      autoGainControlEnabled: false,
    })
  } catch (error) {
    realtimeWarn('[Realtime]', BROWSER_TAB_CAPTURE_TELEMETRY.CAPTURE_FAILED, {
      reason: 'optional_mic_unavailable',
      message: error instanceof Error ? error.message : String(error),
    })
    return {
      stream: tabStream,
      cleanup: () => {},
      micIncluded: false,
    }
  }

  try {
    const mixerHandles = await createTabMicMixFromStreams(tabStream, micStream, {
      stopMicTracksOnCleanup: true,
    })
    return {
      stream: mixerHandles.mixedStream,
      cleanup: mixerHandles.cleanupGraph,
      micIncluded: true,
      mixerHandles,
    }
  } catch (error) {
    stopTracks(micStream)
    realtimeWarn('[Realtime]', BROWSER_TAB_CAPTURE_TELEMETRY.CAPTURE_FAILED, {
      reason: 'tab_mic_mix_unavailable',
      message: error instanceof Error ? error.message : String(error),
    })
    return {
      stream: tabStream,
      cleanup: () => {},
      micIncluded: false,
    }
  }
}

export type DualTabMicStreamId = 'tab' | 'mic'

export type AcquiredDualTabMicSources = {
  tab: { stream: MediaStream; cleanup: () => void }
  mic?: { stream: MediaStream; cleanup: () => void }
  micIncluded: boolean
  cleanup: () => void
}

export const acquireDualTabMicSources = async (
  options: {
    meetingId?: number | null
    noiseSuppressionEnabled?: boolean
  } = {},
): Promise<AcquiredDualTabMicSources> => {
  const { meetingId = null, noiseSuppressionEnabled = true } = options
  const tabStream = await acquireBrowserTabStream()
  let micStream: MediaStream | null = null

  try {
    micStream = await acquireMicrophoneStream({
      noiseSuppressionEnabled,
      echoCancellationEnabled: true,
      autoGainControlEnabled: true,
    })
  } catch (error) {
    realtimeWarn('[Realtime]', BROWSER_TAB_CAPTURE_TELEMETRY.CAPTURE_FAILED, {
      meetingId,
      reason: 'optional_mic_unavailable_dual',
      message: error instanceof Error ? error.message : String(error),
    })
  }

  const cleanup = () => {
    stopTracks(tabStream)
    if (micStream) {
      stopTracks(micStream)
    }
  }

  if (!micStream) {
    realtimeInfo('[Realtime]', BROWSER_TAB_CAPTURE_TELEMETRY.REALTIME_STARTED, {
      meetingId,
      source: 'browser_tab_with_mic',
      micIncluded: false,
      dualStream: true,
    })
    return {
      tab: { stream: tabStream, cleanup: () => stopTracks(tabStream) },
      micIncluded: false,
      cleanup,
    }
  }

  realtimeInfo('[Realtime]', BROWSER_TAB_CAPTURE_TELEMETRY.REALTIME_STARTED, {
    meetingId,
    source: 'browser_tab_with_mic',
    micIncluded: true,
    dualStream: true,
    noiseSuppressionEnabled,
  })

  return {
    tab: { stream: tabStream, cleanup: () => stopTracks(tabStream) },
    mic: { stream: micStream, cleanup: () => stopTracks(micStream) },
    micIncluded: true,
    cleanup,
  }
}

export const acquireAudioSource = async (
  options: AcquireAudioSourceOptions,
): Promise<AcquiredAudioSource> => {
  const { source, noiseSuppressionEnabled = true, meetingId = null } = options
  let ownedStreams: MediaStream[] = []
  let mixerCleanup: (() => void) | null = null

  try {
    if (source === 'microphone') {
      const stream = await acquireMicrophoneStream({
        noiseSuppressionEnabled,
        echoCancellationEnabled: true,
        autoGainControlEnabled: true,
      })
      ownedStreams = [stream]
      return {
        stream,
        source,
        cleanup: () => stopTracks(stream),
      }
    }

    const tabStream = await acquireBrowserTabStream()
    ownedStreams = [tabStream]

    if (source === 'browser_tab') {
      return {
        stream: tabStream,
        source,
        cleanup: () => stopTracks(tabStream),
      }
    }

    const mixed = await mixTabAndMicrophoneStreams(tabStream, noiseSuppressionEnabled)
    mixerCleanup = mixed.cleanup
    ownedStreams.push(mixed.stream)
    realtimeInfo('[Realtime]', BROWSER_TAB_CAPTURE_TELEMETRY.REALTIME_STARTED, {
      meetingId,
      source,
      micIncluded: mixed.micIncluded,
    })
    return {
      stream: mixed.stream,
      source,
      tabMixerHandles: mixed.mixerHandles,
      cleanup: () => {
        mixerCleanup?.()
        stopTracks(tabStream)
        stopTracks(mixed.stream)
      },
    }
  } catch (error) {
    ownedStreams.forEach((stream) => stopTracks(stream))
    mixerCleanup?.()
    const mapped = resolveCaptureError(error, source)
    if (source !== 'microphone') {
      realtimeWarn('[Realtime]', BROWSER_TAB_CAPTURE_TELEMETRY.CAPTURE_FAILED, {
        meetingId,
        source,
        code: mapped.code,
        message: mapped.message,
      })
    }
    throw mapped
  }
}

export const attachAudioTrackEndedHandler = (
  stream: MediaStream,
  onEnded: (track: MediaStreamTrack) => void,
  options?: {
    onMuted?: (track: MediaStreamTrack) => void
    onUnmuted?: (track: MediaStreamTrack) => void
  },
): (() => void) => {
  const handlers = new Map<MediaStreamTrack, {
    ended: () => void
    mute: () => void
    unmute: () => void
  }>()

  stream.getAudioTracks().forEach((track) => {
    const ended = () => {
      realtimeInfo('[Realtime]', BROWSER_TAB_CAPTURE_TELEMETRY.TRACK_ENDED, {
        trackId: track.id,
        readyState: track.readyState,
      })
      onEnded(track)
    }
    const mute = () => {
      options?.onMuted?.(track)
    }
    const unmute = () => {
      options?.onUnmuted?.(track)
    }
    handlers.set(track, { ended, mute, unmute })
    track.addEventListener('ended', ended)
    track.addEventListener('mute', mute)
    track.addEventListener('unmute', unmute)
  })

  return () => {
    handlers.forEach((handler, track) => {
      track.removeEventListener('ended', handler.ended)
      track.removeEventListener('mute', handler.mute)
      track.removeEventListener('unmute', handler.unmute)
    })
    handlers.clear()
  }
}

export const mapAudioSourceErrorMessage = (error: unknown): string => {
  if (error instanceof AudioSourceError) {
    return error.message
  }
  return resolveCaptureError(error, 'microphone').message
}
