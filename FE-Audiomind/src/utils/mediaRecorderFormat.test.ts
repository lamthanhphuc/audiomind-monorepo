import { describe, expect, it, vi, afterEach } from 'vitest'
import {
  buildMediaRecorderOptions,
  extensionForMimeType,
  getSupportedMediaRecorderFormat,
  resolveRecordedAudioResult,
} from './mediaRecorderFormat'

describe('mediaRecorderFormat', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('selects the first supported MIME type', () => {
    vi.stubGlobal('MediaRecorder', {
      isTypeSupported: (type: string) => type === 'audio/webm',
    })
    expect(getSupportedMediaRecorderFormat()).toEqual({
      mimeType: 'audio/webm',
      extension: 'webm',
    })
  })

  it('returns undefined mime when no candidate is supported', () => {
    vi.stubGlobal('MediaRecorder', {
      isTypeSupported: () => false,
    })
    expect(getSupportedMediaRecorderFormat()).toEqual({
      mimeType: undefined,
      extension: 'webm',
    })
  })

  it('does not crash when isTypeSupported is missing', () => {
    vi.stubGlobal('MediaRecorder', {})
    expect(getSupportedMediaRecorderFormat().extension).toBe('webm')
  })

  it('maps audio/mp4 to m4a extension', () => {
    expect(extensionForMimeType('audio/mp4')).toBe('m4a')
    expect(extensionForMimeType('audio/webm;codecs=opus')).toBe('webm')
  })

  it('uses actual recorder MIME for Blob result', () => {
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
    expect(resolved.fullBlob.type).toBe('audio/mp4')
  })

  it('builds MediaRecorder options without mime when unsupported', () => {
    const options = buildMediaRecorderOptions({ mimeType: undefined, extension: 'webm' })
    expect(options.mimeType).toBeUndefined()
    expect(options.audioBitsPerSecond).toBe(64_000)
  })
})
