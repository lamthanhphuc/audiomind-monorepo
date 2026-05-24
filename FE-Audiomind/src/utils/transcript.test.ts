import { describe, expect, it } from 'vitest'
import { normalizeSpeakerBadge, parsePlainTranscriptText } from './transcript'

describe('parsePlainTranscriptText', () => {
  it('splits SPEAKER markers into display segments', () => {
    const segments = parsePlainTranscriptText('SPEAKER_1: Xin chào. SPEAKER_2: Tom, I am so tired.')

    expect(segments).toHaveLength(2)
    expect(segments[0]).toMatchObject({
      speaker: 'SPEAKER_1',
      text: 'Xin chào.',
    })
    expect(segments[1]).toMatchObject({
      speaker: 'SPEAKER_2',
      text: 'Tom, I am so tired.',
    })
  })

  it('normalizes the spoken Speaker 1 format to a canonical badge label', () => {
    const segments = parsePlainTranscriptText('Speaker 1: Xin chào. Speaker 2: English text here.')

    expect(segments).toHaveLength(2)
    expect(segments.map((segment) => segment.speaker)).toEqual(['SPEAKER_1', 'SPEAKER_2'])
  })

  it('falls back to a single block when no speaker marker exists', () => {
    const segments = parsePlainTranscriptText('Xin chào tiếng Việt và English text vẫn giữ nguyên.')

    expect(segments).toHaveLength(1)
    expect(segments[0]).toMatchObject({
      speaker: 'SPEAKER_1',
      text: 'Xin chào tiếng Việt và English text vẫn giữ nguyên.',
    })
  })
})

describe('normalizeSpeakerBadge', () => {
  it('keeps canonical speaker labels readable', () => {
    expect(normalizeSpeakerBadge('Speaker 1')).toBe('SPEAKER_1')
    expect(normalizeSpeakerBadge('SPEAKER_2')).toBe('SPEAKER_2')
  })
})
