import { describe, expect, it } from 'vitest'

import {
  formatResultScopeLabel,
  normalizeResultScopeItem,
  scopeCacheKey,
  scopeToTranscriptOptions,
  selectDefaultResultScope,
} from './meetingResultScope'

describe('meetingResultScope', () => {
  it('builds legacy transcript options without query params', () => {
    const scope = normalizeResultScopeItem(7, { scopeKind: 'legacy' })
    expect(scopeToTranscriptOptions(scope)).toEqual({})
    expect(scopeCacheKey(scope)).toBe('7:legacy')
  })

  it('builds v2 transcript options with both provenance ids', () => {
    const scope = normalizeResultScopeItem(7, {
      scopeKind: 'v2',
      recordingSessionId: 9001,
      attemptId: 2,
    })
    expect(scopeToTranscriptOptions(scope)).toEqual({
      recordingSessionId: 9001,
      attemptId: 2,
    })
    expect(scopeCacheKey(scope)).toBe('7:v2:9001:2')
  })

  it('selects latest finalized v2 attempt by default', () => {
    const selected = selectDefaultResultScope(12, [
      { scopeKind: 'v2', recordingSessionId: 1, attemptId: 1, finalized: true },
      { scopeKind: 'v2', recordingSessionId: 1, attemptId: 2, finalized: true },
      { scopeKind: 'legacy' },
    ])
    expect(selected).toMatchObject({
      meetingId: 12,
      recordingSessionId: 1,
      attemptId: 2,
    })
  })

  it('formats scope labels for history picker', () => {
    expect(formatResultScopeLabel(normalizeResultScopeItem(1, { scopeKind: 'legacy' }))).toBe('Bản ghi legacy')
    expect(formatResultScopeLabel(normalizeResultScopeItem(1, {
      scopeKind: 'v2',
      recordingSessionId: 3,
      attemptId: 4,
    }))).toBe('Phiên 3 · Lần 4')
  })
})
