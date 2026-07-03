import { describe, expect, it } from 'vitest'

import {
  buildStudioPath,
  parseStudioRouteFromLocation,
  resolveStudioRedirectAfter,
} from './studioRouting'

describe('studioRouting', () => {
  it('parses studio history path', () => {
    expect(parseStudioRouteFromLocation({ pathname: '/studio/history', search: '' })).toEqual({
      scene: 'files',
      meetingId: null,
      resultScope: null,
    })
  })

  it('parses analysis with meetingId', () => {
    expect(parseStudioRouteFromLocation({ pathname: '/studio/analysis', search: '?meetingId=42' })).toEqual({
      scene: 'analysis',
      meetingId: 42,
      resultScope: null,
    })
  })

  it('parses analysis with v2 scope params', () => {
    expect(parseStudioRouteFromLocation({
      pathname: '/studio/analysis',
      search: '?meetingId=42&recordingSessionId=9001&attemptId=2',
    })).toEqual({
      scene: 'analysis',
      meetingId: 42,
      resultScope: {
        scopeKind: 'v2',
        meetingId: 42,
        recordingSessionId: 9001,
        attemptId: 2,
      },
    })
  })

  it('builds mindmap path with meetingId', () => {
    expect(buildStudioPath('mindmap', { meetingId: 9 })).toBe('/studio/mindmap?meetingId=9')
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
      resultScope: null,
    })
  })

  it('falls back to integrations for invalid redirectAfter', () => {
    expect(resolveStudioRedirectAfter('https://evil.example')).toEqual({
      scene: 'integrations',
      meetingId: null,
      resultScope: null,
    })
  })
})
