import { describe, expect, it, vi } from 'vitest'

import {
  applyParsedStudioRoute,
  buildStudioPath,
  parseStudioRouteFromLocation,
  resolveStudioRedirectAfter,
  type ParsedStudioRoute,
} from './studioRouting'

const createHandlers = () => ({
  setFeatureScene: vi.fn(),
  setHistoryAnalysisMeetingId: vi.fn(),
  setHistoryAnalysisScope: vi.fn(),
  setMindmapSelectedMeetingId: vi.fn(),
  setMindmapSelectedScope: vi.fn(),
  setSelectedSubjectId: vi.fn(),
  setSelectedSubjectTab: vi.fn(),
})

describe('studioRouting', () => {
  it('parses studio history path', () => {
    expect(parseStudioRouteFromLocation({ pathname: '/studio/history', search: '' })).toEqual({
      scene: 'files',
      meetingId: null,
      subjectId: null,
      subjectTab: null,
      resultScope: null,
      evidenceSegmentId: null,
    })
  })

  it('parses analysis with meetingId', () => {
    expect(parseStudioRouteFromLocation({ pathname: '/studio/analysis', search: '?meetingId=42' })).toEqual({
      scene: 'analysis',
      meetingId: 42,
      subjectId: null,
      subjectTab: null,
      resultScope: null,
      evidenceSegmentId: null,
    })
  })

  it('parses analysis with evidenceSegmentId', () => {
    expect(parseStudioRouteFromLocation({
      pathname: '/studio/analysis',
      search: '?meetingId=42&evidenceSegmentId=seg-9',
    })).toEqual({
      scene: 'analysis',
      meetingId: 42,
      subjectId: null,
      subjectTab: null,
      resultScope: null,
      evidenceSegmentId: 'seg-9',
    })
  })

  it('parses analysis with v2 scope params', () => {
    expect(parseStudioRouteFromLocation({
      pathname: '/studio/analysis',
      search: '?meetingId=42&recordingSessionId=9001&attemptId=2',
    })).toEqual({
      scene: 'analysis',
      meetingId: 42,
      subjectId: null,
      subjectTab: null,
      resultScope: {
        scopeKind: 'v2',
        meetingId: 42,
        recordingSessionId: 9001,
        attemptId: 2,
      },
      evidenceSegmentId: null,
    })
  })

  it('parses subject detail path with default meetings tab', () => {
    expect(parseStudioRouteFromLocation({ pathname: '/studio/subjects/12', search: '' })).toEqual({
      scene: 'subjectDetail',
      meetingId: null,
      subjectId: 12,
      subjectTab: 'meetings',
      resultScope: null,
      evidenceSegmentId: null,
    })
  })

  it('parses subject detail tab routes', () => {
    expect(parseStudioRouteFromLocation({ pathname: '/studio/subjects/12/synthesis', search: '' })).toEqual({
      scene: 'subjectDetail',
      meetingId: null,
      subjectId: 12,
      subjectTab: 'synthesis',
      resultScope: null,
      evidenceSegmentId: null,
    })
    expect(parseStudioRouteFromLocation({ pathname: '/studio/subjects/3/mind-map', search: '' })?.subjectTab).toBe('mind-map')
    expect(parseStudioRouteFromLocation({ pathname: '/studio/subjects/3/flashcards', search: '' })?.subjectTab).toBe('flashcards')
    expect(parseStudioRouteFromLocation({ pathname: '/studio/subjects/3/quiz', search: '' })?.subjectTab).toBe('quiz')
    expect(parseStudioRouteFromLocation({ pathname: '/studio/subjects/3/essay', search: '' })?.subjectTab).toBe('essay')
    expect(parseStudioRouteFromLocation({ pathname: '/studio/subjects/3/exam-brief', search: '' })?.subjectTab).toBe('exam-brief')
  })

  it('rejects unknown subject tab segments', () => {
    expect(parseStudioRouteFromLocation({ pathname: '/studio/subjects/12/unknown-tab', search: '' })).toBeNull()
  })

  it('parses subjects and unclassified paths', () => {
    expect(parseStudioRouteFromLocation({ pathname: '/studio/subjects', search: '' })).toEqual({
      scene: 'subjects',
      meetingId: null,
      subjectId: null,
      subjectTab: null,
      resultScope: null,
      evidenceSegmentId: null,
    })
    expect(parseStudioRouteFromLocation({ pathname: '/studio/unclassified', search: '' })).toEqual({
      scene: 'unclassified',
      meetingId: null,
      subjectId: null,
      subjectTab: null,
      resultScope: null,
      evidenceSegmentId: null,
    })
  })

  it('builds mindmap path with meetingId', () => {
    expect(buildStudioPath('mindmap', { meetingId: 9 })).toBe('/studio/mindmap?meetingId=9')
  })

  it('builds subject detail path with optional tab', () => {
    expect(buildStudioPath('subjectDetail', { subjectId: 5 })).toBe('/studio/subjects/5')
    expect(buildStudioPath('subjectDetail', { subjectId: 5, subjectTab: 'meetings' })).toBe('/studio/subjects/5')
    expect(buildStudioPath('subjectDetail', { subjectId: 5, subjectTab: 'quiz' })).toBe('/studio/subjects/5/quiz')
  })

  it('builds analysis path with evidence segment', () => {
    expect(buildStudioPath('analysis', {
      meetingId: 9,
      evidenceSegmentId: 'seg-1',
    })).toBe('/studio/analysis?meetingId=9&evidenceSegmentId=seg-1')
  })

  it('builds analysis path with v2 scope', () => {
    expect(buildStudioPath('analysis', {
      meetingId: 9,
      resultScope: {
        scopeKind: 'v2',
        meetingId: 9,
        recordingSessionId: 9001,
        attemptId: 2,
      },
    })).toBe('/studio/analysis?meetingId=9&recordingSessionId=9001&attemptId=2')
  })

  it('resolves redirectAfter to studio route', () => {
    expect(resolveStudioRedirectAfter('/studio/history')).toEqual({
      scene: 'files',
      meetingId: null,
      subjectId: null,
      subjectTab: null,
      resultScope: null,
      evidenceSegmentId: null,
    })
  })

  it('falls back to integrations for invalid redirectAfter', () => {
    expect(resolveStudioRedirectAfter('https://evil.example')).toEqual({
      scene: 'integrations',
      meetingId: null,
      subjectId: null,
      subjectTab: null,
      resultScope: null,
      evidenceSegmentId: null,
    })
  })

  describe('applyParsedStudioRoute (browser back/forward)', () => {
    it('sets selectedSubjectId and tab when navigating to subjectDetail', () => {
      const handlers = createHandlers()
      const route: ParsedStudioRoute = {
        scene: 'subjectDetail',
        meetingId: null,
        subjectId: 7,
        subjectTab: 'flashcards',
        resultScope: null,
      }
      applyParsedStudioRoute(route, handlers)
      expect(handlers.setFeatureScene).toHaveBeenCalledWith('subjectDetail')
      expect(handlers.setSelectedSubjectId).toHaveBeenCalledWith(7)
      expect(handlers.setSelectedSubjectTab).toHaveBeenCalledWith('flashcards')
    })

    it('clears selectedSubjectId when navigating back to subjects list', () => {
      const handlers = createHandlers()
      const route: ParsedStudioRoute = { scene: 'subjects', meetingId: null, subjectId: null, resultScope: null }
      applyParsedStudioRoute(route, handlers)
      expect(handlers.setFeatureScene).toHaveBeenCalledWith('subjects')
      expect(handlers.setSelectedSubjectId).toHaveBeenCalledWith(null)
      expect(handlers.setSelectedSubjectTab).toHaveBeenCalledWith(null)
    })

    it('clears selectedSubjectId when navigating forward to an unrelated scene', () => {
      const handlers = createHandlers()
      const route: ParsedStudioRoute = { scene: 'files', meetingId: null, subjectId: null, resultScope: null }
      applyParsedStudioRoute(route, handlers)
      expect(handlers.setSelectedSubjectId).toHaveBeenCalledWith(null)
    })

    it('clears selectedSubjectId when navigating to unclassified', () => {
      const handlers = createHandlers()
      const route: ParsedStudioRoute = { scene: 'unclassified', meetingId: null, subjectId: null, resultScope: null }
      applyParsedStudioRoute(route, handlers)
      expect(handlers.setSelectedSubjectId).toHaveBeenCalledWith(null)
    })

    it('does not throw when setSelectedSubjectId handler is not provided', () => {
      const route: ParsedStudioRoute = { scene: 'upload', meetingId: null, subjectId: null, resultScope: null }
      expect(() => applyParsedStudioRoute(route, {
        setFeatureScene: vi.fn(),
        setHistoryAnalysisMeetingId: vi.fn(),
        setMindmapSelectedMeetingId: vi.fn(),
      })).not.toThrow()
    })
  })
})
