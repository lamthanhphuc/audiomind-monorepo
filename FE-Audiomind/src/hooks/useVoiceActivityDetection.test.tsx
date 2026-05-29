import { useCallback } from 'react'
import { createRoot } from 'react-dom/client'
import { act } from 'react-dom/test-utils'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  DEFAULT_VAD_RESUMED_LABEL_MS,
  useVoiceActivityDetection,
  type UseVoiceActivityDetectionResult,
} from './useVoiceActivityDetection'

describe('useVoiceActivityDetection', () => {
  let container: HTMLDivElement
  let root: ReturnType<typeof createRoot>
  let latest: UseVoiceActivityDetectionResult | null = null
  let rms: number | null = 0.03
  let enabled = true

  const renderHarness = () => {
    function Harness() {
      const getRmsLevel = useCallback(() => rms, [])
      latest = useVoiceActivityDetection({
        enabled,
        getRmsLevel,
        silenceThreshold: 0.012,
        speechThreshold: 0.02,
        silenceDurationMs: 2000,
        resumeDurationMs: 300,
        sampleIntervalMs: 100,
        resumedLabelMs: DEFAULT_VAD_RESUMED_LABEL_MS,
      })
      return null
    }

    act(() => {
      root.render(<Harness />)
    })
  }

  const advance = async (ms: number) => {
    await act(async () => {
      await vi.advanceTimersByTimeAsync(ms)
    })
  }

  const moveToPausedState = async () => {
    rms = 0.03
    await advance(200)
    rms = 0.004
    await advance(2100)
    expect(latest?.state).toBe('silent_paused')
  }

  beforeEach(() => {
    ;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
    vi.useFakeTimers()
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
    latest = null
    rms = 0.03
    enabled = true
    renderHarness()
  })

  afterEach(() => {
    act(() => {
      root.unmount()
    })
    container.remove()
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  it('transitions from speech to paused after ~2 seconds of silence', async () => {
    expect(latest?.state).toBe('listening')

    rms = 0.004
    await advance(1900)
    expect(latest?.state).toBe('listening')

    await advance(200)
    expect(latest?.state).toBe('silent_paused')
  })

  it('transitions from paused to resumed after ~300ms of speech and then settles back to listening', async () => {
    await moveToPausedState()

    rms = 0.03
    await advance(200)
    expect(latest?.state).toBe('silent_paused')

    await advance(200)
    expect(latest?.state).toBe('listening_resumed')

    await advance(DEFAULT_VAD_RESUMED_LABEL_MS + 50)
    expect(latest?.state).toBe('listening')
  })

  it('does not resume from brief noise below speech threshold', async () => {
    await moveToPausedState()

    rms = 0.015
    await advance(1200)

    expect(latest?.state).toBe('silent_paused')
  })

  it('resets to listening when detection is disabled', async () => {
    await moveToPausedState()
    enabled = false
    renderHarness()

    expect(latest?.state).toBe('listening')
  })

  it('does not auto-pause when RMS samples are unavailable', async () => {
    rms = null

    await advance(2500)

    expect(latest?.state).toBe('listening')
  })
})
