import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createRoot } from 'react-dom/client'
import { act } from 'react-dom/test-utils'
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
      startRecording: startSpy,
      stopRecording: stopSpy,
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

  it('emits chunk and completion callbacks', async () => {
    recorder = {
      ...recorder!,
      state: 'recording',
      audioChunks: [new Blob(['chunk-a'])],
      duration: 1,
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
