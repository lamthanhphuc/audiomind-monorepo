import { describe, expect, it } from 'vitest'
import { createMicrophoneHealthTracker } from '../constants/micHealthConstants'

describe('micHealth tracker', () => {
  it('does not raise during calibration window', () => {
    const tracker = createMicrophoneHealthTracker()
    const start = 1_000
    for (let i = 0; i < 5; i += 1) {
      const state = tracker.update({ rms: 0, peak: 0, clippingRatio: 0 }, start + i * 100)
      expect(state.activeIssue).toBeNull()
      expect(state.calibrated).toBe(false)
    }
  })

  it('debounces raise and clear', () => {
    const tracker = createMicrophoneHealthTracker()
    const start = 1_000
    tracker.update({ rms: 0.02, peak: 0.1, clippingRatio: 0 }, start)
    // finish calibration with healthy signal
    for (let i = 0; i < 20; i += 1) {
      tracker.update({ rms: 0.02, peak: 0.1, clippingRatio: 0 }, start + 1700 + i * 120)
    }
    let state = tracker.update({ rms: 0.02, peak: 0.1, clippingRatio: 0 }, start + 5000)
    expect(state.calibrated).toBe(true)

    for (let i = 0; i < 7; i += 1) {
      state = tracker.update({ rms: 0.0005, peak: 0.001, clippingRatio: 0 }, start + 5200 + i * 120)
      expect(state.activeIssue).toBeNull()
    }
    state = tracker.update({ rms: 0.0005, peak: 0.001, clippingRatio: 0 }, start + 7000)
    expect(state.activeIssue).toBe('no_signal')
  })
})
