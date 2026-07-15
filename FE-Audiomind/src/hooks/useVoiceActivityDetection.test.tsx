import { useCallback } from 'react'
import { createRoot } from 'react-dom/client'
import { act } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  DEFAULT_VAD_RESUMED_LABEL_MS,
  normalizeMicSensitivityMode,
  resolveVadThresholds,
  useVoiceActivityDetection,
  type UseVoiceActivityDetectionResult,
} from './useVoiceActivityDetection'

describe('resolveVadThresholds', () => {
  it('orders sensitivity modes from least to most sensitive', () => {
    const low = resolveVadThresholds(0.002, 'low')
    const normal = resolveVadThresholds(0.002, 'normal')
    const high = resolveVadThresholds(0.002, 'high')

    expect(low.speechStartThreshold).toBeGreaterThan(normal.speechStartThreshold)
    expect(normal.speechStartThreshold).toBeGreaterThan(high.speechStartThreshold)
    expect(low.speechStartThreshold).toBeGreaterThanOrEqual(0.01)
    expect(normal.speechStartThreshold).toBeGreaterThanOrEqual(0.006)
    expect(high.speechStartThreshold).toBeLessThanOrEqual(0.006)
    expect(low.speechContinueThreshold).toBeLessThan(low.speechStartThreshold)
    expect(high.speechContinueThreshold).toBeLessThan(high.speechStartThreshold)
  })

  it('keeps low mode conservative while high mode can catch soft RMS', () => {
    const low = resolveVadThresholds(0.001, 'low')
    const high = resolveVadThresholds(0.001, 'high')

    expect(0.008).toBeLessThan(low.speechStartThreshold)
    expect(0.008).toBeGreaterThanOrEqual(high.speechStartThreshold)
  })

  it('clamps dynamic thresholds for loud noise floors', () => {
    const thresholds = resolveVadThresholds(0.5, 'normal')

    expect(thresholds.noiseFloor).toBeLessThanOrEqual(0.08)
    expect(thresholds.speechStartThreshold).toBeLessThanOrEqual(0.08)
    expect(thresholds.speechContinueThreshold).toBeLessThanOrEqual(thresholds.speechStartThreshold)
  })

  it('normalizes unknown sensitivity mode to normal', () => {
    expect(normalizeMicSensitivityMode('high')).toBe('high')
    expect(normalizeMicSensitivityMode('unexpected')).toBe('normal')
  })
})

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
        dynamicEnabled: false,
        hangoverMs: 0,
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

  it('calibrates dynamically and resumes quickly in high sensitivity mode', async () => {
    const infoSpy = vi.spyOn(console, 'info').mockImplementation(() => {})
    rms = 0.001

    function DynamicHarness() {
      const getRmsLevel = useCallback(() => rms, [])
      latest = useVoiceActivityDetection({
        enabled: true,
        getRmsLevel,
        sampleIntervalMs: 100,
        dynamicEnabled: true,
        sensitivityMode: 'high',
        noiseCalibrationMs: 800,
        silenceDurationMs: 1500,
        resumeDurationMs: 120,
      })
      return null
    }

    act(() => {
      root.render(<DynamicHarness />)
    })

    await advance(900)
    expect(infoSpy).toHaveBeenCalledWith('[Realtime] VAD_CALIBRATED', expect.objectContaining({
      sensitivityMode: 'high',
    }))

    await advance(1600)
    expect(latest?.state).toBe('silent_paused')

    rms = 0.008
    await advance(100)
    expect(latest?.state).toBe('silent_paused')

    await advance(100)
    expect(latest?.state).toBe('silent_paused')

    await advance(100)
    expect(latest?.state).toBe('listening_resumed')
  })
})

