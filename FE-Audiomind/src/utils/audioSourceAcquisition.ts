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

const buildMicrophoneConstraints = (noiseSuppressionEnabled: boolean): MediaStreamConstraints => {
  const audio: MediaTrackConstraints = {
    echoCancellation: true,
    autoGainControl: true,
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

const acquireMicrophoneStream = async (noiseSuppressionEnabled: boolean): Promise<MediaStream> => {
  if (!navigator.mediaDevices?.getUserMedia) {
    throw new AudioSourceError('Trình duyệt không hỗ trợ getUserMedia cho microphone.', 'not_supported')
  }
  return navigator.mediaDevices.getUserMedia(buildMicrophoneConstraints(noiseSuppressionEnabled))
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
  noiseSuppressionEnabled: boolean,
): Promise<{ stream: MediaStream; cleanup: () => void; micIncluded: boolean }> => {
  let micStream: MediaStream | null = null
  try {
    micStream = await acquireMicrophoneStream(noiseSuppressionEnabled)
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
  tabSource.connect(destination)
  micSource.connect(destination)

  const mixedStream = destination.stream
  const cleanup = () => {
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
    stopTracks(micStream)
    void audioContext.close().catch(() => {})
  }

  return { stream: mixedStream, cleanup, micIncluded: true }
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
