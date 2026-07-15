import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  REALTIME_MIME_CANDIDATES,
  FINAL_MIME_CANDIDATES,
  REALTIME_PAYLOAD_CONTRACT,
  assertRealtimeCompatibleMimeType,
  buildMediaRecorderOptions,
  createVerifiedRealtimeMediaRecorder,
  extensionForMimeType,
  getSupportedFinalRecorderFormat,
  getSupportedMediaRecorderFormat,
  getSupportedRealtimeRecorderFormat,
  isRealtimeCompatibleMimeType,
  parseRealtimeMimeType,
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

  it('does not invent encoding when isTypeSupported is unavailable', () => {
    vi.stubGlobal('MediaRecorder', {})
    expect(requireSupportedRealtimeRecorderFormat()).toEqual({
      mimeType: undefined,
      extension: 'webm',
    })
  })

  it('rejects vorbis and accepts quoted opus codecs', () => {
    expect(isRealtimeCompatibleMimeType('audio/webm;codecs=vorbis')).toBe(false)
    expect(isRealtimeCompatibleMimeType('audio/webm; codecs="opus"')).toBe(true)
    expect(parseRealtimeMimeType('audio/webm; codecs="opus"')).toEqual({
      container: 'audio/webm',
      codecs: ['opus'],
      codecParameterPresent: true,
      codecParameterMalformed: false,
    })
    expect(assertRealtimeCompatibleMimeType('audio/webm; codecs="opus"').encoding).toBe('webm-opus')
    expect(() => assertRealtimeCompatibleMimeType('audio/webm;codecs=vorbis')).toThrow(
      UnsupportedRealtimeRecorderFormatError,
    )
    expect(() => assertRealtimeCompatibleMimeType('')).toThrow(UnsupportedRealtimeRecorderFormatError)
    expect(() => assertRealtimeCompatibleMimeType(undefined)).toThrow(UnsupportedRealtimeRecorderFormatError)
  })

  it('rejects malformed codecs parameters and ignores codecsx', () => {
    expect(isRealtimeCompatibleMimeType('audio/webm;codecs=')).toBe(false)
    expect(isRealtimeCompatibleMimeType('audio/webm;codecs')).toBe(false)
    expect(isRealtimeCompatibleMimeType('audio/webm;codecs="opus')).toBe(false)
    expect(isRealtimeCompatibleMimeType('audio/webm;codecs=opus"')).toBe(false)
    expect(parseRealtimeMimeType('audio/webm;codecs=')).toMatchObject({
      codecParameterPresent: true,
      codecParameterMalformed: true,
    })
    expect(parseRealtimeMimeType('audio/webm;codecsx=opus')).toMatchObject({
      codecParameterPresent: false,
      codecParameterMalformed: false,
      codecs: [],
    })
    expect(isRealtimeCompatibleMimeType('audio/webm;codecsx=opus')).toBe(true)
  })

  it('rejects trailing/leading empty codec tokens and non-contract codecs', () => {
    for (const mime of [
      'audio/webm;codecs=opus,',
      'audio/webm;codecs=,opus',
      'audio/webm;codecs=opus,,',
      'audio/webm;codecs=opus,,webm-opus',
      'audio/webm;codecs="opus,"',
      'audio/webm;codecs=",opus"',
      'audio/webm;codecs=audio/opus',
      'audio/webm;codecs=vorbis',
    ]) {
      expect(isRealtimeCompatibleMimeType(mime)).toBe(false)
      expect(realtimeEncodingForMimeType(mime)).toBeNull()
    }

    expect(isRealtimeCompatibleMimeType('audio/webm')).toBe(true)
    expect(isRealtimeCompatibleMimeType('audio/webm;codecs=opus')).toBe(true)
    expect(isRealtimeCompatibleMimeType('audio/webm;codecs="opus"')).toBe(true)
    expect(isRealtimeCompatibleMimeType('audio/webm; codecs = "opus"')).toBe(true)
    expect(isRealtimeCompatibleMimeType('audio/webm;codecs=webm-opus')).toBe(true)
    expect(isRealtimeCompatibleMimeType('audio/webm;codecs= opus ')).toBe(true)
  })

  it('rejects codecs with internal whitespace instead of collapsing tokens', () => {
    for (const mime of [
      'audio/webm;codecs=o p u s',
      'audio/webm;codecs="o p u s"',
      'audio/webm;codecs=webm - opus',
      'audio/webm;codecs=o\tp\tu\ts',
      'audio/webm;codecs=o\np\nus',
      'audio/webm;codecs=webm\t-\topus',
    ]) {
      expect(isRealtimeCompatibleMimeType(mime)).toBe(false)
      expect(realtimeEncodingForMimeType(mime)).toBeNull()
    }
  })

  it('rejects empty actual mimeType even when isTypeSupported reports WebM', () => {
    const start = vi.fn()
    class EmptyMimeRecorder {
      static isTypeSupported = () => true
      mimeType = ''
      start = start
      constructor(_stream: MediaStream, _options?: MediaRecorderOptions) {}
    }
    vi.stubGlobal('MediaRecorder', EmptyMimeRecorder)
    const stream = { getTracks: () => [] } as unknown as MediaStream
    expect(() => createVerifiedRealtimeMediaRecorder(stream)).toThrow(UnsupportedRealtimeRecorderFormatError)
    expect(start).not.toHaveBeenCalled()
  })

  it('rejects actual MP4 Mime when isTypeSupported is missing and does not start recorder', () => {
    const start = vi.fn()
    class Mp4Recorder {
      mimeType = 'audio/mp4'
      state = 'inactive'
      start = start
      constructor(_stream: MediaStream, _options?: MediaRecorderOptions) {}
    }
    vi.stubGlobal('MediaRecorder', Mp4Recorder)
    const stream = { getTracks: () => [] } as unknown as MediaStream
    expect(() => createVerifiedRealtimeMediaRecorder(stream)).toThrow(UnsupportedRealtimeRecorderFormatError)
    expect(start).not.toHaveBeenCalled()
  })

  it('does not fall back to preferred MIME when actual mimeType is empty', () => {
    class PreferredOnlyRecorder {
      static isTypeSupported = (type: string) => type.includes('webm')
      mimeType = ''
      constructor(_stream: MediaStream, _options?: MediaRecorderOptions) {}
    }
    vi.stubGlobal('MediaRecorder', PreferredOnlyRecorder)
    const stream = { getTracks: () => [] } as unknown as MediaStream
    expect(() => createVerifiedRealtimeMediaRecorder(stream)).toThrow(UnsupportedRealtimeRecorderFormatError)
  })

  it('accepts actual WebM/Opus mime when isTypeSupported is missing', () => {
    class WebmRecorder {
      mimeType = 'audio/webm;codecs=opus'
      constructor(_stream: MediaStream, _options?: MediaRecorderOptions) {}
    }
    vi.stubGlobal('MediaRecorder', WebmRecorder)
    const stream = { getTracks: () => [] } as unknown as MediaStream
    const { format } = createVerifiedRealtimeMediaRecorder(stream)
    expect(format).toEqual({
      mimeType: 'audio/webm;codecs=opus',
      container: 'webm',
      codec: 'opus',
      encoding: 'webm-opus',
      extension: 'webm',
    })
  })

  it('rejects actual WebM/Vorbis mime after construction', () => {
    class VorbisRecorder {
      mimeType = 'audio/webm;codecs=vorbis'
      constructor(_stream: MediaStream, _options?: MediaRecorderOptions) {}
    }
    vi.stubGlobal('MediaRecorder', VorbisRecorder)
    const stream = { getTracks: () => [] } as unknown as MediaStream
    expect(() => createVerifiedRealtimeMediaRecorder(stream)).toThrow(UnsupportedRealtimeRecorderFormatError)
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
    expect([...REALTIME_PAYLOAD_CONTRACT.wireEncodings]).toEqual(contract.wireEncodings)
    expect(REALTIME_PAYLOAD_CONTRACT.allowedCodecs).toEqual(['opus', 'webm-opus'])
    expect(realtimeEncodingForMimeType('audio/mp4')).toBeNull()
    expect(realtimeEncodingForMimeType('audio/webm; codecs=opus')).toBe('webm-opus')
    expect(realtimeEncodingForMimeType('audio/webm;codecs=webm-opus')).toBe('webm-opus')
    expect(realtimeEncodingForMimeType('audio/webm;codecs=audio/opus')).toBeNull()
    expect(realtimeEncodingForMimeType('audio/webm;codecs=vorbis')).toBeNull()
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
