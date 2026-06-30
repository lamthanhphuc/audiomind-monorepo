import type { RecordingSource } from '../constants/recordingSource'
import { BROWSER_TAB_CAPTURE_TELEMETRY, RECORDING_SOURCE_ERRORS } from '../constants/recordingSource'

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
}

type AcquireAudioSourceOptions = {
  source: RecordingSource
  noiseSuppressionEnabled?: boolean
  meetingId?: number | null
}

const PREFERRED_SAMPLE_RATE = 48_000

type DisplayMediaAudioConstraints = MediaTrackConstraints & {
  /** Chrome/Edge: capture tab audio without playing through local speakers. */
  suppressLocalAudioPlayback?: boolean
}

const buildTabCaptureConstraints = (): DisplayMediaStreamOptions => ({
  video: true,
  audio: {
    echoCancellation: false,
    noiseSuppression: false,
    autoGainControl: false,
    suppressLocalAudioPlayback: true,
  } as DisplayMediaAudioConstraints,
})

const prepareTabAudioTracks = (stream: MediaStream): void => {
  stream.getAudioTracks().forEach((track) => {
    track.enabled = true
  })
}

const isNoiseSuppressionConstraintSupported = (): boolean =>
  Boolean(navigator.mediaDevices?.getSupportedConstraints?.().noiseSuppression)

const buildMicrophoneConstraints = (
  noiseSuppressionEnabled: boolean,
  options?: { forTabMix?: boolean },
): MediaStreamConstraints => {
  const forTabMix = options?.forTabMix === true
  const audio: MediaTrackConstraints = {
    // Tab audio is captured directly (not through speakers). AEC/AGC can
    // suppress the mic when tab speech is loud in the mixed STT stream.
    echoCancellation: !forTabMix,
    autoGainControl: !forTabMix,
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
    console.warn('[Realtime]', BROWSER_TAB_CAPTURE_TELEMETRY.MISSING, {
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
    console.warn('[Realtime]', BROWSER_TAB_CAPTURE_TELEMETRY.MISSING, {
      reason: 'no_live_audio_track',
    })
    stopTracks(stream)
    throw new AudioSourceError(
      RECORDING_SOURCE_ERRORS.tabNoAudioTrack,
      'no_audio_track',
    )
  }

  console.info('[Realtime]', BROWSER_TAB_CAPTURE_TELEMETRY.TRACK_READY, {
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
  noiseSuppressionEnabled: boolean,
  forTabMix = false,
): Promise<MediaStream> => {
  if (!navigator.mediaDevices?.getUserMedia) {
    throw new AudioSourceError('Trình duyệt không hỗ trợ getUserMedia cho microphone.', 'not_supported')
  }
  return navigator.mediaDevices.getUserMedia(
    buildMicrophoneConstraints(noiseSuppressionEnabled, { forTabMix }),
  )
}

const measureAnalyserRms = (analyser: AnalyserNode, buffer: Uint8Array): number => {
  analyser.getByteTimeDomainData(buffer as Uint8Array<ArrayBuffer>)
  let sumSq = 0
  for (let i = 0; i < buffer.length; i += 1) {
    const centered = (buffer[i] - 128) / 128
    sumSq += centered * centered
  }
  return Math.sqrt(sumSq / buffer.length)
}

const acquireBrowserTabStream = async (): Promise<MediaStream> => {
  if (!navigator.mediaDevices?.getDisplayMedia) {
    throw new AudioSourceError(
      'Trình duyệt không hỗ trợ chia sẻ âm thanh tab. Hãy dùng Chrome hoặc Edge mới nhất.',
      'not_supported',
    )
  }

  console.info('[Realtime]', BROWSER_TAB_CAPTURE_TELEMETRY.STARTED)
  const stream = await navigator.mediaDevices.getDisplayMedia(buildTabCaptureConstraints())
  prepareTabAudioTracks(stream)
  discardDisplayVideoTracks(stream)
  validateBrowserTabAudioTracks(stream)
  return stream
}

const mixTabAndMicrophoneStreams = async (
  tabStream: MediaStream,
  _noiseSuppressionEnabled: boolean,
): Promise<{ stream: MediaStream; cleanup: () => void; micIncluded: boolean }> => {
  let micStream: MediaStream | null = null
  try {
    // Raw mic for tab-mix VAD: browser noise suppression lowers RMS and delays gate open.
    micStream = await acquireMicrophoneStream(false, true)
  } catch (error) {
    console.warn('[Realtime]', BROWSER_TAB_CAPTURE_TELEMETRY.CAPTURE_FAILED, {
      reason: 'optional_mic_unavailable',
      message: error instanceof Error ? error.message : String(error),
    })
    return {
      stream: tabStream,
      cleanup: () => {},
      micIncluded: false,
    }
  }

  const AudioContextCtor = window.AudioContext
    || (window as Window & { webkitAudioContext?: typeof AudioContext }).webkitAudioContext

  if (!AudioContextCtor) {
    stopTracks(micStream)
    return {
      stream: tabStream,
      cleanup: () => {},
      micIncluded: false,
    }
  }

  const audioContext = new AudioContextCtor()
  const destination = audioContext.createMediaStreamDestination()
  const tabSource = audioContext.createMediaStreamSource(tabStream)
  const micSource = audioContext.createMediaStreamSource(micStream)

  // Alternate dominant source: tab when user is silent, mic-only while speaking.
  // Mixing both simultaneously lets loud tab drown mic for STT.
  const TAB_PASS_GAIN = 0.38
  const MIC_PASS_GAIN = 6.0
  const MIC_IDLE_GAIN = 0
  const TAB_MUTE_GAIN = 0
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

  const micAnalyser = audioContext.createAnalyser()
  micAnalyser.fftSize = 512
  const micAnalyserData = new Uint8Array(micAnalyser.frequencyBinCount)
  const tabAnalyser = audioContext.createAnalyser()
  tabAnalyser.fftSize = 512
  const tabAnalyserData = new Uint8Array(tabAnalyser.frequencyBinCount)

  let rafId = 0
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

      if (micPriority) {
        // Snap instantly so tab cannot leak into STT chunks while user speaks.
        tabGain.gain.value = TAB_MUTE_GAIN
        micGain.gain.value = MIC_PASS_GAIN
        micActiveMs += deltaMs
      } else {
        tabGain.gain.value += (TAB_PASS_GAIN - tabGain.gain.value) * GAIN_RELEASE
        micGain.gain.value += (MIC_IDLE_GAIN - micGain.gain.value) * GAIN_RELEASE
        tabActiveMs += deltaMs
      }

      if (micPriority !== micPriorityActive) {
        micPriorityActive = micPriority
        console.info('[Realtime] TAB_MIC_GATE', {
          activeSource: micPriority ? 'microphone' : 'browser_tab',
          micRms: Number(micRms.toFixed(4)),
          tabRms: Number(tabRms.toFixed(4)),
          tabGain: Number(tabGain.gain.value.toFixed(3)),
          micGain: Number(micGain.gain.value.toFixed(3)),
          holdMs: micPriority ? SPEECH_HOLD_MS : 0,
          reason: micPriority ? 'mic_hold' : 'tab_default',
        })
        if (!micPriority) {
          // mic hold expired — tab resumes
        }
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
  tabGain.connect(destination)
  micSource.connect(micGain)
  micGain.connect(destination)
  micSource.connect(micAnalyser)
  tabSource.connect(tabAnalyser)
  rafId = window.requestAnimationFrame(tick)

  if (audioContext.state === 'suspended') {
    await audioContext.resume()
  }

  const mixedStream = destination.stream
  console.info('[Realtime] TAB_MIC_MIX_READY', {
    contextState: audioContext.state,
    mode: 'hard_gate',
    tabPassGain: TAB_PASS_GAIN,
    micPassGain: MIC_PASS_GAIN,
    mixedTrackCount: mixedStream.getAudioTracks().length,
  })
  const cleanup = () => {
    if (rafId) {
      window.cancelAnimationFrame(rafId)
    }
    try {
      tabSource.disconnect()
    } catch {
      // ignore
    }
    try {
      micSource.disconnect()
    } catch {
      // ignore
    }
    try {
      tabGain.disconnect()
    } catch {
      // ignore
    }
    try {
      micGain.disconnect()
    } catch {
      // ignore
    }
    try {
      micAnalyser.disconnect()
    } catch {
      // ignore
    }
    try {
      tabAnalyser.disconnect()
    } catch {
      // ignore
    }
    stopTracks(micStream)
    void audioContext.close().catch(() => {})
  }

  return { stream: mixedStream, cleanup, micIncluded: true }
}

export type DualTabMicStreamId = 'tab' | 'mic'

export type AcquiredDualTabMicSources = {
  tab: { stream: MediaStream; cleanup: () => void }
  mic?: { stream: MediaStream; cleanup: () => void }
  micIncluded: boolean
  cleanup: () => void
}

export const acquireDualTabMicSources = async (
  options: { meetingId?: number | null } = {},
): Promise<AcquiredDualTabMicSources> => {
  const { meetingId = null } = options
  const tabStream = await acquireBrowserTabStream()
  let micStream: MediaStream | null = null

  try {
    micStream = await acquireMicrophoneStream(false, true)
  } catch (error) {
    console.warn('[Realtime]', BROWSER_TAB_CAPTURE_TELEMETRY.CAPTURE_FAILED, {
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
    console.info('[Realtime]', BROWSER_TAB_CAPTURE_TELEMETRY.REALTIME_STARTED, {
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

  console.info('[Realtime]', BROWSER_TAB_CAPTURE_TELEMETRY.REALTIME_STARTED, {
    meetingId,
    source: 'browser_tab_with_mic',
    micIncluded: true,
    dualStream: true,
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
      const stream = await acquireMicrophoneStream(noiseSuppressionEnabled)
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
    console.info('[Realtime]', BROWSER_TAB_CAPTURE_TELEMETRY.REALTIME_STARTED, {
      meetingId,
      source,
      micIncluded: mixed.micIncluded,
    })
    return {
      stream: mixed.stream,
      source,
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
      console.warn('[Realtime]', BROWSER_TAB_CAPTURE_TELEMETRY.CAPTURE_FAILED, {
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
): (() => void) => {
  const handlers = new Map<MediaStreamTrack, () => void>()

  stream.getAudioTracks().forEach((track) => {
    const handler = () => {
      console.info('[Realtime]', BROWSER_TAB_CAPTURE_TELEMETRY.TRACK_ENDED, {
        trackId: track.id,
        readyState: track.readyState,
      })
      onEnded(track)
    }
    handlers.set(track, handler)
    track.addEventListener('ended', handler)
  })

  return () => {
    handlers.forEach((handler, track) => {
      track.removeEventListener('ended', handler)
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
