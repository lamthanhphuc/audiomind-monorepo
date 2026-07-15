import { createRoot } from 'react-dom/client'
import { act } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const createTabMicMixFromStreams = vi.fn()
const createStandaloneMicAnalyser = vi.fn()
const acquireDualTabMicSources = vi.fn()
const attachAudioTrackEndedHandler = vi.fn(() => () => {})
const createTabAudioPipelineMonitor = vi.fn(() => ({
  cleanup: vi.fn(),
  notifyRecorderChunk: vi.fn(),
}))

vi.mock('../utils/audioSourceAcquisition', async () => {
  const actual = await vi.importActual<typeof import('../utils/audioSourceAcquisition')>('../utils/audioSourceAcquisition')
  return {
    ...actual,
    acquireDualTabMicSources,
    createTabMicMixFromStreams,
    createStandaloneMicAnalyser,
    attachAudioTrackEndedHandler,
    mapAudioSourceErrorMessage: (error: unknown) => (error instanceof Error ? error.message : 'error'),
  }
})

vi.mock('../utils/tabAudioPipeline', async () => {
  const actual = await vi.importActual<typeof import('../utils/tabAudioPipeline')>('../utils/tabAudioPipeline')
  return {
    ...actual,
    createTabAudioPipelineMonitor,
    ensureAudioContextRunning: vi.fn().mockResolvedValue(undefined),
    measureAnalyserRms: vi.fn(() => 0.1),
  }
})

class FakeMediaRecorder {
  static instances: FakeMediaRecorder[] = []
  static failStartForMixed = false
  static failCtorForMixed = false
  static mimeByLabel: Record<string, string> = {}
  static failStartForLabel: string | null = null
  state: 'inactive' | 'recording' | 'paused' = 'inactive'
  mimeType = 'audio/webm;codecs=opus'
  ondataavailable: ((event: { data: Blob }) => void) | null = null
  readonly streamLabel: string
  private readonly isFallback: boolean
  private stopListeners: Array<() => void> = []
  requestDataCalls = 0
  stopCalls = 0

  constructor(stream: MediaStream & { __label?: string }, _options?: MediaRecorderOptions) {
    this.streamLabel = stream.__label || 'unknown'
    this.isFallback = this.streamLabel === 'mixed'
    const overrideMime = FakeMediaRecorder.mimeByLabel[this.streamLabel]
    if (typeof overrideMime === 'string') {
      this.mimeType = overrideMime
    }
    if (this.isFallback && FakeMediaRecorder.failCtorForMixed) {
      throw new Error('fallback mediarecorder ctor failed')
    }
    FakeMediaRecorder.instances.push(this)
  }

  start() {
    if (this.isFallback && FakeMediaRecorder.failStartForMixed) {
      throw new Error('fallback start failed')
    }
    if (FakeMediaRecorder.failStartForLabel === this.streamLabel) {
      throw new Error(`${this.streamLabel} start failed`)
    }
    this.state = 'recording'
  }

  stop() {
    this.stopCalls += 1
    this.state = 'inactive'
    this.stopListeners.splice(0).forEach((listener) => listener())
  }

  requestData() {
    this.requestDataCalls += 1
    const marker = this.isFallback ? 'FALLBACK-CHUNK' : `${this.streamLabel}-CHUNK`
    this.ondataavailable?.({ data: new Blob([marker], { type: this.mimeType }) })
  }

  pause() {
    this.state = 'paused'
  }

  resume() {
    this.state = 'recording'
  }

  addEventListener(type: string, listener: EventListenerOrEventListenerObject) {
    if (type === 'stop' && typeof listener === 'function') {
      this.stopListeners.push(listener as () => void)
    }
  }
}

describe('useDualAudioRecorder', () => {
  let container: HTMLDivElement
  let root: ReturnType<typeof createRoot>
  let latest: ReturnType<typeof import('../hooks/useDualAudioRecorder').useDualAudioRecorder> | null
  let tabTrackStop: ReturnType<typeof vi.fn>
  let micTrackStop: ReturnType<typeof vi.fn>
  let mixerCleanup: ReturnType<typeof vi.fn>
  let audioContextClose: ReturnType<typeof vi.fn>

  beforeEach(() => {
    FakeMediaRecorder.instances = []
    FakeMediaRecorder.failStartForMixed = false
    FakeMediaRecorder.failCtorForMixed = false
    FakeMediaRecorder.mimeByLabel = {}
    FakeMediaRecorder.failStartForLabel = null
    vi.stubGlobal('MediaRecorder', Object.assign(FakeMediaRecorder, {
      isTypeSupported: () => true,
    }))
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
    latest = null
    tabTrackStop = vi.fn()
    micTrackStop = vi.fn()
    mixerCleanup = vi.fn()
    audioContextClose = vi.fn().mockResolvedValue(undefined)

    const tabStream = {
      __label: 'tab',
      getAudioTracks: () => [{ readyState: 'live', enabled: true, muted: false, stop: tabTrackStop, addEventListener: vi.fn(), removeEventListener: vi.fn() }],
      getTracks: () => [{ stop: tabTrackStop }],
      getVideoTracks: () => [],
    } as unknown as MediaStream & { __label: string }
    const micStream = {
      __label: 'mic',
      getAudioTracks: () => [{
        readyState: 'live',
        enabled: true,
        muted: false,
        stop: micTrackStop,
        getSettings: () => ({ noiseSuppression: true, echoCancellation: true, autoGainControl: true }),
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
      }],
      getTracks: () => [{ stop: micTrackStop }],
      getVideoTracks: () => [],
    } as unknown as MediaStream & { __label: string }
    const mixedStream = {
      __label: 'mixed',
      getAudioTracks: () => [{ readyState: 'live', enabled: true, muted: false, stop: vi.fn() }],
      getTracks: () => [],
      getVideoTracks: () => [],
    } as unknown as MediaStream & { __label: string }

    const acquiredCleanup = vi.fn(() => {
      tabTrackStop()
      micTrackStop()
    })

    acquireDualTabMicSources.mockResolvedValue({
      tab: { stream: tabStream, cleanup: vi.fn(() => tabTrackStop()) },
      mic: { stream: micStream, cleanup: vi.fn(() => micTrackStop()) },
      micIncluded: true,
      cleanup: acquiredCleanup,
    })
    createTabMicMixFromStreams.mockResolvedValue({
      audioContext: { close: audioContextClose, state: 'running' },
      mixedStream,
      sourceTabStream: tabStream,
      sourceMicStream: micStream,
      sourceTabTrack: null,
      micAnalyser: {
        fftSize: 512,
        getByteTimeDomainData: (buf: Uint8Array) => {
          buf.fill(140)
        },
      },
      tabAnalyser: {},
      tabPostGainAnalyser: {},
      outputAnalyser: {},
      tabGain: {},
      tabDuckGain: 0.42,
      cleanupGraph: mixerCleanup,
    })
    createStandaloneMicAnalyser.mockResolvedValue({
      audioContext: { close: vi.fn().mockResolvedValue(undefined), state: 'running' },
      analyser: {
        fftSize: 512,
        getByteTimeDomainData: (buf: Uint8Array) => {
          buf.fill(140)
        },
      },
      cleanup: vi.fn(),
    })
  })

  afterEach(() => {
    act(() => {
      root.unmount()
    })
    container.remove()
    vi.unstubAllGlobals()
    vi.clearAllMocks()
  })

  const renderHarness = async (recorderOptions: Record<string, unknown> = {}) => {
    const { useDualAudioRecorder } = await import('./useDualAudioRecorder')
    function Harness() {
      latest = useDualAudioRecorder({ noiseSuppressionEnabled: true, ...recorderOptions })
      return null
    }
    await act(async () => {
      root.render(<Harness />)
    })
  }

  it('builds fullBlob only from fallback mixed recorder chunks', async () => {
    await renderHarness()
    await act(async () => {
      await latest!.startRecording()
    })

    expect(FakeMediaRecorder.instances).toHaveLength(3)
    expect(createTabMicMixFromStreams).toHaveBeenCalledTimes(1)

    let gracefulResult!: Awaited<ReturnType<NonNullable<typeof latest>['stopRecordingGraceful']>>
    await act(async () => {
      gracefulResult = await latest!.stopRecordingGraceful()
    })

    expect(createTabMicMixFromStreams).toHaveBeenCalledTimes(1)
    expect(gracefulResult.chunks).toHaveLength(1)
    expect(gracefulResult.collectedChunkCount).toBe(1)
    expect(gracefulResult.chunks[0]?.size).toBe(new Blob(['FALLBACK-CHUNK']).size)
    expect(FakeMediaRecorder.instances).toHaveLength(3)
    expect(gracefulResult.extension).toBe('webm')
    expect(gracefulResult.mimeType).toContain('webm')
    expect(gracefulResult.fullBlob.size).toBe(gracefulResult.chunks[0]?.size)
  })

  it('stopRecording stops tracks, closes mixer, and is idempotent', async () => {
    await renderHarness()
    await act(async () => {
      await latest!.startRecording()
    })

    await act(async () => {
      latest!.stopRecording()
    })

    expect(tabTrackStop).toHaveBeenCalled()
    expect(micTrackStop).toHaveBeenCalled()
    expect(mixerCleanup).toHaveBeenCalled()

    await act(async () => {
      latest!.cleanupRecordingResources()
      latest!.cleanupRecordingResources()
    })
  })

  it('unmount while recording cleans up tracks and mixer', async () => {
    await renderHarness()
    await act(async () => {
      await latest!.startRecording()
    })

    await act(async () => {
      root.unmount()
    })

    expect(tabTrackStop).toHaveBeenCalled()
    expect(micTrackStop).toHaveBeenCalled()
    expect(mixerCleanup).toHaveBeenCalled()
  })

  it('dispatches final realtime chunk only once during graceful stop', async () => {
    const onChunkReady = vi.fn()
    await renderHarness({ onChunkReady })
    await act(async () => {
      await latest!.startRecording()
    })

    await act(async () => {
      await latest!.stopRecordingGraceful()
    })

    const tabCalls = onChunkReady.mock.calls.filter(([, streamId]) => streamId === 'tab')
    const micCalls = onChunkReady.mock.calls.filter(([, streamId]) => streamId === 'mic')
    expect(tabCalls).toHaveLength(1)
    expect(micCalls).toHaveLength(1)
    expect(onChunkReady.mock.calls.some(([, streamId]) => streamId === 'mixed')).toBe(false)
  })

  it('requests data and stops all three recorders before track cleanup', async () => {
    const stopOrder: string[] = []
    tabTrackStop.mockImplementation(() => stopOrder.push('tab-track'))
    micTrackStop.mockImplementation(() => stopOrder.push('mic-track'))
    mixerCleanup.mockImplementation(() => stopOrder.push('mixer'))

    await renderHarness()
    await act(async () => {
      await latest!.startRecording()
    })

    const [tabRec, micRec, fallbackRec] = FakeMediaRecorder.instances
    const originalTabStop = tabRec.stop.bind(tabRec)
    const originalMicStop = micRec.stop.bind(micRec)
    const originalFallbackStop = fallbackRec.stop.bind(fallbackRec)
    tabRec.stop = () => {
      stopOrder.push('tab-recorder')
      originalTabStop()
    }
    micRec.stop = () => {
      stopOrder.push('mic-recorder')
      originalMicStop()
    }
    fallbackRec.stop = () => {
      stopOrder.push('fallback-recorder')
      originalFallbackStop()
    }

    await act(async () => {
      await latest!.stopRecordingGraceful()
    })

    expect(tabRec.requestDataCalls).toBeGreaterThan(0)
    expect(micRec.requestDataCalls).toBeGreaterThan(0)
    expect(fallbackRec.requestDataCalls).toBeGreaterThan(0)

    const firstTrackIdx = stopOrder.findIndex((entry) => entry.endsWith('-track') || entry === 'mixer')
    const lastRecorderIdx = Math.max(
      stopOrder.lastIndexOf('tab-recorder'),
      stopOrder.lastIndexOf('mic-recorder'),
      stopOrder.lastIndexOf('fallback-recorder'),
    )
    expect(firstTrackIdx).toBeGreaterThan(lastRecorderIdx)
  })

  it('keeps realtime recorders when fallback mixer fails', async () => {
    createTabMicMixFromStreams.mockRejectedValueOnce(new Error('mixer boom'))
    await renderHarness()
    await act(async () => {
      await latest!.startRecording()
    })

    expect(FakeMediaRecorder.instances).toHaveLength(2)
    expect(latest!.state).toBe('recording')
    expect(latest!.getActiveStreamIds?.()).toEqual(['tab', 'mic'])

    let result!: Awaited<ReturnType<NonNullable<typeof latest>['stopRecordingGraceful']>>
    await act(async () => {
      result = await latest!.stopRecordingGraceful()
    })
    expect(result.fullBlob).toBeTruthy()
    expect(result.chunks.every((chunk) => !chunk.type.includes('FALLBACK'))).toBe(true)
  })

  it('keeps realtime when fallback MediaRecorder constructor throws and cleans mixer', async () => {
    FakeMediaRecorder.failCtorForMixed = true
    await renderHarness()
    await act(async () => {
      await latest!.startRecording()
    })
    expect(FakeMediaRecorder.instances).toHaveLength(2)
    expect(latest!.state).toBe('recording')
    expect(mixerCleanup).toHaveBeenCalled()
  })

  it('cleans mixer when fallback MediaRecorder start throws', async () => {
    FakeMediaRecorder.failStartForMixed = true
    await renderHarness()
    await act(async () => {
      await latest!.startRecording()
    })
    expect(latest!.state).toBe('recording')
    expect(FakeMediaRecorder.instances.length).toBeGreaterThanOrEqual(2)
    expect(mixerCleanup).toHaveBeenCalled()
  })

  it('exposes mic health and RMS after fallback mixer failure', async () => {
    createTabMicMixFromStreams.mockRejectedValueOnce(new Error('mixer boom'))
    await renderHarness()
    await act(async () => {
      await latest!.startRecording()
    })
    expect(latest!.state).toBe('recording')
    expect(latest).toHaveProperty('micHealthIssue')
    expect(typeof latest!.getCurrentRms()).toBe('number')
  })

  it('exposes mic health message when dual mic leg is active', async () => {
    await renderHarness()
    await act(async () => {
      await latest!.startRecording()
    })
    expect(latest).toHaveProperty('micHealthIssue')
    expect(latest).toHaveProperty('micHealthMessage')
  })

  it('cleans tab recorder when mic actual MIME is invalid before start', async () => {
    FakeMediaRecorder.mimeByLabel = { mic: 'audio/webm;codecs=vorbis' }
    const onChunkReady = vi.fn()
    await renderHarness({ onChunkReady })
    await act(async () => {
      await expect(latest!.startRecording()).rejects.toMatchObject({
        code: 'REALTIME_UNSUPPORTED_RECORDER_FORMAT',
      })
    })

    expect(latest!.state).toBe('error')
    expect(latest!.getActiveStreamIds?.()).toEqual([])
    expect(onChunkReady).not.toHaveBeenCalled()
    const tabRecorder = FakeMediaRecorder.instances.find((instance) => instance.streamLabel === 'tab')
    expect(tabRecorder).toBeTruthy()
    expect(tabRecorder!.state).toBe('inactive')
    expect(tabRecorder!.ondataavailable).toBeNull()
    expect(tabTrackStop).toHaveBeenCalled()
    expect(micTrackStop).toHaveBeenCalled()
  })

  it('stops first started recorder when second start throws', async () => {
    FakeMediaRecorder.failStartForLabel = 'mic'
    const onChunkReady = vi.fn()
    await renderHarness({ onChunkReady })
    await act(async () => {
      await expect(latest!.startRecording()).rejects.toThrow('mic start failed')
    })

    expect(latest!.state).toBe('error')
    expect(onChunkReady).not.toHaveBeenCalled()
    const tabRecorder = FakeMediaRecorder.instances.find((instance) => instance.streamLabel === 'tab')
    const micRecorder = FakeMediaRecorder.instances.find((instance) => instance.streamLabel === 'mic')
    expect(tabRecorder?.state).toBe('inactive')
    expect(tabRecorder?.stopCalls).toBeGreaterThan(0)
    expect(tabRecorder?.ondataavailable).toBeNull()
    expect(micRecorder?.ondataavailable).toBeNull()
    expect(micRecorder?.state).toBe('inactive')
    expect(tabTrackStop).toHaveBeenCalled()
    expect(micTrackStop).toHaveBeenCalled()
  })
})
