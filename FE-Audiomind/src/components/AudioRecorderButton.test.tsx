import { createRoot } from 'react-dom/client'
import { act } from 'react-dom/test-utils'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useAudioRecorder } from '../hooks/useAudioRecorder'
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

  start = vi.fn(() => {
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
    this.state = 'inactive'
    this.onstop?.()
  })

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
          getTracks: () => [{ stop: vi.fn() }],
        }),
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
})


describe('AudioRecorderButton', () => {
  let container: HTMLDivElement
  let root: ReturnType<typeof createRoot>
  let recorder: ReturnType<typeof useAudioRecorder> | null = null
  let startSpy: ReturnType<typeof vi.fn>
  let stopSpy: ReturnType<typeof vi.fn>
  let beforeStartSpy: ReturnType<typeof vi.fn>
  let chunkSpy: ReturnType<typeof vi.fn>
  let completeSpy: ReturnType<typeof vi.fn>

  beforeEach(() => {
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
    startSpy = vi.fn().mockResolvedValue(undefined)
    stopSpy = vi.fn()
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
      abortRecording: vi.fn(),
      pauseRecording: vi.fn(),
      resumeRecording: vi.fn(),
      duration: 0,
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

  it('triggers start flow from idle state', async () => {
    await act(async () => {
      container.querySelector('button')?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
      await flush()
    })

    expect(beforeStartSpy).toHaveBeenCalledOnce()
    expect(startSpy).toHaveBeenCalledOnce()
  })

  it('waits for preflight to resolve before starting the recorder', async () => {
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
    expect(startSpy).not.toHaveBeenCalled()

    resolvePreflight()
    await flush()

    expect(startSpy).toHaveBeenCalledOnce()
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
    expect(startSpy).not.toHaveBeenCalled()
  })

  it('passes expected session id from preflight to recorder start', async () => {
    beforeStartSpy = vi.fn().mockResolvedValue({ expectedSessionId: 7 })

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

    expect(startSpy).toHaveBeenCalledWith(7)
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

  it('emits chunk and completion callbacks', async () => {
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
          onBeforeStartRecording={beforeStartSpy}
          onChunkReady={chunkSpy}
          onRecordingComplete={completeSpy}
        />,
      )
    })

    await flush()

    expect(chunkSpy).toHaveBeenCalledOnce()

    recorder = {
      ...recorder,
      state: 'stopped',
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

    recorder = {
      ...recorder!,
      state: 'stopped',
      audioChunks: [],
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
    expect(completeSpy).not.toHaveBeenCalled()

    recorder = {
      ...recorder,
      audioChunks: [new Blob(['chunk-final'])],
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

    expect(chunkSpy).toHaveBeenCalledOnce()
    expect(completeSpy).toHaveBeenCalledOnce()
    expect(callOrder).toEqual(['chunk', 'complete'])
  })
})
