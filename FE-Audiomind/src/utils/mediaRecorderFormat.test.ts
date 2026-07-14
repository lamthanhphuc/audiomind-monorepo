import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  REALTIME_MIME_CANDIDATES,
  FINAL_MIME_CANDIDATES,
  REALTIME_PAYLOAD_CONTRACT,
  buildMediaRecorderOptions,
  extensionForMimeType,
  getSupportedFinalRecorderFormat,
  getSupportedMediaRecorderFormat,
  getSupportedRealtimeRecorderFormat,
  isRealtimeCompatibleMimeType,
  realtimeEncodingForMimeType,
  requireSupportedRealtimeRecorderFormat,
  resolveRecordedAudioResult,
  UnsupportedRealtimeRecorderFormatError,
} from './mediaRecorderFormat'

describe('mediaRecorderFormat', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('realtime selector does not pick audio/mp4 even when it is the only type MediaRecorder reports', () => {
    vi.stubGlobal('MediaRecorder', {
      isTypeSupported: (type: string) => type === 'audio/mp4',
    })
    expect(getSupportedRealtimeRecorderFormat().mimeType).toBeUndefined()
    expect(REALTIME_MIME_CANDIDATES.some((candidate) => candidate.includes('mp4'))).toBe(false)
  })

  it('final selector can pick audio/mp4', () => {
    vi.stubGlobal('MediaRecorder', {
      isTypeSupported: (type: string) => type === 'audio/mp4',
    })
    expect(getSupportedFinalRecorderFormat()).toEqual({
      mimeType: 'audio/mp4',
      extension: 'm4a',
    })
    expect(FINAL_MIME_CANDIDATES).toContain('audio/mp4')
  })

  it('throws typed error when browser has no realtime WebM support', () => {
    vi.stubGlobal('MediaRecorder', {
      isTypeSupported: () => false,
    })
    expect(() => requireSupportedRealtimeRecorderFormat()).toThrow(UnsupportedRealtimeRecorderFormatError)
  })

  it('allows browser-default MediaRecorder when isTypeSupported is unavailable', () => {
    vi.stubGlobal('MediaRecorder', {})
    expect(requireSupportedRealtimeRecorderFormat()).toEqual({
      mimeType: undefined,
      extension: 'webm',
      encoding: 'webm-opus',
    })
  })

  it('selects WebM for realtime and emits validator-compatible encoding', () => {
    vi.stubGlobal('MediaRecorder', {
      isTypeSupported: (type: string) => type === 'audio/webm;codecs=opus',
    })
    const format = requireSupportedRealtimeRecorderFormat()
    expect(format.mimeType).toBe('audio/webm;codecs=opus')
    expect(format.encoding).toBe('webm-opus')
    expect(isRealtimeCompatibleMimeType(format.mimeType)).toBe(true)
    expect(realtimeEncodingForMimeType(format.mimeType)).toBe('webm-opus')
  })

  it('keeps FE contract aligned with RealtimePayloadValidator containers/codecs', async () => {
    const contract = await import('../../../packages/contracts/realtime-audio-format.json')
    expect(REALTIME_PAYLOAD_CONTRACT.allowedContainers).toEqual(contract.allowedContainers)
    expect(REALTIME_PAYLOAD_CONTRACT.allowedCodecs).toEqual(contract.allowedCodecs)
    expect(realtimeEncodingForMimeType('audio/mp4')).toBeNull()
    expect(realtimeEncodingForMimeType('audio/webm; codecs=opus')).toBe('webm-opus')
  })

  it('purpose=final remains the default getSupportedMediaRecorderFormat() behavior', () => {
    vi.stubGlobal('MediaRecorder', {
      isTypeSupported: (type: string) => type === 'audio/webm',
    })
    expect(getSupportedMediaRecorderFormat()).toEqual({
      mimeType: 'audio/webm',
      extension: 'webm',
    })
  })

  it('maps audio/mp4 to m4a extension for final blobs', () => {
    expect(extensionForMimeType('audio/mp4')).toBe('m4a')
    const blob = new Blob(['x'], { type: 'audio/mp4' })
    const resolved = resolveRecordedAudioResult({
      blob,
      recorderMimeType: 'audio/mp4',
      requestedFormat: { mimeType: 'audio/webm', extension: 'webm' },
      sessionId: 1,
      chunks: [blob],
    })
    expect(resolved.extension).toBe('m4a')
    expect(resolved.mimeType).toBe('audio/mp4')
  })

  it('builds MediaRecorder options without mime when unsupported', () => {
    const options = buildMediaRecorderOptions({ mimeType: undefined, extension: 'webm' })
    expect(options.mimeType).toBeUndefined()
    expect(options.audioBitsPerSecond).toBe(64_000)
  })
})
