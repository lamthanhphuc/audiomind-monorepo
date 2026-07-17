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
    expect(normalizeEducationStudyAnalysis(undefined)).toBeNull()
    expect(normalizeEducationStudyAnalysis('a string')).toBeNull()
    expect(normalizeEducationStudyAnalysis(42)).toBeNull()
    expect(normalizeEducationStudyAnalysis(['not', 'an', 'object'])).toBeNull()
  })

  it('never throws on deeply malformed input', () => {
    expect(() => normalizeEducationStudyAnalysis({
      title: { nested: 'object' },
      overview: 123,
      learningObjectives: 'not-an-array',
      sections: 'not-an-array',
      keyPoints: null,
      keywords: [1, 2, {}, null, undefined, 'real'],
      glossary: [{ term: 123, definition: {} }],
      mustRemember: [{ content: null }],
      unclearPoints: [{ content: {}, reason: [] }],
    })).not.toThrow()
  })

  describe('string-only coercion (asTrimmedString)', () => {
    it('drops non-string title/content instead of stringifying objects', () => {
      const study = normalizeEducationStudyAnalysis({
        title: { not: 'a string' },
        overview: 'Valid overview',
        keyPoints: [{ content: { foo: 'bar' }, importance: 'HIGH' }],
      })
      // title coerces to '' (not "[object Object]"), but overview keeps content present.
      expect(study?.title).toBe('')
      // keyPoint with non-string content is dropped entirely (content is required).
      expect(study?.keyPoints).toEqual([])
    })

    it('drops non-string glossary term/definition rather than stringifying', () => {
      const study = normalizeEducationStudyAnalysis({
        overview: 'x',
        glossary: [
          { term: 42, definition: 'valid def' },
          { term: 'Valid term', definition: null },
          { term: 'Real term', definition: 'Real definition' },
        ],
      })
      expect(study?.glossary).toHaveLength(1)
      expect(study?.glossary[0]).toMatchObject({ term: 'Real term', definition: 'Real definition' })
    })

    it('treats null and undefined as empty string, not "null"/"undefined"', () => {
      const study = normalizeEducationStudyAnalysis({
        overview: 'x',
        mustRemember: [{ content: 'Keep this', importance: null, reason: null, sourceSegmentIds: null }],
      })
      expect(study?.mustRemember[0]?.reason).toBeNull()
      expect(study?.mustRemember[0]?.importance).toBe('MEDIUM')
    })
  })

  describe('normalizeStringArray (keywords/keyPoints/learningObjectives)', () => {
    it('filters out non-string items: numbers, objects, null, undefined, booleans', () => {
      const study = normalizeEducationStudyAnalysis({
        overview: 'x',
        keywords: ['valid', 42, {}, null, undefined, true, 'another'],
      })
      expect(study?.keywords).toEqual(['valid', 'another'])
    })

    it('dedupes case-insensitively while preserving first-seen casing', () => {
      const study = normalizeEducationStudyAnalysis({
        overview: 'x',
        keywords: ['API', 'api', 'Api', 'Database'],
      })
      expect(study?.keywords).toEqual(['API', 'Database'])
    })

    it('preserves unicode / Vietnamese text correctly', () => {
      const study = normalizeEducationStudyAnalysis({
        overview: 'x',
        keywords: ['Đại số', 'phương trình', 'ĐẠI SỐ'],
      })
      // 'Đại số' and 'ĐẠI SỐ' dedupe case-insensitively to the first-seen form.
      expect(study?.keywords).toEqual(['Đại số', 'phương trình'])
    })

    it('trims whitespace and drops empty/whitespace-only strings', () => {
      const study = normalizeEducationStudyAnalysis({
        overview: 'x',
        keywords: ['  padded  ', '', '   ', 'clean'],
      })
      expect(study?.keywords).toEqual(['padded', 'clean'])
    })

    it('returns [] when the field is not an array at all', () => {
      const study = normalizeEducationStudyAnalysis({
        overview: 'x',
        keywords: 'not-an-array' as unknown,
      })
      expect(study?.keywords).toEqual([])
    })
  })

  describe('importance normalization', () => {
    it('accepts HIGH/MEDIUM/LOW case-insensitively', () => {
      const study = normalizeEducationStudyAnalysis({
        overview: 'x',
        keyPoints: [
          { content: 'a', importance: 'high' },
          { content: 'b', importance: 'Low' },
          { content: 'c', importance: 'MEDIUM' },
        ],
      })
      expect(study?.keyPoints.map((kp) => kp.importance)).toEqual(['HIGH', 'LOW', 'MEDIUM'])
    })

    it('defaults to MEDIUM for missing, malformed, or unrecognized importance', () => {
      const study = normalizeEducationStudyAnalysis({
        overview: 'x',
        keyPoints: [
          { content: 'a', importance: undefined },
          { content: 'b', importance: 'URGENT' },
          { content: 'c', importance: 123 },
          { content: 'd', importance: {} },
          { content: 'e' },
        ],
      })
      expect(study?.keyPoints.every((kp) => kp.importance === 'MEDIUM')).toBe(true)
    })
  })

  describe('nested item validation', () => {
    it('drops non-object items in nested arrays instead of throwing', () => {
      const study = normalizeEducationStudyAnalysis({
        overview: 'x',
        keyPoints: ['just a string', 42, null, { content: 'valid one' }],
      })
      expect(study?.keyPoints).toHaveLength(1)
      expect(study?.keyPoints[0]?.content).toBe('valid one')
    })

    it('drops sections without a title', () => {
      const study = normalizeEducationStudyAnalysis({
        overview: 'x',
        sections: [{ id: 's1' }, { id: 's2', title: 'Has title' }],
      })
      expect(study?.sections).toHaveLength(1)
      expect(study?.sections[0]?.title).toBe('Has title')
    })

    it('drops unclearPoints without content', () => {
      const study = normalizeEducationStudyAnalysis({
        overview: 'x',
        unclearPoints: [{ reason: 'only reason' }, { content: 'Has content', reason: 'ok' }],
      })
      expect(study?.unclearPoints).toHaveLength(1)
      expect(study?.unclearPoints[0]?.content).toBe('Has content')
    })

    it('defaults unclearPoints reason to a placeholder when missing', () => {
      const study = normalizeEducationStudyAnalysis({
        overview: 'x',
        unclearPoints: [{ content: 'No reason given' }],
      })
      expect(study?.unclearPoints[0]?.reason).toBe('Chưa rõ')
    })
  })

  describe('segment id normalization', () => {
    it('canonicalizes legacy segment ids', () => {
      const study = normalizeEducationStudyAnalysis({
        overview: 'x',
        keyPoints: [{ content: 'a', sourceSegmentIds: ['meeting-1-12.5-alice-3'] }],
      })
      expect(study?.keyPoints[0]?.sourceSegmentIds).toEqual(['meeting-1-start-12.500-alice'])
    })

    it('filters out non-string segment ids', () => {
      const study = normalizeEducationStudyAnalysis({
        overview: 'x',
        keyPoints: [{ content: 'a', sourceSegmentIds: ['seg-1', 42, null, {}, 'seg-2'] }],
      })
      expect(study?.keyPoints[0]?.sourceSegmentIds).toEqual(['seg-1', 'seg-2'])
    })

    it('dedupes segment ids after canonicalization', () => {
      const study = normalizeEducationStudyAnalysis({
        overview: 'x',
        keyPoints: [{
          content: 'a',
          sourceSegmentIds: ['meeting-1-12.5-alice-3', 'meeting-1-start-12.500-alice', 'meeting-1-12.5-alice-3'],
        }],
      })
      expect(study?.keyPoints[0]?.sourceSegmentIds).toEqual(['meeting-1-start-12.500-alice'])
    })

    it('accepts snake_case source_segment_ids alias', () => {
      const study = normalizeEducationStudyAnalysis({
        overview: 'x',
        keyPoints: [{ content: 'a', source_segment_ids: ['seg-9'] }],
      })
      expect(study?.keyPoints[0]?.sourceSegmentIds).toEqual(['seg-9'])
    })

    it('returns [] when sourceSegmentIds is missing or not an array', () => {
      const study = normalizeEducationStudyAnalysis({
        overview: 'x',
        keyPoints: [{ content: 'a' }, { content: 'b', sourceSegmentIds: 'not-an-array' }],
      })
      expect(study?.keyPoints[0]?.sourceSegmentIds).toEqual([])
      expect(study?.keyPoints[1]?.sourceSegmentIds).toEqual([])
    })
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
