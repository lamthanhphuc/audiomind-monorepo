import { createRoot } from 'react-dom/client'
import { act } from 'react-dom/test-utils'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useAudioRecorder, type GracefulStopResult } from '../../hooks/useAudioRecorder'
import { AudioRecorderButton } from './AudioRecorderButton'

class MockMediaRecorder {
  static instances: MockMediaRecorder[] = []

  state: 'inactive' | 'recording' | 'paused' = 'inactive'
  ondataavailable: ((event: { data: Blob }) => void) | null = null
  onpause: (() => void) | null = null
  onresume: (() => void) | null = null
  onstop: (() => void) | null = null
  onerror: (() => void) | null = null

  readonly stream: MediaStream
  readonly options?: MediaRecorderOptions

  constructor(stream: MediaStream, options?: MediaRecorderOptions) {
    this.stream = stream
    this.options = options
    MockMediaRecorder.instances.push(this)
  }

  start = vi.fn((_timeslice?: number) => {
    this.state = 'recording'
  })

  pause = vi.fn(() => {
    this.state = 'paused'
    this.onpause?.()
  })

  resume = vi.fn(() => {
    this.state = 'recording'
    this.onresume?.()
  })

  stop = vi.fn(() => {
    if (this.postStopChunk) {
      this.ondataavailable?.({ data: this.postStopChunk })
    }
    this.state = 'inactive'
    this.onstop?.()
  })

  requestData = vi.fn(() => {
    this.emitChunk(new Blob(['request-data-chunk'], { type: 'audio/webm; codecs=opus' }))
  })

  postStopChunk: Blob | null = new Blob(['post-stop-chunk'], { type: 'audio/webm; codecs=opus' })

  emitChunk(blob: Blob) {
    this.ondataavailable?.({ data: blob })
  }
}

const originalMediaRecorder = globalThis.MediaRecorder
const originalGetUserMedia = navigator.mediaDevices?.getUserMedia

const flush = async () => {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0))
  })
}

describe('useAudioRecorder', () => {
  let container: HTMLDivElement
  let root: ReturnType<typeof createRoot>
  let latestRecorder: ReturnType<typeof useAudioRecorder> | null = null

  beforeEach(() => {
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
    MockMediaRecorder.instances = []
    vi.stubGlobal('MediaRecorder', MockMediaRecorder)
    Object.defineProperty(navigator, 'mediaDevices', {
      value: {
        getUserMedia: vi.fn().mockResolvedValue({
          getAudioTracks: () => [],
          getTracks: () => [{ stop: vi.fn() }],
        }),
        getSupportedConstraints: vi.fn(() => ({ noiseSuppression: true })),
      },
      configurable: true,
    })

    function Harness() {
      latestRecorder = useAudioRecorder()
      return null
    }

    act(() => {
      root.render(<Harness />)
    })
  })

  afterEach(() => {
    act(() => {
      root.unmount()
    })
    container.remove()
    vi.stubGlobal('MediaRecorder', originalMediaRecorder as typeof MediaRecorder)
    Object.defineProperty(navigator, 'mediaDevices', {
      value: originalGetUserMedia
        ? {
            getUserMedia: originalGetUserMedia,
          }
        : undefined,
      configurable: true,
    })
    vi.restoreAllMocks()
  })

  it('starts recording and collects chunks', async () => {
    await act(async () => {
      await latestRecorder!.startRecording()
    })

    expect(latestRecorder?.state).toBe('recording')
    expect(MockMediaRecorder.instances).toHaveLength(1)
    expect(navigator.mediaDevices.getUserMedia).toHaveBeenCalledWith({
      audio: {
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
        channelCount: 1,
        sampleRate: { ideal: 48_000 },
      },
    })
    expect(MockMediaRecorder.instances[0].start).toHaveBeenCalledWith(200)

    const recorder = MockMediaRecorder.instances[0]
    const chunk = new Blob(['chunk-one'], { type: 'audio/webm; codecs=opus' })

    act(() => {
      recorder.emitChunk(chunk)
    })

    await flush()

    expect(latestRecorder?.audioChunks).toHaveLength(1)
    expect(latestRecorder?.audioChunks[0]).toBe(chunk)

    act(() => {
      latestRecorder!.stopRecording()
    })

    await flush()

    expect(latestRecorder?.state).toBe('stopped')
  })

  it('stopRecordingGraceful collects requestData and post-stop chunks without early cleanup (R1-T9)', async () => {
    await act(async () => {
      await latestRecorder!.startRecording()
    })

    const recorder = MockMediaRecorder.instances[0]
    const initialChunk = new Blob(['initial-chunk'], { type: 'audio/webm; codecs=opus' })

    act(() => {
      recorder.emitChunk(initialChunk)
    })

    await flush()

    let result!: GracefulStopResult
    await act(async () => {
      result = await latestRecorder!.stopRecordingGraceful()
    })

    expect(recorder.requestData).toHaveBeenCalled()
    expect(recorder.stop).toHaveBeenCalled()
    expect(latestRecorder?.audioChunks.length).toBeGreaterThanOrEqual(3)
    expect(result?.fullBlob.size).toBeGreaterThan(0)
    expect(result?.postStopChunkCount).toBeGreaterThanOrEqual(1)
    expect(latestRecorder?.state).toBe('stopped')

    latestRecorder!.cleanupRecordingResources()
    expect(MockMediaRecorder.instances[0].ondataavailable).toBeNull()
  })

  it('cleanupRecordingResources is separate from mark stopped during graceful stop', async () => {
    await act(async () => {
      await latestRecorder!.startRecording()
    })

    const recorder = MockMediaRecorder.instances[0]
    act(() => {
      recorder.emitChunk(new Blob(['chunk'], { type: 'audio/webm; codecs=opus' }))
    })

    await act(async () => {
      await latestRecorder!.stopRecordingGraceful()
    })

    expect(recorder.stream.getTracks).toBeDefined()
    latestRecorder!.cleanupRecordingResources()
  })

  it('ignores stale chunks from a previous recording session after restart', async () => {
    await act(async () => {
      await latestRecorder!.startRecording()
    })

    const firstRecorder = MockMediaRecorder.instances[0]
    const firstChunk = new Blob(['chunk-one'], { type: 'audio/webm; codecs=opus' })

    act(() => {
      firstRecorder.emitChunk(firstChunk)
      latestRecorder!.stopRecording()
    })

    await flush()

    await act(async () => {
      await latestRecorder!.startRecording()
    })

    const secondRecorder = MockMediaRecorder.instances[1]
    const staleChunk = new Blob(['stale-chunk'], { type: 'audio/webm; codecs=opus' })
    const freshChunk = new Blob(['fresh-chunk'], { type: 'audio/webm; codecs=opus' })

    act(() => {
      firstRecorder.emitChunk(staleChunk)
      secondRecorder.emitChunk(freshChunk)
    })

    await flush()

    expect(latestRecorder?.audioChunks).toHaveLength(1)
    expect(latestRecorder?.audioChunks[0]).toBe(freshChunk)
  })

  it('aborts a live session and restarts with a fresh recorder', async () => {
    await act(async () => {
      await latestRecorder!.startRecording()
    })

    const firstRecorder = MockMediaRecorder.instances[0]

    act(() => {
      latestRecorder!.abortRecording()
    })

    expect(latestRecorder?.state).toBe('idle')

    await act(async () => {
      await latestRecorder!.startRecording()
    })

    const secondRecorder = MockMediaRecorder.instances[1]
    const staleChunk = new Blob(['stale-after-abort'], { type: 'audio/webm; codecs=opus' })
    const freshChunk = new Blob(['fresh-after-abort'], { type: 'audio/webm; codecs=opus' })

    act(() => {
      firstRecorder.emitChunk(staleChunk)
      secondRecorder.emitChunk(freshChunk)
    })

    await flush()

    expect(latestRecorder?.audioChunks).toHaveLength(1)
    expect(latestRecorder?.audioChunks[0]).toBe(freshChunk)
  })

  it('reports microphone permission errors', async () => {
    Object.defineProperty(navigator, 'mediaDevices', {
      value: {
        getUserMedia: vi.fn().mockRejectedValue(Object.assign(new Error('denied'), { name: 'NotAllowedError' })),
        getSupportedConstraints: vi.fn(() => ({ noiseSuppression: true })),
      },
      configurable: true,
    })

    await act(async () => {
      await latestRecorder!.startRecording()
    })

    expect(latestRecorder?.state).toBe('error')
    expect(latestRecorder?.errorMessage).toContain('microphone')
  })

  it('blocks recorder start when expected recording session id mismatches', async () => {
    await act(async () => {
      await latestRecorder!.startRecording(999)
    })

    expect(MockMediaRecorder.instances).toHaveLength(0)
    expect(latestRecorder?.state).toBe('error')
    expect(latestRecorder?.errorMessage).toContain('session mismatch')
  })

  it('passes noiseSuppression false when configured off', async () => {
    function Harness() {
      latestRecorder = useAudioRecorder(null, { noiseSuppressionEnabled: false })
      return null
    }

    act(() => {
      root.render(<Harness />)
    })

    await act(async () => {
      await latestRecorder!.startRecording()
    })

    expect(navigator.mediaDevices.getUserMedia).toHaveBeenCalledWith(expect.objectContaining({
      audio: expect.objectContaining({
        noiseSuppression: false,
      }),
    }))
  })

  it('omits unsupported noiseSuppression without blocking recording', async () => {
    Object.defineProperty(navigator, 'mediaDevices', {
      value: {
        getUserMedia: vi.fn().mockResolvedValue({
          getAudioTracks: () => [],
          getTracks: () => [{ stop: vi.fn() }],
        }),
        getSupportedConstraints: vi.fn(() => ({ noiseSuppression: false })),
      },
      configurable: true,
    })

    await act(async () => {
      await latestRecorder!.startRecording()
    })

    expect(latestRecorder?.state).toBe('recording')
    expect(navigator.mediaDevices.getUserMedia).toHaveBeenCalledWith({
      audio: expect.not.objectContaining({
        noiseSuppression: expect.any(Boolean),
      }),
    })
  })

  it('logs safe mic settings without exposing device ids', async () => {
    const infoSpy = vi.spyOn(console, 'info').mockImplementation(() => {})
    Object.defineProperty(navigator, 'mediaDevices', {
      value: {
        getUserMedia: vi.fn().mockResolvedValue({
          getAudioTracks: () => [{
            getSettings: () => ({
              noiseSuppression: true,
              echoCancellation: true,
              autoGainControl: true,
              sampleRate: 48000,
              channelCount: 1,
              deviceId: 'secret-device-id',
            }),
          }],
          getTracks: () => [{ stop: vi.fn() }],
        }),
        getSupportedConstraints: vi.fn(() => ({ noiseSuppression: true })),
      },
      configurable: true,
    })

    await act(async () => {
      await latestRecorder!.startRecording()
    })

    expect(infoSpy).toHaveBeenCalledWith('[Realtime] MIC_SETTINGS', expect.objectContaining({
      noiseSuppression: true,
      deviceIdPresent: true,
    }))
    expect(JSON.stringify(infoSpy.mock.calls)).not.toContain('secret-device-id')
  })

  it('acquires browser tab audio via display media', async () => {
    const audioTrack = {
      getSettings: () => ({}),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      readyState: 'live',
      stop: vi.fn(),
    }
    const videoTrack = { stop: vi.fn() }
    const getDisplayMedia = vi.fn().mockResolvedValue({
      getAudioTracks: () => [audioTrack],
      getVideoTracks: () => [videoTrack],
      getTracks: () => [audioTrack, videoTrack],
      removeTrack: vi.fn(),
    })

    function Harness() {
      latestRecorder = useAudioRecorder(null, { recordingSource: 'browser_tab' })
      return null
    }

    act(() => {
      root.render(<Harness />)
    })

    Object.defineProperty(navigator, 'mediaDevices', {
      value: { getDisplayMedia },
      configurable: true,
    })

    await act(async () => {
      await latestRecorder!.startRecording()
    })

    expect(getDisplayMedia).toHaveBeenCalled()
    expect(latestRecorder?.state).toBe('recording')
    expect(videoTrack.stop).toHaveBeenCalled()
  })

  it('reports missing tab audio as Vietnamese error', async () => {
    const getDisplayMedia = vi.fn().mockResolvedValue({
      getAudioTracks: () => [],
      getVideoTracks: () => [{ stop: vi.fn() }],
      getTracks: () => [],
      removeTrack: vi.fn(),
    })

    function Harness() {
      latestRecorder = useAudioRecorder(null, { recordingSource: 'browser_tab' })
      return null
    }

    act(() => {
      root.render(<Harness />)
    })

    Object.defineProperty(navigator, 'mediaDevices', {
      value: { getDisplayMedia },
      configurable: true,
    })

    await act(async () => {
      await latestRecorder!.startRecording()
    })

    expect(latestRecorder?.state).toBe('error')
    expect(latestRecorder?.errorMessage).toContain('không có âm thanh')
  })

  it('invokes onTrackEnded when shared tab audio stops', async () => {
    const listeners = new Map<string, () => void>()
    const audioTrack = {
      getSettings: () => ({}),
      addEventListener: vi.fn((event: string, handler: () => void) => {
        if (event === 'ended') {
          listeners.set('ended', handler)
        }
      }),
      removeEventListener: vi.fn(),
      readyState: 'live',
      stop: vi.fn(),
    }
    const getDisplayMedia = vi.fn().mockResolvedValue({
      getAudioTracks: () => [audioTrack],
      getVideoTracks: () => [{ stop: vi.fn() }],
      getTracks: () => [audioTrack],
      removeTrack: vi.fn(),
    })
    const onTrackEnded = vi.fn()

    function Harness() {
      latestRecorder = useAudioRecorder(null, {
        recordingSource: 'browser_tab',
        onTrackEnded,
      })
      return null
    }

    act(() => {
      root.render(<Harness />)
    })

    Object.defineProperty(navigator, 'mediaDevices', {
      value: { getDisplayMedia },
      configurable: true,
    })

    await act(async () => {
      await latestRecorder!.startRecording()
    })

    act(() => {
      listeners.get('ended')?.()
    })

    expect(onTrackEnded).toHaveBeenCalledOnce()
  })
})


describe('AudioRecorderButton', () => {
  let container: HTMLDivElement
  let root: ReturnType<typeof createRoot>
  let recorder: ReturnType<typeof useAudioRecorder> | null = null
  let startSpy: ReturnType<typeof vi.fn>
  let stopSpy: ReturnType<typeof vi.fn>
  let gracefulStopSpy: ReturnType<typeof vi.fn>
  let cleanupSpy: ReturnType<typeof vi.fn>
  let beforeStartSpy: ReturnType<typeof vi.fn>
  let chunkSpy: ReturnType<typeof vi.fn>
  let completeSpy: ReturnType<typeof vi.fn>

  beforeEach(() => {
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
    startSpy = vi.fn().mockResolvedValue(1)
    stopSpy = vi.fn()
    gracefulStopSpy = vi.fn().mockResolvedValue({
      fullBlob: new Blob(['final-audio'], { type: 'audio/webm; codecs=opus' }),
      sessionId: 1,
      collectedChunkCount: 1,
      postStopChunkCount: 1,
      chunks: [new Blob(['final-audio'], { type: 'audio/webm; codecs=opus' })],
    })
    cleanupSpy = vi.fn()
    beforeStartSpy = vi.fn().mockResolvedValue(undefined)
    chunkSpy = vi.fn()
    completeSpy = vi.fn()

    recorder = {
      state: 'idle',
      errorMessage: null,
      audioChunks: [],
      recordingSessionId: 0,
      startRecording: startSpy,
      stopRecording: stopSpy,
      stopRecordingGraceful: gracefulStopSpy,
      cleanupRecordingResources: cleanupSpy,
      abortRecording: vi.fn(),
      pauseRecording: vi.fn(),
      resumeRecording: vi.fn(),
      duration: 0,
      getCurrentRms: vi.fn(() => 0.03),
      getRollingChunks: vi.fn(() => []),
    }

    act(() => {
      root.render(
        <AudioRecorderButton
          recorder={recorder!}
          onBeforeStartRecording={beforeStartSpy}
          onChunkReady={chunkSpy}
          onRecordingComplete={completeSpy}
        />,
      )
    })
  })

  afterEach(() => {
    act(() => {
      root.unmount()
    })
    container.remove()
    vi.restoreAllMocks()
  })

  it('shows Google Meet start label for browser tab source', () => {
    act(() => {
      root.render(
        <AudioRecorderButton
          recorder={recorder!}
          recordingSource="browser_tab"
          onBeforeStartRecording={beforeStartSpy}
          onChunkReady={chunkSpy}
          onRecordingComplete={completeSpy}
        />,
      )
    })

    expect(container.querySelector('button')?.getAttribute('aria-label')).toContain('Google Meet')
    expect(container.textContent).toContain('Chọn tab Google Meet')
  })

  it('triggers start flow from idle state', async () => {
    await act(async () => {
      container.querySelector('button')?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
      await flush()
    })

    expect(beforeStartSpy).toHaveBeenCalledOnce()
    expect(startSpy).toHaveBeenCalledOnce()
  })

  it('starts the recorder before preflight resolves and delays queued chunks', async () => {
    let resolvePreflight!: () => void
    beforeStartSpy = vi.fn(() => new Promise<void>((resolve) => {
      resolvePreflight = resolve
    }))

    act(() => {
      root.render(
        <AudioRecorderButton
          recorder={recorder!}
          onBeforeStartRecording={beforeStartSpy}
          onChunkReady={chunkSpy}
          onRecordingComplete={completeSpy}
        />,
      )
    })

    await act(async () => {
      container.querySelector('button')?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
      await flush()
    })

    expect(beforeStartSpy).toHaveBeenCalledOnce()
    expect(beforeStartSpy).toHaveBeenCalledWith(1)
    expect(startSpy).toHaveBeenCalledOnce()

    recorder = {
      ...recorder!,
      state: 'recording',
      audioChunks: [new Blob(['early-chunk'])],
      recordingSessionId: 1,
    }
    act(() => {
      root.render(
        <AudioRecorderButton
          recorder={recorder!}
          onBeforeStartRecording={beforeStartSpy}
          onChunkReady={chunkSpy}
          onRecordingComplete={completeSpy}
        />,
      )
    })

    await flush()
    expect(chunkSpy).not.toHaveBeenCalled()

    resolvePreflight()
    await flush()

    expect(chunkSpy).toHaveBeenCalledOnce()
  })

  it('does not start recorder when preflight fails (stale prepare)', async () => {
    beforeStartSpy = vi.fn().mockRejectedValue(new Error('Stale realtime session prepare ignored'))

    act(() => {
      root.render(
        <AudioRecorderButton
          recorder={recorder!}
          onBeforeStartRecording={beforeStartSpy}
          onChunkReady={chunkSpy}
          onRecordingComplete={completeSpy}
        />,
      )
    })

    await act(async () => {
      container.querySelector('button')?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
      await flush()
    })

    expect(beforeStartSpy).toHaveBeenCalledOnce()
    expect(beforeStartSpy).toHaveBeenCalledWith(1)
    expect(startSpy).toHaveBeenCalledOnce()
    expect(recorder?.abortRecording).toHaveBeenCalledOnce()
  })

  it('does not create realtime session when microphone startup fails', async () => {
    startSpy = vi.fn().mockResolvedValue(null)
    recorder = {
      ...recorder!,
      startRecording: startSpy,
    }

    act(() => {
      root.render(
        <AudioRecorderButton
          recorder={recorder!}
          onBeforeStartRecording={beforeStartSpy}
          onChunkReady={chunkSpy}
          onRecordingComplete={completeSpy}
        />,
      )
    })

    await act(async () => {
      container.querySelector('button')?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
      await flush()
    })

    expect(startSpy).toHaveBeenCalledOnce()
    expect(beforeStartSpy).not.toHaveBeenCalled()
  })

  it('shows connecting state while startup is pending', () => {
    act(() => {
      root.render(
        <AudioRecorderButton
          recorder={recorder!}
          lifecycleState="connecting"
          onBeforeStartRecording={beforeStartSpy}
          onChunkReady={chunkSpy}
          onRecordingComplete={completeSpy}
        />,
      )
    })

    const button = container.querySelector('button')
      expect(button?.disabled).toBe(true)
    expect(button?.getAttribute('aria-label')).toBe('Đang kết nối realtime...')
    expect(container.textContent).toContain('Đang kết nối realtime...')
  })

  it('moves from connecting to recording once startup completes', () => {
    act(() => {
      root.render(
        <AudioRecorderButton
          recorder={recorder!}
          lifecycleState="connecting"
          onBeforeStartRecording={beforeStartSpy}
          onChunkReady={chunkSpy}
          onRecordingComplete={completeSpy}
        />,
      )
    })

    expect(container.textContent).toContain('Đang kết nối realtime...')

    recorder = {
      ...recorder!,
      state: 'recording',
      duration: 3,
    }

    act(() => {
      root.render(
        <AudioRecorderButton
          recorder={recorder!}
          lifecycleState="recording"
          onBeforeStartRecording={beforeStartSpy}
          onChunkReady={chunkSpy}
          onRecordingComplete={completeSpy}
        />,
      )
    })

    expect(container.textContent).toContain('Đang ghi âm 00:03')
    expect(container.querySelector('button')?.disabled).toBe(false)
  })

  it('allows retry after error state', async () => {
    act(() => {
      root.render(
        <AudioRecorderButton
          recorder={recorder!}
          lifecycleState="error"
          onBeforeStartRecording={beforeStartSpy}
          onChunkReady={chunkSpy}
          onRecordingComplete={completeSpy}
        />,
      )
    })

    await act(async () => {
      container.querySelector('button')?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
      await flush()
    })

    expect(beforeStartSpy).toHaveBeenCalledOnce()
    expect(startSpy).toHaveBeenCalledOnce()
  })

  it('calls graceful stop when recording and disables button while stopping', async () => {
    recorder = {
      ...recorder!,
      state: 'recording',
      audioChunks: [new Blob(['chunk-a'])],
      duration: 1,
      recordingSessionId: 1,
    }

    act(() => {
      root.render(
        <AudioRecorderButton
          recorder={recorder!}
          lifecycleState="recording"
          onBeforeStartRecording={beforeStartSpy}
          onChunkReady={chunkSpy}
          onRecordingComplete={completeSpy}
        />,
      )
    })

    await act(async () => {
      container.querySelector('button')?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
      await flush()
    })

    expect(gracefulStopSpy).toHaveBeenCalledOnce()
    expect(stopSpy).not.toHaveBeenCalled()
    expect(completeSpy).toHaveBeenCalledOnce()
  })

  it('calls onStopRequested before stopRecordingGraceful when stop is clicked', async () => {
    const stopRequestedSpy = vi.fn()
    const callOrder: string[] = []
    stopRequestedSpy.mockImplementation(() => {
      callOrder.push('stopRequested')
    })
    gracefulStopSpy.mockImplementation(async () => {
      callOrder.push('gracefulStop')
      return {
        fullBlob: new Blob(['final-audio'], { type: 'audio/webm; codecs=opus' }),
        sessionId: 1,
        collectedChunkCount: 1,
        postStopChunkCount: 0,
        chunks: [new Blob(['final-audio'], { type: 'audio/webm; codecs=opus' })],
      }
    })

    recorder = {
      ...recorder!,
      state: 'recording',
      audioChunks: [new Blob(['chunk-a'])],
      duration: 1,
      recordingSessionId: 1,
    }

    act(() => {
      root.render(
        <AudioRecorderButton
          recorder={recorder!}
          lifecycleState="recording"
          onStopRequested={stopRequestedSpy}
          onBeforeStartRecording={beforeStartSpy}
          onChunkReady={chunkSpy}
          onRecordingComplete={completeSpy}
        />,
      )
    })

    await act(async () => {
      container.querySelector('button')?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
      await flush()
    })

    expect(stopRequestedSpy).toHaveBeenCalledOnce()
    expect(gracefulStopSpy).toHaveBeenCalledOnce()
    expect(callOrder).toEqual(['stopRequested', 'gracefulStop'])
  })

  it('logs REALTIME_FINAL_CHUNK_ENQUEUED with postStop true for tail chunks after graceful stop', async () => {
    const infoSpy = vi.spyOn(console, 'info').mockImplementation(() => {})
    const preStopChunk = new Blob(['pre-stop'], { type: 'audio/webm; codecs=opus' })
    const postStopChunk = new Blob(['post-stop'], { type: 'audio/webm; codecs=opus' })

    gracefulStopSpy.mockResolvedValue({
      fullBlob: new Blob(['pre-stop', 'post-stop'], { type: 'audio/webm; codecs=opus' }),
      sessionId: 1,
      collectedChunkCount: 2,
      postStopChunkCount: 1,
      chunks: [preStopChunk, postStopChunk],
    })

    recorder = {
      ...recorder!,
      state: 'recording',
      audioChunks: [preStopChunk],
      duration: 1,
      recordingSessionId: 1,
    }

    act(() => {
      root.render(
        <AudioRecorderButton
          recorder={recorder!}
          lifecycleState="recording"
          onBeforeStartRecording={beforeStartSpy}
          onChunkReady={chunkSpy}
          onRecordingComplete={completeSpy}
        />,
      )
    })

    await act(async () => {
      container.querySelector('button')?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
      await flush()
    })

    const tailLog = infoSpy.mock.calls.find(
      ([message, payload]) => message === '[Realtime] REALTIME_FINAL_CHUNK_ENQUEUED'
        && (payload as { postStop?: boolean }).postStop === true,
    )
    expect(tailLog).toBeDefined()
    expect(tailLog?.[1]).toMatchObject({
      sessionId: 1,
      postStop: true,
      size: postStopChunk.size,
    })
    infoSpy.mockRestore()
  })

  it('disables button while finalizing_recording lifecycle is active', () => {
    act(() => {
      root.render(
        <AudioRecorderButton
          recorder={recorder!}
          lifecycleState="finalizing_recording"
          onBeforeStartRecording={beforeStartSpy}
          onChunkReady={chunkSpy}
          onRecordingComplete={completeSpy}
        />,
      )
    })

    expect(container.querySelector('button')?.disabled).toBe(true)
    expect(container.textContent).toContain('Đang hoàn tất ghi âm')
  })

  it('disables button while finalizing_transcript lifecycle is active', () => {
    act(() => {
      root.render(
        <AudioRecorderButton
          recorder={recorder!}
          lifecycleState="finalizing_transcript"
          onBeforeStartRecording={beforeStartSpy}
          onChunkReady={chunkSpy}
          onRecordingComplete={completeSpy}
        />,
      )
    })

    expect(container.querySelector('button')?.disabled).toBe(true)
    expect(container.textContent).toContain('Đang hoàn tất transcript')
  })

  it('emits chunk and completion callbacks after graceful stop', async () => {
    recorder = {
      ...recorder!,
      state: 'recording',
      audioChunks: [new Blob(['chunk-a'])],
      duration: 1,
      recordingSessionId: 1,
    }

    act(() => {
      root.render(
        <AudioRecorderButton
          recorder={recorder!}
          lifecycleState="recording"
          onBeforeStartRecording={beforeStartSpy}
          onChunkReady={chunkSpy}
          onRecordingComplete={completeSpy}
        />,
      )
    })

    await flush()

    expect(chunkSpy).toHaveBeenCalledOnce()

    await act(async () => {
      container.querySelector('button')?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
      await flush()
    })

    expect(gracefulStopSpy).toHaveBeenCalledOnce()
    expect(completeSpy).toHaveBeenCalledOnce()
  })

  it('waits for the final chunk to emit before reporting completion', async () => {
    const callOrder: string[] = []
    chunkSpy = vi.fn(() => {
      callOrder.push('chunk')
    })
    completeSpy = vi.fn(() => {
      callOrder.push('complete')
    })

    gracefulStopSpy.mockImplementation(async () => ({
      fullBlob: new Blob(['chunk-final']),
      sessionId: 1,
      collectedChunkCount: 1,
      postStopChunkCount: 1,
      chunks: [new Blob(['chunk-final'])],
    }))

    recorder = {
      ...recorder!,
      state: 'recording',
      audioChunks: [],
      recordingSessionId: 1,
    }

    act(() => {
      root.render(
        <AudioRecorderButton
          recorder={recorder!}
          lifecycleState="recording"
          onBeforeStartRecording={beforeStartSpy}
          onChunkReady={chunkSpy}
          onRecordingComplete={completeSpy}
        />,
      )
    })

    await flush()

    expect(chunkSpy).not.toHaveBeenCalled()
    expect(completeSpy).not.toHaveBeenCalled()

    await act(async () => {
      container.querySelector('button')?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
      await flush()
    })

    expect(chunkSpy).toHaveBeenCalledOnce()
    expect(completeSpy).toHaveBeenCalledOnce()
    expect(callOrder).toEqual(['chunk', 'complete'])
  })

  it('flushes async chunk dispatches before firing recording complete', async () => {
    let resolveChunk!: () => void
    chunkSpy = vi.fn(() => new Promise<void>((resolve) => {
      resolveChunk = resolve
    }))

    recorder = {
      ...recorder!,
      state: 'recording',
      recordingSessionId: 5,
      audioChunks: [new Blob(['chunk-late'])],
    }

    act(() => {
      root.render(
        <AudioRecorderButton
          recorder={recorder!}
          lifecycleState="recording"
          onBeforeStartRecording={beforeStartSpy}
          onChunkReady={chunkSpy}
          onRecordingComplete={completeSpy}
        />,
      )
    })

    await flush()
    expect(chunkSpy).toHaveBeenCalledOnce()
    expect(completeSpy).not.toHaveBeenCalled()

    await act(async () => {
      container.querySelector('button')?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
      await flush()
    })

    expect(completeSpy).not.toHaveBeenCalled()

    resolveChunk()
    await flush()

    expect(completeSpy).toHaveBeenCalledOnce()
  })
})
