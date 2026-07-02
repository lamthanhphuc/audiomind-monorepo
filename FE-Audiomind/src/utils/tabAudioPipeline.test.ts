import { describe, expect, it, vi } from 'vitest'
import {
  ensureAudioContextRunning,
  isTabCaptureSilent,
  measureAnalyserRms,
  resolveTabMicGateGains,
  snapshotTabTrack,
} from './tabAudioPipeline'

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
    expect(gains.micGain).toBe(6)
  })

  it('restores tab pass gain when mic is idle', () => {
    const gains = resolveTabMicGateGains({
      micPriority: false,
      tabPassGain: 0.38,
      tabDuckGain: 0.12,
      micPassGain: 6,
      micIdleGain: 0,
    })
    expect(gains.tabGain).toBe(0.38)
    expect(gains.micGain).toBe(0)
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
