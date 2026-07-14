import { createRoot } from 'react-dom/client'
import { act } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const createTabMicMixFromStreams = vi.fn()
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
  }
})

class FakeMediaRecorder {
  static instances: FakeMediaRecorder[] = []
  state: 'inactive' | 'recording' | 'paused' = 'inactive'
  mimeType = 'audio/webm;codecs=opus'
  ondataavailable: ((event: { data: Blob }) => void) | null = null
  private readonly streamLabel: string
  private readonly isFallback: boolean
  private stopListeners: Array<() => void> = []

  constructor(stream: MediaStream & { __label?: string }, _options?: MediaRecorderOptions) {
    this.streamLabel = stream.__label || 'unknown'
    this.isFallback = this.streamLabel === 'mixed'
    FakeMediaRecorder.instances.push(this)
  }

  start() {
    this.state = 'recording'
  }

  stop() {
    this.state = 'inactive'
    this.stopListeners.splice(0).forEach((listener) => listener())
  }

  requestData() {
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

describe('useDualAudioRecorder fallback blob', () => {
  let container: HTMLDivElement
  let root: ReturnType<typeof createRoot>
  let latest: ReturnType<typeof import('../hooks/useDualAudioRecorder').useDualAudioRecorder> | null

  beforeEach(() => {
    FakeMediaRecorder.instances = []
    vi.stubGlobal('MediaRecorder', Object.assign(FakeMediaRecorder, {
      isTypeSupported: () => true,
    }))
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
    latest = null

    const tabStream = {
      __label: 'tab',
      getAudioTracks: () => [{ readyState: 'live', enabled: true, muted: false, stop: vi.fn(), addEventListener: vi.fn(), removeEventListener: vi.fn() }],
      getTracks: () => [],
      getVideoTracks: () => [],
    } as unknown as MediaStream & { __label: string }
    const micStream = {
      __label: 'mic',
      getAudioTracks: () => [{ readyState: 'live', enabled: true, muted: false, stop: vi.fn(), addEventListener: vi.fn(), removeEventListener: vi.fn() }],
      getTracks: () => [],
      getVideoTracks: () => [],
    } as unknown as MediaStream & { __label: string }
    const mixedStream = {
      __label: 'mixed',
      getAudioTracks: () => [{ readyState: 'live', enabled: true, muted: false, stop: vi.fn() }],
      getTracks: () => [],
      getVideoTracks: () => [],
    } as unknown as MediaStream & { __label: string }

    acquireDualTabMicSources.mockResolvedValue({
      tab: { stream: tabStream, cleanup: vi.fn() },
      mic: { stream: micStream, cleanup: vi.fn() },
      micIncluded: true,
      cleanup: vi.fn(),
    })
    createTabMicMixFromStreams.mockResolvedValue({
      audioContext: { close: vi.fn().mockResolvedValue(undefined), state: 'running' },
      mixedStream,
      sourceTabStream: tabStream,
      sourceMicStream: micStream,
      sourceTabTrack: null,
      micAnalyser: { fftSize: 512, getByteTimeDomainData: vi.fn() },
      tabAnalyser: {},
      tabPostGainAnalyser: {},
      outputAnalyser: {},
      tabGain: {},
      tabDuckGain: 0.42,
      cleanupGraph: vi.fn(),
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

  it('builds fullBlob only from fallback mixed recorder chunks', async () => {
    const { useDualAudioRecorder } = await import('./useDualAudioRecorder')

    function Harness() {
      latest = useDualAudioRecorder({ noiseSuppressionEnabled: true })
      return null
    }

    await act(async () => {
      root.render(<Harness />)
    })

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
    // Realtime tab/mic recorders also produced chunks, but fullBlob must not concatenate them.
    expect(FakeMediaRecorder.instances).toHaveLength(3)
    expect(gracefulResult.extension).toBe('webm')
    expect(gracefulResult.mimeType).toContain('webm')
    expect(gracefulResult.fullBlob.size).toBe(gracefulResult.chunks[0]?.size)
  })
})
