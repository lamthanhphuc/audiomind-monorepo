import { describe, expect, it } from 'vitest'
import {
  compareRequestedMicrophoneSettings,
  readMicrophoneAudioSettings,
  toSafeMicTelemetry,
} from './microphoneSettings'

describe('microphoneSettings', () => {
  it('does not crash when getSettings is missing properties', () => {
    const stream = {
      getAudioTracks: () => [{
        getSettings: () => ({ sampleRate: 48000 }),
      }],
      getTracks: () => [],
    } as unknown as MediaStream

    const settings = readMicrophoneAudioSettings(stream)
    expect(settings).toEqual({
      deviceId: undefined,
      sampleRate: 48000,
      channelCount: undefined,
      echoCancellation: undefined,
      noiseSuppression: undefined,
      autoGainControl: undefined,
    })
  })

  it('does not crash when getSettings throws', () => {
    const stream = {
      getAudioTracks: () => [{
        getSettings: () => {
          throw new Error('boom')
        },
      }],
      getTracks: () => [],
    } as unknown as MediaStream
    expect(readMicrophoneAudioSettings(stream)).toBeNull()
  })

  it('sanitizes telemetry without raw deviceId', () => {
    const telemetry = toSafeMicTelemetry({
      deviceId: 'secret-device',
      sampleRate: 48000,
      noiseSuppression: true,
      echoCancellation: true,
      autoGainControl: true,
      channelCount: 1,
    })
    expect(telemetry).toEqual({
      sampleRate: 48000,
      channelCount: 1,
      echoCancellation: true,
      noiseSuppression: true,
      autoGainControl: true,
      deviceIdPresent: true,
    })
    expect(JSON.stringify(telemetry)).not.toContain('secret-device')
  })

  it('reports mismatch issue codes', () => {
    const issues = compareRequestedMicrophoneSettings(
      {
        noiseSuppressionEnabled: true,
        echoCancellationEnabled: true,
        autoGainControlEnabled: true,
      },
      {
        noiseSuppression: false,
        echoCancellation: false,
        autoGainControl: true,
      },
    )
    expect(issues).toEqual([
      'noise_suppression_unavailable',
      'echo_cancellation_unavailable',
    ])
  })
})
