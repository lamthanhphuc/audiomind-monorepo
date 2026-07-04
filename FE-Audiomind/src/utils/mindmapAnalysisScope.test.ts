import { afterEach, describe, expect, it, vi } from 'vitest'

import * as api from '../services/api'
import { normalizeResultScopeItem } from './meetingResultScope'
import {
  buildMindmapAnalysisRequestKey,
  canReuseMindmapSelectedScope,
  loadMindmapSavedAnalysis,
  resolveMindmapAnalysisScope,
  shouldApplyMindmapLoadResult,
} from './mindmapAnalysisScope'

const v2ScopeMeeting7 = normalizeResultScopeItem(7, {
  scopeKind: 'v2',
  recordingSessionId: 9001,
  attemptId: 2,
})

const v2ScopeMeeting8 = normalizeResultScopeItem(8, {
  scopeKind: 'v2',
  recordingSessionId: 9002,
  attemptId: 1,
})

const legacyScopeMeeting7 = normalizeResultScopeItem(7, { scopeKind: 'legacy' })

describe('mindmapAnalysisScope', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('resolves v2 scope before saved analysis when selected scope is missing', async () => {
    const resolveSpy = vi.spyOn(api, 'resolveMeetingResultScope').mockResolvedValue(v2ScopeMeeting7)
    const savedSpy = vi.spyOn(api, 'getSavedAnalysis').mockResolvedValue({
      summary: 'Scoped mindmap analysis',
      keywords: [],
      technicalTerms: [],
      painPoints: [],
      actionItems: [],
      domainMode: 'it',
    } as any)

    await loadMindmapSavedAnalysis(7, null)

    expect(resolveSpy).toHaveBeenCalledTimes(1)
    expect(resolveSpy).toHaveBeenCalledWith(7, undefined, expect.objectContaining({ signal: undefined }))
    expect(savedSpy).toHaveBeenCalledTimes(1)
    expect(savedSpy).toHaveBeenCalledWith(7, expect.objectContaining({
      recordingSessionId: 9001,
      attemptId: 2,
    }))
  })

  it('reuses selected scope for the same meeting without resolving again', async () => {
    const resolveSpy = vi.spyOn(api, 'resolveMeetingResultScope').mockResolvedValue(v2ScopeMeeting7)
    const savedSpy = vi.spyOn(api, 'getSavedAnalysis').mockResolvedValue({
      summary: 'Already scoped',
      keywords: [],
      technicalTerms: [],
      painPoints: [],
      actionItems: [],
      domainMode: 'it',
    } as any)

    await loadMindmapSavedAnalysis(7, v2ScopeMeeting7)

    expect(resolveSpy).not.toHaveBeenCalled()
    expect(savedSpy).toHaveBeenCalledWith(7, expect.objectContaining({
      recordingSessionId: 9001,
      attemptId: 2,
    }))
  })

  it('does not reuse selected scope from another meeting', async () => {
    const resolveSpy = vi.spyOn(api, 'resolveMeetingResultScope').mockResolvedValue(v2ScopeMeeting8)
    vi.spyOn(api, 'getSavedAnalysis').mockResolvedValue({
      summary: 'Meeting 8 analysis',
      keywords: [],
      technicalTerms: [],
      painPoints: [],
      actionItems: [],
      domainMode: 'it',
    } as any)

    await loadMindmapSavedAnalysis(8, v2ScopeMeeting7)

    expect(resolveSpy).toHaveBeenCalledWith(8, undefined, expect.any(Object))
    expect(canReuseMindmapSelectedScope(8, v2ScopeMeeting7)).toBe(false)
    expect(buildMindmapAnalysisRequestKey(8, v2ScopeMeeting7)).toBe('8:resolve')
  })

  it('loads legacy analysis without provenance query params', async () => {
    const resolveSpy = vi.spyOn(api, 'resolveMeetingResultScope').mockResolvedValue(legacyScopeMeeting7)
    const savedSpy = vi.spyOn(api, 'getSavedAnalysis').mockResolvedValue({
      summary: 'Legacy analysis',
      keywords: [],
      technicalTerms: [],
      painPoints: [],
      actionItems: [],
      domainMode: 'it',
    } as any)

    await loadMindmapSavedAnalysis(7, null)

    expect(resolveSpy).toHaveBeenCalledTimes(1)
    expect(savedSpy).toHaveBeenCalledWith(7, expect.not.objectContaining({
      recordingSessionId: expect.anything(),
      attemptId: expect.anything(),
    }))
  })

  it('rejects stale mindmap load results when request key changes', () => {
    const signal = new AbortController().signal
    expect(shouldApplyMindmapLoadResult('7:resolve', '8:resolve', signal)).toBe(false)
    expect(shouldApplyMindmapLoadResult('7:v2:9001:2', '7:v2:9001:2', signal)).toBe(true)
  })

  it('resolveMindmapAnalysisScope only calls API when scope is missing or mismatched', async () => {
    const resolveSpy = vi.spyOn(api, 'resolveMeetingResultScope').mockResolvedValue(v2ScopeMeeting7)

    await expect(resolveMindmapAnalysisScope(7, v2ScopeMeeting7)).resolves.toEqual(v2ScopeMeeting7)
    expect(resolveSpy).not.toHaveBeenCalled()

    await expect(resolveMindmapAnalysisScope(8, v2ScopeMeeting7)).resolves.toEqual(v2ScopeMeeting7)
    expect(resolveSpy).toHaveBeenCalledWith(8, undefined, expect.any(Object))
  })
})
