import { realtimeWarn } from './realtimeTelemetry'

export type MediaRecorderExtension = 'webm' | 'm4a'
export type MediaRecorderPurpose = 'realtime' | 'final'

export type MediaRecorderFormat = {
  mimeType?: string
  extension: MediaRecorderExtension
  /** Wire encoding accepted by RealtimePayloadValidator when purpose is realtime. */
  encoding?: 'webm-opus'
}

/** Verified realtime format — only produced after actual recorder MIME inspection. */
export type RealtimeRecorderFormat = {
  mimeType: string
  container: 'webm'
  codec: 'opus'
  encoding: 'webm-opus'
  extension: 'webm'
}

export type RecordedAudioResult = {
  blob: Blob
  mimeType: string
  extension: MediaRecorderExtension
}

export type ParsedRealtimeMimeType = {
  container: string
  codecs: string[]
  codecParameterPresent: boolean
  codecParameterMalformed: boolean
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

/** Mirror of packages/contracts/realtime-audio-format.json */
export const REALTIME_PAYLOAD_CONTRACT = {
  allowedContainers: ['webm'] as const,
  /** MIME codec tokens (not wire encoding). */
  allowedCodecs: ['opus', 'webm-opus'] as const,
  /** Exact wire encodings accepted by RealtimePayloadValidator. */
  wireEncodings: ['webm-opus'] as const,
  encoding: 'webm-opus' as const,
  /** Bare audio/webm (no codecs parameter) is allowed. */
  allowBareWebm: true as const,
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

const stripBalancedQuotes = (value: string): { value: string; malformed: boolean } => {
  const trimmed = value.trim()
  if (!trimmed) {
    return { value: '', malformed: false }
  }
  const startsDouble = trimmed.startsWith('"')
  const endsDouble = trimmed.endsWith('"')
  const startsSingle = trimmed.startsWith("'")
  const endsSingle = trimmed.endsWith("'")
  if (startsDouble || endsDouble) {
    if (!(startsDouble && endsDouble) || trimmed.length < 2) {
      return { value: trimmed, malformed: true }
    }
    return { value: trimmed.slice(1, -1), malformed: false }
  }
  if (startsSingle || endsSingle) {
    if (!(startsSingle && endsSingle) || trimmed.length < 2) {
      return { value: trimmed, malformed: true }
    }
    return { value: trimmed.slice(1, -1), malformed: false }
  }
  return { value: trimmed, malformed: false }
}

/**
 * Parse MIME type into container + codecs.
 * Distinguishes bare WebM from empty/malformed codecs= parameters.
 * Only recognizes the exact parameter name `codecs` (not codecsx / startsWith).
 */
export const parseRealtimeMimeType = (
  mimeType: string | undefined | null,
): ParsedRealtimeMimeType | null => {
  const raw = String(mimeType || '').trim()
  if (!raw) {
    return null
  }
  const parts = raw.split(';').map((part) => part.trim()).filter(Boolean)
  const container = (parts[0] || '').toLowerCase()
  if (!container) {
    return null
  }

  const codecs: string[] = []
  let codecParameterPresent = false
  let codecParameterMalformed = false

  for (const part of parts.slice(1)) {
    const eq = part.indexOf('=')
    if (eq < 0) {
      if (part.toLowerCase() === 'codecs') {
        codecParameterPresent = true
        codecParameterMalformed = true
      }
      continue
    }

    const name = part.slice(0, eq).trim().toLowerCase()
    if (name !== 'codecs') {
      continue
    }

    codecParameterPresent = true
    const rawValue = part.slice(eq + 1)
    if (!rawValue.trim()) {
      codecParameterMalformed = true
      continue
    }

    const unquoted = stripBalancedQuotes(rawValue)
    if (unquoted.malformed) {
      codecParameterMalformed = true
      continue
    }
    if (!unquoted.value.trim()) {
      codecParameterMalformed = true
      continue
    }

    // Keep trailing empty tokens (equivalent to Java split(",", -1)).
    let sawToken = false
    for (const token of unquoted.value.split(',')) {
      const codec = token.trim().toLowerCase().replace(/^["']|["']$/g, '')
      if (!codec) {
        codecParameterMalformed = true
        continue
      }
      sawToken = true
      codecs.push(codec)
    }
    if (!sawToken) {
      codecParameterMalformed = true
    }
  }

  return {
    container,
    codecs,
    codecParameterPresent,
    codecParameterMalformed,
  }
}

const isAllowedRealtimeCodecToken = (codec: string): boolean => {
  // Exact membership after trim + lowercase only — never strip internal whitespace.
  const normalized = codec.trim().toLowerCase()
  return (REALTIME_PAYLOAD_CONTRACT.allowedCodecs as readonly string[]).includes(normalized)
}

/**
 * True only for WebM/Opus-compatible MIME types.
 * Explicit non-opus codecs and malformed codecs= parameters are rejected.
 * Empty MIME is never compatible.
 */
export const isRealtimeCompatibleMimeType = (mimeType: string | undefined | null): boolean => {
  const parsed = parseRealtimeMimeType(mimeType)
  if (!parsed) {
    return false
  }
  if (parsed.container !== 'audio/webm') {
    return false
  }
  if (parsed.codecParameterMalformed) {
    return false
  }
  if (!parsed.codecParameterPresent) {
    return REALTIME_PAYLOAD_CONTRACT.allowBareWebm
  }
  if (parsed.codecs.length === 0) {
    return false
  }
  return parsed.codecs.every(isAllowedRealtimeCodecToken)
}

export const realtimeEncodingForMimeType = (mimeType: string | undefined | null): 'webm-opus' | null => {
  if (!isRealtimeCompatibleMimeType(mimeType)) {
    return null
  }
  return REALTIME_PAYLOAD_CONTRACT.encoding
}

/**
 * Assert actual recorder MIME is realtime-compatible and return a typed format.
 * Empty / unknown / non-opus codecs throw — never invent encoding=webm-opus.
 */
export const assertRealtimeCompatibleMimeType = (
  mimeType: string | undefined | null,
): RealtimeRecorderFormat => {
  if (!mimeType || !String(mimeType).trim()) {
    throw new UnsupportedRealtimeRecorderFormatError(
      'Trình duyệt không báo cáo MIME ghi âm realtime. Không thể xác minh WebM/Opus.',
    )
  }
  if (!isRealtimeCompatibleMimeType(mimeType)) {
    throw new UnsupportedRealtimeRecorderFormatError()
  }
  return {
    mimeType: String(mimeType).trim(),
    container: 'webm',
    codec: 'opus',
    encoding: REALTIME_PAYLOAD_CONTRACT.encoding,
    extension: 'webm',
  }
}

const selectFormat = (
  candidates: readonly string[],
  purpose: MediaRecorderPurpose,
): MediaRecorderFormat => {
  if (typeof MediaRecorder === 'undefined') {
    return { mimeType: undefined, extension: 'webm' }
  }

  const isTypeSupported = typeof MediaRecorder.isTypeSupported === 'function'
    ? MediaRecorder.isTypeSupported.bind(MediaRecorder)
    : null

  if (!isTypeSupported) {
    // Caller must verify actual recorder.mimeType before start for realtime.
    return { mimeType: undefined, extension: 'webm' }
  }

  for (const candidate of candidates) {
    try {
      if (isTypeSupported(candidate)) {
        const format: MediaRecorderFormat = {
          mimeType: candidate,
          extension: extensionForMimeType(candidate),
        }
        if (purpose === 'realtime' && isRealtimeCompatibleMimeType(candidate)) {
          format.encoding = REALTIME_PAYLOAD_CONTRACT.encoding
        }
        return format
      }
    } catch {
      // ignore isTypeSupported failures
    }
  }

  return { mimeType: undefined, extension: 'webm' }
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
 * Preferred realtime MIME candidates only.
 * Does NOT invent encoding when MIME is unknown — verify after MediaRecorder construction.
 */
export const requireSupportedRealtimeRecorderFormat = (): MediaRecorderFormat => {
  const format = getSupportedRealtimeRecorderFormat()
  if (format.mimeType && isRealtimeCompatibleMimeType(format.mimeType)) {
    return {
      ...format,
      encoding: REALTIME_PAYLOAD_CONTRACT.encoding,
    }
  }

  const hasIsTypeSupported = typeof MediaRecorder !== 'undefined'
    && typeof MediaRecorder.isTypeSupported === 'function'
  if (!hasIsTypeSupported) {
    // Probe path: create MediaRecorder without MIME, then assert actual mimeType.
    return { mimeType: undefined, extension: 'webm' }
  }

  throw new UnsupportedRealtimeRecorderFormatError()
}

/**
 * Create a MediaRecorder and verify its actual MIME before the caller starts recording.
 * Does not call start() — callers start only after this returns successfully.
 * Only trusts recorder.mimeType (never preferred/candidate MIME).
 */
export const createVerifiedRealtimeMediaRecorder = (
  stream: MediaStream,
  audioBitsPerSecond = 64_000,
): { recorder: MediaRecorder; format: RealtimeRecorderFormat } => {
  if (typeof MediaRecorder === 'undefined') {
    throw new UnsupportedRealtimeRecorderFormatError()
  }

  const preferred = requireSupportedRealtimeRecorderFormat()
  const recorder = new MediaRecorder(stream, buildMediaRecorderOptions(preferred, audioBitsPerSecond))
  const format = assertRealtimeCompatibleMimeType(recorder.mimeType)
  return { recorder, format }
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
