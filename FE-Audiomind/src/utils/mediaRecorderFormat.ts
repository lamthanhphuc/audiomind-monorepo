import { realtimeWarn } from './realtimeTelemetry'

export type MediaRecorderExtension = 'webm' | 'm4a'
export type MediaRecorderPurpose = 'realtime' | 'final'

export type MediaRecorderFormat = {
  mimeType?: string
  extension: MediaRecorderExtension
  /** Wire encoding accepted by RealtimePayloadValidator when purpose is realtime. */
  encoding?: 'webm-opus'
}

export type RecordedAudioResult = {
  blob: Blob
  mimeType: string
  extension: MediaRecorderExtension
}

export class UnsupportedRealtimeRecorderFormatError extends Error {
  readonly code = 'REALTIME_UNSUPPORTED_RECORDER_FORMAT' as const

  constructor(message = 'Trình duyệt không hỗ trợ định dạng ghi âm realtime (WebM/Opus) mà pipeline yêu cầu.') {
    super(message)
    this.name = 'UnsupportedRealtimeRecorderFormatError'
  }
}

/** Formats accepted by processing-service RealtimePayloadValidator (WebM/Opus only). */
export const REALTIME_MIME_CANDIDATES = [
  'audio/webm;codecs=opus',
  'audio/webm; codecs=opus',
  'audio/webm',
] as const

/** Broader formats for final/batch recording where FFmpeg/upload can transcode. */
export const FINAL_MIME_CANDIDATES = [
  'audio/webm;codecs=opus',
  'audio/webm; codecs=opus',
  'audio/webm',
  'audio/mp4',
] as const

/** Mirror of RealtimePayloadValidator ALLOWED_CONTAINERS / ALLOWED_CODECS for FE contract tests. */
export const REALTIME_PAYLOAD_CONTRACT = {
  allowedContainers: ['webm'] as const,
  allowedCodecs: ['opus', 'webm-opus'] as const,
  encoding: 'webm-opus' as const,
}

const DEFAULT_FORMAT: MediaRecorderFormat = {
  mimeType: undefined,
  extension: 'webm',
  encoding: 'webm-opus',
}

export const extensionForMimeType = (mimeType: string | undefined | null): MediaRecorderExtension => {
  const normalized = String(mimeType || '').toLowerCase().replace(/\s+/g, '')
  if (normalized.startsWith('audio/mp4') || normalized.includes('mp4a') || normalized.includes('aac')) {
    return 'm4a'
  }
  if (normalized.startsWith('audio/webm') || normalized.includes('opus')) {
    return 'webm'
  }
  if (normalized) {
    realtimeWarn('[Realtime] MEDIA_RECORDER_MIME_UNMAPPED', {
      mimeType: normalized.slice(0, 64),
    })
  }
  return 'webm'
}

export const isRealtimeCompatibleMimeType = (mimeType: string | undefined | null): boolean => {
  const normalized = String(mimeType || '').toLowerCase().replace(/\s+/g, '')
  if (!normalized) {
    return false
  }
  return REALTIME_PAYLOAD_CONTRACT.allowedContainers.some((container) => normalized.includes(container))
}

export const realtimeEncodingForMimeType = (mimeType: string | undefined | null): 'webm-opus' | null => {
  if (!isRealtimeCompatibleMimeType(mimeType)) {
    return null
  }
  return REALTIME_PAYLOAD_CONTRACT.encoding
}

const selectFormat = (
  candidates: readonly string[],
  purpose: MediaRecorderPurpose,
): MediaRecorderFormat => {
  if (typeof MediaRecorder === 'undefined') {
    return purpose === 'realtime' ? { ...DEFAULT_FORMAT } : { mimeType: undefined, extension: 'webm' }
  }

  const isTypeSupported = typeof MediaRecorder.isTypeSupported === 'function'
    ? MediaRecorder.isTypeSupported.bind(MediaRecorder)
    : null

  if (!isTypeSupported) {
    return purpose === 'realtime' ? { ...DEFAULT_FORMAT } : { mimeType: undefined, extension: 'webm' }
  }

  for (const candidate of candidates) {
    try {
      if (isTypeSupported(candidate)) {
        const format: MediaRecorderFormat = {
          mimeType: candidate,
          extension: extensionForMimeType(candidate),
        }
        if (purpose === 'realtime') {
          format.encoding = REALTIME_PAYLOAD_CONTRACT.encoding
        }
        return format
      }
    } catch {
      // ignore isTypeSupported failures
    }
  }

  return purpose === 'realtime' ? { ...DEFAULT_FORMAT, mimeType: undefined } : { mimeType: undefined, extension: 'webm' }
}

export const getSupportedMediaRecorderFormat = (
  options: { purpose?: MediaRecorderPurpose } = {},
): MediaRecorderFormat => {
  const purpose = options.purpose ?? 'final'
  return selectFormat(
    purpose === 'realtime' ? REALTIME_MIME_CANDIDATES : FINAL_MIME_CANDIDATES,
    purpose,
  )
}

export const getSupportedRealtimeRecorderFormat = (): MediaRecorderFormat =>
  getSupportedMediaRecorderFormat({ purpose: 'realtime' })

export const getSupportedFinalRecorderFormat = (): MediaRecorderFormat =>
  getSupportedMediaRecorderFormat({ purpose: 'final' })

/**
 * Require a realtime WebM format compatible with RealtimePayloadValidator.
 * Throws when MediaRecorder can negotiate types but none of the WebM candidates work.
 * When isTypeSupported is unavailable, allows browser-default MediaRecorder options
 * while still advertising webm-opus wire encoding.
 */
export const requireSupportedRealtimeRecorderFormat = (): MediaRecorderFormat => {
  const format = getSupportedRealtimeRecorderFormat()
  if (format.mimeType && isRealtimeCompatibleMimeType(format.mimeType)) {
    return format
  }

  const hasIsTypeSupported = typeof MediaRecorder !== 'undefined'
    && typeof MediaRecorder.isTypeSupported === 'function'
  if (!hasIsTypeSupported) {
    return {
      mimeType: undefined,
      extension: 'webm',
      encoding: REALTIME_PAYLOAD_CONTRACT.encoding,
    }
  }

  throw new UnsupportedRealtimeRecorderFormatError()
}

export const buildMediaRecorderOptions = (
  format: MediaRecorderFormat = getSupportedFinalRecorderFormat(),
  audioBitsPerSecond = 64_000,
): MediaRecorderOptions => {
  return {
    ...(format.mimeType ? { mimeType: format.mimeType } : {}),
    audioBitsPerSecond,
  }
}

export const resolveRecordedAudioResult = (params: {
  blob: Blob
  recorderMimeType?: string
  requestedFormat?: MediaRecorderFormat
  chunks?: Blob[]
  sessionId: number
  collectedChunkCount?: number
  postStopChunkCount?: number
}): {
  result: RecordedAudioResult
  sessionId: number
  collectedChunkCount: number
  postStopChunkCount: number
  chunks: Blob[]
  fullBlob: Blob
  mimeType: string
  extension: MediaRecorderExtension
} => {
  const requested = params.requestedFormat ?? getSupportedFinalRecorderFormat()
  const actualMimeType =
    params.recorderMimeType
    || requested.mimeType
    || params.blob.type
    || 'audio/webm'
  const extension = extensionForMimeType(actualMimeType)
  const blob = params.blob.type === actualMimeType
    ? params.blob
    : new Blob([params.blob], { type: actualMimeType })

  const recorded: RecordedAudioResult = {
    blob,
    mimeType: actualMimeType,
    extension,
  }

  return {
    result: recorded,
    sessionId: params.sessionId,
    collectedChunkCount: params.collectedChunkCount ?? (params.chunks?.length ?? 0),
    postStopChunkCount: params.postStopChunkCount ?? 0,
    chunks: params.chunks ?? [blob],
    fullBlob: blob,
    mimeType: actualMimeType,
    extension,
  }
}
