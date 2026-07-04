import { describe, expect, it } from 'vitest'
import { formatAudioClock } from './formatAudioClock'

describe('formatAudioClock', () => {
  it('formats sub-hour durations', () => {
    expect(formatAudioClock(0)).toBe('0:00')
    expect(formatAudioClock(65)).toBe('1:05')
  })

  it('formats hour-long durations', () => {
    expect(formatAudioClock(3661)).toBe('1:01:01')
  })
})
