import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  acquireAudioSource,
  acquireDualTabMicSources,
  attachAudioTrackEndedHandler,
  AudioSourceError,
} from './audioSourceAcquisition'

const createMockTrack = (overrides: Partial<MediaStreamTrack> = {}): MediaStreamTrack => ({
  id: 'track-1',
  kind: 'audio',
  label: 'mock-audio',
  enabled: true,
  muted: false,
  readyState: 'live',
  stop: vi.fn(),
  addEventListener: vi.fn(),
  removeEventListener: vi.fn(),
  ...overrides,
} as MediaStreamTrack)

const createMockStream = (audioTracks: MediaStreamTrack[], videoTracks: MediaStreamTrack[] = []): MediaStream => ({
  getAudioTracks: () => audioTracks,
  getVideoTracks: () => videoTracks,
  getTracks: () => [...audioTracks, ...videoTracks],
  removeTrack: vi.fn(),
} as unknown as MediaStream)

describe('acquireAudioSource', () => {
  const originalMediaDevices = navigator.mediaDevices

  beforeEach(() => {
    vi.restoreAllMocks()
  })

  afterEach(() => {
    Object.defineProperty(navigator, 'mediaDevices', {
      value: originalMediaDevices,
      configurable: true,
    })
  })

  it('acquires microphone stream with noise suppression constraints', async () => {
    const audioTrack = createMockTrack()
    const getUserMedia = vi.fn().mockResolvedValue(createMockStream([audioTrack]))
    Object.defineProperty(navigator, 'mediaDevices', {
      value: {
        getUserMedia,
        getSupportedConstraints: vi.fn(() => ({ noiseSuppression: true })),
      },
      configurable: true,
    })

    const acquired = await acquireAudioSource({ source: 'microphone', noiseSuppressionEnabled: true })

    expect(getUserMedia).toHaveBeenCalledWith({
      audio: expect.objectContaining({
        noiseSuppression: true,
        echoCancellation: true,
        autoGainControl: true,
        channelCount: 1,
      }),
    })
    expect(acquired.stream).toBeDefined()
    acquired.cleanup()
    expect(audioTrack.stop).toHaveBeenCalled()
  })

  it('disables microphone noise suppression when toggle is false', async () => {
    const audioTrack = createMockTrack()
    const getUserMedia = vi.fn().mockResolvedValue(createMockStream([audioTrack]))
    Object.defineProperty(navigator, 'mediaDevices', {
      value: {
        getUserMedia,
        getSupportedConstraints: vi.fn(() => ({ noiseSuppression: true })),
      },
      configurable: true,
    })

    await acquireAudioSource({ source: 'microphone', noiseSuppressionEnabled: false })
    expect(getUserMedia).toHaveBeenCalledWith({
      audio: expect.objectContaining({
        noiseSuppression: false,
        echoCancellation: true,
        autoGainControl: true,
      }),
    })
  })

  it('keeps tab capture processing constraints disabled', async () => {
    const audioTrack = createMockTrack()
    const getDisplayMedia = vi.fn().mockResolvedValue(createMockStream([audioTrack]))
    Object.defineProperty(navigator, 'mediaDevices', {
      value: { getDisplayMedia },
      configurable: true,
    })

    await acquireAudioSource({ source: 'browser_tab' })
    expect(getDisplayMedia).toHaveBeenCalledWith(expect.objectContaining({
      audio: expect.objectContaining({
        echoCancellation: false,
        noiseSuppression: false,
        autoGainControl: false,
      }),
    }))
  })

  it('rejects browser tab stream without audio tracks', async () => {
    const videoTrack = createMockTrack({ kind: 'video' })
    const getDisplayMedia = vi.fn().mockResolvedValue(createMockStream([], [videoTrack]))
    Object.defineProperty(navigator, 'mediaDevices', {
      value: { getDisplayMedia },
      configurable: true,
    })

    await expect(acquireAudioSource({ source: 'browser_tab' })).rejects.toMatchObject({
      code: 'no_audio_track',
      message: expect.stringContaining('không có âm thanh'),
    })
    expect(videoTrack.stop).toHaveBeenCalled()
  })

  it('acquires browser tab stream when audio track exists', async () => {
    const audioTrack = createMockTrack()
    const videoTrack = createMockTrack({ id: 'video-1', kind: 'video' })
    const getDisplayMedia = vi.fn().mockResolvedValue(createMockStream([audioTrack], [videoTrack]))
    Object.defineProperty(navigator, 'mediaDevices', {
      value: { getDisplayMedia },
      configurable: true,
    })

    const acquired = await acquireAudioSource({ source: 'browser_tab' })

    expect(getDisplayMedia).toHaveBeenCalledWith(expect.objectContaining({
      audio: expect.objectContaining({
        suppressLocalAudioPlayback: false,
      }),
    }))
    expect(videoTrack.stop).toHaveBeenCalled()
    expect(acquired.source).toBe('browser_tab')
    acquired.cleanup()
    expect(audioTrack.stop).toHaveBeenCalled()
  })

  it('does not request local tab playback suppression', async () => {
    const audioTrack = createMockTrack()
    const getDisplayMedia = vi.fn().mockResolvedValue(createMockStream([audioTrack]))
    Object.defineProperty(navigator, 'mediaDevices', {
      value: { getDisplayMedia },
      configurable: true,
    })

    await acquireAudioSource({ source: 'browser_tab' })

    const constraints = getDisplayMedia.mock.calls[0]?.[0] as DisplayMediaStreamOptions
    expect(constraints.audio).toEqual(expect.objectContaining({
      suppressLocalAudioPlayback: false,
    }))
  })

  it('falls back to tab-only when microphone is unavailable for tab+mic source', async () => {
    const audioTrack = createMockTrack()
    const videoTrack = createMockTrack({ id: 'video-1', kind: 'video' })
    const getDisplayMedia = vi.fn().mockResolvedValue(createMockStream([audioTrack], [videoTrack]))
    const getUserMedia = vi.fn().mockRejectedValue(Object.assign(new Error('denied'), { name: 'NotAllowedError' }))
    Object.defineProperty(navigator, 'mediaDevices', {
      value: { getDisplayMedia, getUserMedia },
      configurable: true,
    })

    const acquired = await acquireAudioSource({ source: 'browser_tab_with_mic' })

    expect(acquired.source).toBe('browser_tab_with_mic')
    expect(acquired.stream.getAudioTracks()).toHaveLength(1)
    acquired.cleanup()
    expect(audioTrack.stop).toHaveBeenCalled()
  })

  it('maps permission denied for tab capture to Vietnamese guidance', async () => {
    const getDisplayMedia = vi.fn().mockRejectedValue(Object.assign(new Error('denied'), { name: 'NotAllowedError' }))
    Object.defineProperty(navigator, 'mediaDevices', {
      value: { getDisplayMedia },
      configurable: true,
    })

    await expect(acquireAudioSource({ source: 'browser_tab' })).rejects.toBeInstanceOf(AudioSourceError)
    await expect(acquireAudioSource({ source: 'browser_tab' })).rejects.toMatchObject({
      code: 'permission_denied',
      message: expect.stringContaining('chia sẻ tab'),
    })
  })

  it('maps picker cancel to cancelled error', async () => {
    const getDisplayMedia = vi.fn().mockRejectedValue(Object.assign(new Error('aborted'), { name: 'AbortError' }))
    Object.defineProperty(navigator, 'mediaDevices', {
      value: { getDisplayMedia },
      configurable: true,
    })

    await expect(acquireAudioSource({ source: 'browser_tab' })).rejects.toMatchObject({
      code: 'cancelled',
      message: expect.stringContaining('hủy chọn tab trình duyệt'),
    })
  })
})

describe('attachAudioTrackEndedHandler', () => {
  it('invokes callback when audio track ends and detaches on cleanup', () => {
    const listeners = new Map<string, () => void>()
    const track = createMockTrack({
      addEventListener: vi.fn((event: string, handler: () => void) => {
        if (event === 'ended') {
          listeners.set('ended', handler)
        }
      }),
      removeEventListener: vi.fn((event: string, handler: () => void) => {
        if (event === 'ended' && listeners.get('ended') === handler) {
          listeners.delete('ended')
        }
      }),
    })
    const stream = createMockStream([track])
    const onEnded = vi.fn()

    const detach = attachAudioTrackEndedHandler(stream, onEnded)
    listeners.get('ended')?.()
    expect(onEnded).toHaveBeenCalledWith(track)

    detach()
    expect(track.removeEventListener).toHaveBeenCalledWith('ended', expect.any(Function))
  })

  it('invokes onMuted when track mute event fires', () => {
    const listeners = new Map<string, () => void>()
    const track = createMockTrack({
      addEventListener: vi.fn((event: string, handler: () => void) => {
        listeners.set(event, handler)
      }),
      removeEventListener: vi.fn(),
    })
    const stream = createMockStream([track])
    const onMuted = vi.fn()

    attachAudioTrackEndedHandler(stream, vi.fn(), { onMuted })
    listeners.get('mute')?.()
    expect(onMuted).toHaveBeenCalledWith(track)
  })
})

describe('acquireDualTabMicSources', () => {
  const originalMediaDevices = navigator.mediaDevices

  afterEach(() => {
    Object.defineProperty(navigator, 'mediaDevices', {
      value: originalMediaDevices,
      configurable: true,
    })
  })

  it('passes noise suppression toggle and enables AEC/AGC on dual mic leg', async () => {
    const tabTrack = createMockTrack({ id: 'tab' })
    const micTrack = createMockTrack({ id: 'mic' })
    const getDisplayMedia = vi.fn().mockResolvedValue(createMockStream([tabTrack]))
    const getUserMedia = vi.fn().mockResolvedValue(createMockStream([micTrack]))
    Object.defineProperty(navigator, 'mediaDevices', {
      value: {
        getDisplayMedia,
        getUserMedia,
        getSupportedConstraints: vi.fn(() => ({ noiseSuppression: true })),
      },
      configurable: true,
    })

    const acquired = await acquireDualTabMicSources({ noiseSuppressionEnabled: true })
    expect(getUserMedia).toHaveBeenCalledWith({
      audio: expect.objectContaining({
        noiseSuppression: true,
        echoCancellation: true,
        autoGainControl: true,
        channelCount: 1,
      }),
    })
    expect(acquired.micIncluded).toBe(true)
    acquired.cleanup()
  })

  it('can disable dual mic noise suppression via toggle', async () => {
    const tabTrack = createMockTrack({ id: 'tab' })
    const micTrack = createMockTrack({ id: 'mic' })
    const getDisplayMedia = vi.fn().mockResolvedValue(createMockStream([tabTrack]))
    const getUserMedia = vi.fn().mockResolvedValue(createMockStream([micTrack]))
    Object.defineProperty(navigator, 'mediaDevices', {
      value: {
        getDisplayMedia,
        getUserMedia,
        getSupportedConstraints: vi.fn(() => ({ noiseSuppression: true })),
      },
      configurable: true,
    })

    await acquireDualTabMicSources({ noiseSuppressionEnabled: false })
    expect(getUserMedia).toHaveBeenCalledWith({
      audio: expect.objectContaining({
        noiseSuppression: false,
        echoCancellation: true,
        autoGainControl: true,
      }),
    })
  })
})
