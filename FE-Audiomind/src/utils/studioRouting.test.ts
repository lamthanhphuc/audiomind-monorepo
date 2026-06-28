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
    })
  })

  it('parses analysis with meetingId', () => {
    expect(parseStudioRouteFromLocation({ pathname: '/studio/analysis', search: '?meetingId=42' })).toEqual({
      scene: 'analysis',
      meetingId: 42,
    })
  })

  it('builds mindmap path with meetingId', () => {
    expect(buildStudioPath('mindmap', { meetingId: 9 })).toBe('/studio/mindmap?meetingId=9')
  })

  it('resolves redirectAfter to studio route', () => {
    expect(resolveStudioRedirectAfter('/studio/history')).toEqual({
      scene: 'files',
      meetingId: null,
    })
  })

  it('falls back to integrations for invalid redirectAfter', () => {
    expect(resolveStudioRedirectAfter('https://evil.example')).toEqual({
      scene: 'integrations',
      meetingId: null,
    })
  })
})
