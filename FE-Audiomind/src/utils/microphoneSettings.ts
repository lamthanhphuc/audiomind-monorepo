export type MicrophoneAudioSettings = {
  deviceId?: string
  sampleRate?: number
  channelCount?: number
  echoCancellation?: boolean
  noiseSuppression?: boolean
  autoGainControl?: boolean
}

export type SafeMicrophoneTelemetry = {
  sampleRate?: number
  channelCount?: number
  echoCancellation?: boolean
  noiseSuppression?: boolean
  autoGainControl?: boolean
  deviceIdPresent: boolean
}

export type RequestedMicrophoneConstraints = {
  noiseSuppressionEnabled?: boolean
  echoCancellationEnabled?: boolean
  autoGainControlEnabled?: boolean
}

export type MicrophoneConstraintIssue =
  | 'noise_suppression_unavailable'
  | 'echo_cancellation_unavailable'
  | 'auto_gain_control_unavailable'

const asOptionalBoolean = (value: unknown): boolean | undefined =>
  typeof value === 'boolean' ? value : undefined

const asOptionalNumber = (value: unknown): number | undefined =>
  typeof value === 'number' && Number.isFinite(value) ? value : undefined

const asOptionalString = (value: unknown): string | undefined =>
  typeof value === 'string' && value.length > 0 ? value : undefined

export const readMicrophoneAudioSettings = (stream: MediaStream): MicrophoneAudioSettings | null => {
  try {
    const track = stream.getAudioTracks?.()[0] ?? stream.getTracks()[0]
    const settings = track?.getSettings?.()
    if (!settings || typeof settings !== 'object') {
      return null
    }

    return {
      deviceId: asOptionalString((settings as MediaTrackSettings).deviceId),
      sampleRate: asOptionalNumber((settings as MediaTrackSettings).sampleRate),
      channelCount: asOptionalNumber((settings as MediaTrackSettings).channelCount),
      echoCancellation: asOptionalBoolean((settings as MediaTrackSettings).echoCancellation),
      noiseSuppression: asOptionalBoolean((settings as MediaTrackSettings).noiseSuppression),
      autoGainControl: asOptionalBoolean((settings as MediaTrackSettings).autoGainControl),
    }
  } catch {
    return null
  }
}

export const toSafeMicTelemetry = (settings: MicrophoneAudioSettings | null): SafeMicrophoneTelemetry | null => {
  if (!settings) {
    return null
  }
  return {
    sampleRate: settings.sampleRate,
    channelCount: settings.channelCount,
    echoCancellation: settings.echoCancellation,
    noiseSuppression: settings.noiseSuppression,
    autoGainControl: settings.autoGainControl,
    deviceIdPresent: typeof settings.deviceId === 'string' && settings.deviceId.length > 0,
  }
}

export const compareRequestedMicrophoneSettings = (
  requested: RequestedMicrophoneConstraints,
  actual: MicrophoneAudioSettings | null,
): MicrophoneConstraintIssue[] => {
  if (!actual) {
    return []
  }

  const issues: MicrophoneConstraintIssue[] = []
  if (requested.noiseSuppressionEnabled === true && actual.noiseSuppression === false) {
    issues.push('noise_suppression_unavailable')
  }
  if (requested.echoCancellationEnabled === true && actual.echoCancellation === false) {
    issues.push('echo_cancellation_unavailable')
  }
  if (requested.autoGainControlEnabled === true && actual.autoGainControl === false) {
    issues.push('auto_gain_control_unavailable')
  }
  return issues
}
