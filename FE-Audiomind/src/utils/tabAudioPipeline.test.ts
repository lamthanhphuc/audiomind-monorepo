import { describe, expect, it, vi } from 'vitest'
import {
  createTabAudioPipelineMonitor,
  ensureAudioContextRunning,
  isTabCaptureSilent,
  measureAnalyserRms,
  resolveTabMicGateGains,
  snapshotTabTrack,
  TAB_AUDIO_PIPELINE_MARKERS,
} from './tabAudioPipeline'

type FakeTrack = MediaStreamTrack & {
  listeners: Map<string, Set<() => void>>
}

const makeTrack = (overrides: Partial<MediaStreamTrack> = {}): FakeTrack => {
  const listeners = new Map<string, Set<() => void>>()
  return {
    id: 'tab-track',
    kind: 'audio',
    readyState: 'live',
    muted: false,
    enabled: true,
    listeners,
    addEventListener: (event: string, handler: EventListenerOrEventListenerObject) => {
      const callback = () => {
        if (typeof handler === 'function') {
          handler(new Event(event))
          return
        }
        handler.handleEvent(new Event(event))
      }
      listeners.set(event, listeners.get(event) ?? new Set())
      listeners.get(event)?.add(callback)
    },
    removeEventListener: (event: string) => {
      listeners.get(event)?.clear()
    },
    ...overrides,
  } as FakeTrack
}

const emitTrack = (track: FakeTrack, event: string) => {
  track.listeners.get(event)?.forEach((callback) => callback())
}

const makeStream = (track: MediaStreamTrack): MediaStream => ({
  getAudioTracks: () => [track],
}) as unknown as MediaStream

const makeAnalyser = (rms: 'silent' | 'active'): AnalyserNode => ({
  fftSize: 4,
  frequencyBinCount: 4,
  getByteTimeDomainData: (buffer: Uint8Array) => {
    buffer.fill(rms === 'silent' ? 128 : 255)
  },
}) as unknown as AnalyserNode

describe('resolveTabMicGateGains', () => {
  it('keeps tab gain above zero during mic priority (duck, never mute)', () => {
    const gains = resolveTabMicGateGains({
      micPriority: true,
      tabPassGain: 0.38,
      tabDuckGain: 0.12,
      micPassGain: 6,
      micIdleGain: 0,
    })
    expect(gains.tabGain).toBeGreaterThan(0)
    expect(gains.tabGain).toBeGreaterThanOrEqual(0.285)
    expect(gains.micGain).toBe(6)
  })

  it('keeps mic present while restoring tab pass gain when mic is idle', () => {
    const gains = resolveTabMicGateGains({
      micPriority: false,
      tabPassGain: 0.38,
      tabDuckGain: 0.12,
      micPassGain: 6,
      micIdleGain: 0,
    })
    expect(gains.tabGain).toBe(0.38)
    expect(gains.micGain).toBe(6)
  })

  it('does not let activeSource=mic hard-mute the tab path', () => {
    const gains = resolveTabMicGateGains({
      micPriority: true,
      tabPassGain: 0.5,
      tabDuckGain: 0,
      micPassGain: 1.15,
      micIdleGain: 0,
    })

    expect(gains.tabGain).toBeGreaterThan(0)
    expect(gains.micGain).toBe(1.15)
  })
})

describe('snapshotTabTrack', () => {
  it('captures readyState, muted, enabled, and kind', () => {
    const track = {
      id: 'tab-track-1',
      readyState: 'live',
      muted: true,
      enabled: true,
      kind: 'audio',
    } as MediaStreamTrack

    expect(snapshotTabTrack(track)).toEqual({
      trackId: 'tab-track-1',
      readyState: 'live',
      muted: true,
      enabled: true,
      kind: 'audio',
    })
  })
})

describe('isTabCaptureSilent', () => {
  it('treats near-zero RMS as silent', () => {
    expect(isTabCaptureSilent(0.001)).toBe(true)
    expect(isTabCaptureSilent(0.02)).toBe(false)
    expect(isTabCaptureSilent(null)).toBe(true)
  })
})

describe('measureAnalyserRms', () => {
  it('returns zero for a flat analyser buffer', () => {
    const analyser = {
      getByteTimeDomainData: (buffer: Uint8Array) => {
        buffer.fill(128)
      },
    } as AnalyserNode
    const buffer = new Uint8Array(128)
    expect(measureAnalyserRms(analyser, buffer)).toBe(0)
  })
})

describe('ensureAudioContextRunning', () => {
  it('resumes suspended audio contexts when allowed', async () => {
    const resume = vi.fn().mockResolvedValue(undefined)
    const context = {
      state: 'suspended',
      resume,
    } as unknown as AudioContext

    const state = await ensureAudioContextRunning(context)
    expect(resume).toHaveBeenCalledTimes(1)
    expect(state).toBe('suspended')
  })
})

describe('createTabAudioPipelineMonitor', () => {
  it('diagnoses extended tab silence without reporting a capture stall or error', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const track = makeTrack()
    const onPipelineStalled = vi.fn()
    const onCaptureError = vi.fn()

    const monitor = createTabAudioPipelineMonitor({
      stream: makeStream(track),
      sourceTrack: track,
      sessionId: 1,
      preGainAnalyser: makeAnalyser('silent'),
      postGainAnalyser: makeAnalyser('silent'),
      stallThresholdMs: 0,
      onPipelineStalled,
      onCaptureError,
    })

    monitor.notifyRecorderChunk({ seq: 3, bytes: 1024, elapsedMs: 9000 })

    expect(onPipelineStalled).not.toHaveBeenCalled()
    expect(onCaptureError).not.toHaveBeenCalled()
    expect(warn).toHaveBeenCalledWith(
      '[Realtime]',
      TAB_AUDIO_PIPELINE_MARKERS.SILENCE_DETECTED,
      expect.objectContaining({ streamId: 'tab' }),
    )

    monitor.cleanup()
    warn.mockRestore()
  })

  it('reports tab post-gain mismatch even when mixed mic output is active', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    vi.spyOn(console, 'info').mockImplementation(() => {})
    const track = makeTrack()
    const onPipelineStalled = vi.fn()
    const onCaptureError = vi.fn()
    const tabGain = { gain: { value: 0.05 } } as GainNode
    const now = vi.spyOn(performance, 'now')
    now.mockReturnValueOnce(0)
      .mockReturnValueOnce(0)
      .mockReturnValue(9000)

    const monitor = createTabAudioPipelineMonitor({
      stream: makeStream(track),
      sourceTrack: track,
      sessionId: 1,
      preGainAnalyser: makeAnalyser('active'),
      postGainAnalyser: makeAnalyser('silent'),
      mixedOutputAnalyser: makeAnalyser('active'),
      tabGain,
      minTabGain: 0.12,
      stallThresholdMs: 8000,
      onPipelineStalled,
      onCaptureError,
    })

    monitor.notifyRecorderChunk({ seq: 3, bytes: 1024, elapsedMs: 9000 })

    expect(onPipelineStalled).toHaveBeenCalledTimes(1)
    expect(onCaptureError).not.toHaveBeenCalled()
    expect(tabGain.gain.value).toBe(0.12)
    expect(onPipelineStalled).toHaveBeenCalledWith(expect.objectContaining({
      mixedOutputRms: expect.any(Number),
      outputRms: 0,
    }))

    monitor.cleanup()
    vi.restoreAllMocks()
  })

  it('does not stall when tab post-gain and mixed output are active', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const track = makeTrack()
    const onPipelineStalled = vi.fn()
    const monitor = createTabAudioPipelineMonitor({
      stream: makeStream(track),
      sourceTrack: track,
      sessionId: 1,
      preGainAnalyser: makeAnalyser('active'),
      postGainAnalyser: makeAnalyser('active'),
      mixedOutputAnalyser: makeAnalyser('active'),
      stallThresholdMs: 0,
      onPipelineStalled,
    })

    monitor.notifyRecorderChunk({ seq: 3, bytes: 1024, elapsedMs: 9000 })

    expect(onPipelineStalled).not.toHaveBeenCalled()

    monitor.cleanup()
    vi.restoreAllMocks()
  })

  it('treats source tab mute as one warning callback without capture failure', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const track = makeTrack({ muted: true })
    const onTrackMuted = vi.fn()
    const onCaptureError = vi.fn()
    const monitor = createTabAudioPipelineMonitor({
      stream: makeStream(track),
      sourceTrack: track,
      sessionId: 1,
      preGainAnalyser: makeAnalyser('silent'),
      onTrackMuted,
      onCaptureError,
    })

    emitTrack(track, 'mute')

    expect(onTrackMuted).toHaveBeenCalledTimes(1)
    expect(onCaptureError).not.toHaveBeenCalled()

    monitor.cleanup()
    vi.restoreAllMocks()
  })

  it('treats source tab ended as terminal once without duplicate capture error', () => {
    vi.spyOn(console, 'info').mockImplementation(() => {})
    const track = makeTrack({ readyState: 'ended' })
    const onTrackEnded = vi.fn()
    const onCaptureError = vi.fn()
    const monitor = createTabAudioPipelineMonitor({
      stream: makeStream(track),
      sourceTrack: track,
      sessionId: 1,
      preGainAnalyser: makeAnalyser('silent'),
      onTrackEnded,
      onCaptureError,
    })

    emitTrack(track, 'ended')

    expect(onTrackEnded).toHaveBeenCalledTimes(1)
    expect(onCaptureError).not.toHaveBeenCalled()

    monitor.cleanup()
    vi.restoreAllMocks()
  })
})
