import { realtimeWarn } from './realtimeTelemetry'

export type MediaRecorderExtension = 'webm' | 'm4a'

export type MediaRecorderFormat = {
  mimeType?: string
  extension: MediaRecorderExtension
}

export type RecordedAudioResult = {
  blob: Blob
  mimeType: string
  extension: MediaRecorderExtension
}

const MIME_CANDIDATES = [
  'audio/webm;codecs=opus',
  'audio/webm; codecs=opus',
  'audio/webm',
  'audio/mp4',
] as const

const DEFAULT_FORMAT: MediaRecorderFormat = {
  mimeType: undefined,
  extension: 'webm',
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

export const getSupportedMediaRecorderFormat = (): MediaRecorderFormat => {
  if (typeof MediaRecorder === 'undefined') {
    return { ...DEFAULT_FORMAT }
  }

  const isTypeSupported = typeof MediaRecorder.isTypeSupported === 'function'
    ? MediaRecorder.isTypeSupported.bind(MediaRecorder)
    : null

  if (!isTypeSupported) {
    return { ...DEFAULT_FORMAT }
  }

  for (const candidate of MIME_CANDIDATES) {
    try {
      if (isTypeSupported(candidate)) {
        return {
          mimeType: candidate,
          extension: extensionForMimeType(candidate),
        }
      }
    } catch {
      // ignore isTypeSupported failures
    }
  }

  return { ...DEFAULT_FORMAT }
}

export const buildMediaRecorderOptions = (
  format: MediaRecorderFormat = getSupportedMediaRecorderFormat(),
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
  const requested = params.requestedFormat ?? getSupportedMediaRecorderFormat()
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
