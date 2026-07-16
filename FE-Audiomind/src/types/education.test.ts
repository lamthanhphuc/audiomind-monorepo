import { describe, expect, it } from 'vitest'
import { normalizeEducationStudyAnalysis } from './education'
import { resolveFirstSegmentTimeRange } from '../utils/transcriptEvidence'

describe('education study normalization', () => {
  it('normalizes educationStudy payload with nested arrays', () => {
    const study = normalizeEducationStudyAnalysis({
      title: 'Lecture 1',
      overview: 'Intro to algebra',
      learningObjectives: ['Understand variables'],
      sections: [{
        id: 's1',
        title: 'Variables',
        summary: 'Basic definitions',
        keyPoints: ['x is a variable'],
        keywords: ['variable'],
        sourceSegmentIds: ['seg-1'],
      }],
      keyPoints: [{ content: 'Remember PEMDAS', importance: 'HIGH', sourceSegmentIds: ['seg-2'] }],
      keywords: ['algebra'],
      glossary: [{ term: 'Variable', definition: 'A symbol', sourceSegmentIds: ['seg-1'] }],
      mustRemember: [{ content: 'Order matters', importance: 'MEDIUM', reason: 'Exam focus', sourceSegmentIds: [] }],
      unclearPoints: [{ content: 'Limits', reason: 'Not covered yet', sourceSegmentIds: ['seg-3'] }],
    })

    expect(study?.title).toBe('Lecture 1')
    expect(study?.sections[0]?.sourceSegmentIds).toEqual(['seg-1'])
    expect(study?.keyPoints[0]?.importance).toBe('HIGH')
  })

  it('returns null for malformed educationStudy payloads', () => {
    expect(normalizeEducationStudyAnalysis(null)).toBeNull()
    expect(normalizeEducationStudyAnalysis({})).toBeNull()
  })
})

describe('transcript evidence mapping', () => {
  it('maps source segment id to highlight range from raw segments', () => {
    const range = resolveFirstSegmentTimeRange('seg-2', [
      { id: 'seg-1', speaker: 'A', text: 'one', start: 0, end: 2 },
      { id: 'seg-2', speaker: 'B', text: 'two', start: 5, end: 8 },
    ])

    expect(range).toEqual({ startTime: 5, endTime: 8 })
  })
})
