export type MicrophoneHealthIssue =
  | 'no_signal'
  | 'too_quiet'
  | 'clipping'
  | 'high_noise_floor'
  | 'noise_suppression_unavailable'
  | 'echo_cancellation_unavailable'

export const MIC_HEALTH_THRESHOLDS = {
  noSignalRms: 0.0015,
  tooQuietRms: 0.006,
  clippingPeak: 0.98,
  clippingRatio: 0.02,
  highNoiseFloorRms: 0.035,
  consecutiveSamplesToRaise: 8,
  consecutiveSamplesToClear: 12,
  sampleIntervalMs: 120,
  calibrationMs: 1600,
} as const

export const MIC_HEALTH_PRIORITY: MicrophoneHealthIssue[] = [
  'no_signal',
  'clipping',
  'too_quiet',
  'high_noise_floor',
  'noise_suppression_unavailable',
  'echo_cancellation_unavailable',
]

export const MIC_HEALTH_MESSAGES: Record<MicrophoneHealthIssue, string> = {
  no_signal: 'Không phát hiện tín hiệu microphone.',
  too_quiet: 'Âm lượng microphone quá nhỏ.',
  clipping: 'Âm lượng microphone quá lớn (có thể bị clipping).',
  high_noise_floor: 'Môi trường có nhiều tiếng ồn nền.',
  noise_suppression_unavailable: 'Trình duyệt hoặc thiết bị không hỗ trợ đầy đủ tính năng khử nhiễu.',
  echo_cancellation_unavailable: 'Trình duyệt hoặc thiết bị không hỗ trợ đầy đủ khử tiếng vọng.',
}

export type MicrophoneHealthSample = {
  rms: number
  peak: number
  clippingRatio: number
}

export type MicrophoneHealthState = {
  activeIssue: MicrophoneHealthIssue | null
  noiseFloor: number | null
  calibrated: boolean
}

type IssueCounter = Partial<Record<MicrophoneHealthIssue, number>>

export const createMicrophoneHealthTracker = () => {
  let noiseFloorSamples: number[] = []
  let calibratedAt: number | null = null
  let noiseFloor: number | null = null
  let activeIssue: MicrophoneHealthIssue | null = null
  const raiseCounts: IssueCounter = {}
  const clearCounts: IssueCounter = {}

  const reset = () => {
    noiseFloorSamples = []
    calibratedAt = null
    noiseFloor = null
    activeIssue = null
    for (const key of Object.keys(raiseCounts)) {
      delete raiseCounts[key as MicrophoneHealthIssue]
    }
    for (const key of Object.keys(clearCounts)) {
      delete clearCounts[key as MicrophoneHealthIssue]
    }
  }

  const computeNoiseFloor = (samples: number[]): number => {
    if (samples.length === 0) {
      return 0
    }
    const sorted = [...samples].sort((a, b) => a - b)
    const index = Math.max(0, Math.floor(sorted.length * 0.2))
    return sorted[index] ?? sorted[0]
  }

  const detectIssues = (sample: MicrophoneHealthSample, constraintIssues: MicrophoneHealthIssue[]): MicrophoneHealthIssue[] => {
    const issues: MicrophoneHealthIssue[] = []
    if (sample.rms <= MIC_HEALTH_THRESHOLDS.noSignalRms) {
      issues.push('no_signal')
    } else if (sample.rms < MIC_HEALTH_THRESHOLDS.tooQuietRms) {
      issues.push('too_quiet')
    }
    if (sample.peak >= MIC_HEALTH_THRESHOLDS.clippingPeak || sample.clippingRatio >= MIC_HEALTH_THRESHOLDS.clippingRatio) {
      issues.push('clipping')
    }
    if (noiseFloor !== null && noiseFloor >= MIC_HEALTH_THRESHOLDS.highNoiseFloorRms) {
      issues.push('high_noise_floor')
    }
    for (const issue of constraintIssues) {
      if (issue === 'noise_suppression_unavailable' || issue === 'echo_cancellation_unavailable') {
        issues.push(issue)
      }
    }
    return MIC_HEALTH_PRIORITY.filter((issue) => issues.includes(issue))
  }

  const update = (
    sample: MicrophoneHealthSample,
    nowMs: number,
    constraintIssues: MicrophoneHealthIssue[] = [],
  ): MicrophoneHealthState => {
    if (calibratedAt === null) {
      calibratedAt = nowMs
    }

    if (nowMs - calibratedAt <= MIC_HEALTH_THRESHOLDS.calibrationMs) {
      noiseFloorSamples.push(sample.rms)
      return { activeIssue: null, noiseFloor, calibrated: false }
    }

    if (noiseFloor === null && noiseFloorSamples.length > 0) {
      noiseFloor = computeNoiseFloor(noiseFloorSamples)
      noiseFloorSamples = []
    }

    const detected = detectIssues(sample, constraintIssues)
    const top = detected[0] ?? null

    for (const issue of MIC_HEALTH_PRIORITY) {
      if (detected.includes(issue)) {
        raiseCounts[issue] = (raiseCounts[issue] ?? 0) + 1
        clearCounts[issue] = 0
      } else {
        clearCounts[issue] = (clearCounts[issue] ?? 0) + 1
        raiseCounts[issue] = 0
      }
    }

    if (top && (raiseCounts[top] ?? 0) >= MIC_HEALTH_THRESHOLDS.consecutiveSamplesToRaise) {
      activeIssue = top
    } else if (
      activeIssue
      && (clearCounts[activeIssue] ?? 0) >= MIC_HEALTH_THRESHOLDS.consecutiveSamplesToClear
    ) {
      activeIssue = null
    }

    return {
      activeIssue,
      noiseFloor,
      calibrated: true,
    }
  }

  return { reset, update }
}
