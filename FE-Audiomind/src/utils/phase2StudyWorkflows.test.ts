import { afterEach, describe, expect, it, vi } from 'vitest'
import { aggregateStudyStatuses } from '../types/studyArtifacts'
import { buildAnalysisEvidencePath, navigateToSubjectEvidence, readEvidenceSegmentId } from './subjectEvidence'
import { hasCycleOrOrphan } from '../components/study/SubjectMindMapView'
import * as studyArtifactsService from '../services/studyArtifacts'

describe('subjectEvidence', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('builds analysis path with evidenceSegmentId', () => {
    expect(buildAnalysisEvidencePath({ meetingId: 42, segmentId: 'seg-9' })).toBe(
      '/studio/analysis?meetingId=42&evidenceSegmentId=seg-9',
    )
  })

  it('reads evidence segment from search', () => {
    expect(readEvidenceSegmentId({ search: '?meetingId=1&evidenceSegmentId=abc' })).toBe('abc')
    expect(readEvidenceSegmentId({ search: '?meetingId=1' })).toBeNull()
  })

  it('navigateToSubjectEvidence pushes history state', () => {
    const pushState = vi.spyOn(window.history, 'pushState').mockImplementation(() => undefined)
    navigateToSubjectEvidence({ meetingId: 7, segmentId: 's1' })
    expect(pushState).toHaveBeenCalledWith(
      { evidenceSegmentId: 's1' },
      '',
      '/studio/analysis?meetingId=7&evidenceSegmentId=s1',
    )
  })
})

describe('SubjectMindMapView safety', () => {
  it('detects orphan and cycle', () => {
    expect(
      hasCycleOrOrphan('root', [
        { id: 'a', parentId: 'missing', label: 'A', type: 'TOPIC', sourceMeetingIds: [], sourceSegmentIds: [] },
      ]),
    ).toBe(true)
    expect(
      hasCycleOrOrphan('root', [
        { id: 'a', parentId: 'b', label: 'A', type: 'TOPIC', sourceMeetingIds: [], sourceSegmentIds: [] },
        { id: 'b', parentId: 'a', label: 'B', type: 'TOPIC', sourceMeetingIds: [], sourceSegmentIds: [] },
      ]),
    ).toBe(true)
    expect(
      hasCycleOrOrphan('root', [
        { id: 'a', parentId: 'root', label: 'A', type: 'TOPIC', sourceMeetingIds: [], sourceSegmentIds: [] },
      ]),
    ).toBe(false)
  })
})

describe('pollStudyArtifactsUntilTerminal', () => {
  afterEach(() => {
    vi.restoreAllMocks()
    vi.useRealTimers()
  })

  it('polls each artifactId and stops when all terminal with PARTIALLY_FAILED', async () => {
    vi.useFakeTimers()
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input)
      const id = url.includes('/1001') ? 1001 : 1002
      const status = id === 1001 ? 'COMPLETED' : 'FAILED'
      return {
        ok: true,
        status: 200,
        json: async () => ({
          id,
          subjectId: 1,
          ownerUserId: 1,
          artifactType: id === 1001 ? 'FLASHCARDS' : 'MIND_MAP',
          status,
          version: 1,
          sourceHash: 'h',
          optionsHash: 'o',
          sourceSelectionMode: 'ALL_READY',
          sourceMeetingIds: [],
          sources: [],
          cacheHit: false,
          stale: false,
        }),
      } as Response
    })
    vi.stubGlobal('fetch', fetchMock)

    const pending = studyArtifactsService.pollStudyArtifactsUntilTerminal([1001, 1002], {
      intervalMs: 2000,
    })
    await vi.runAllTimersAsync()
    const result = await pending
    expect(fetchMock.mock.calls.length).toBeGreaterThanOrEqual(2)
    expect(result.aggregateStatus).toBe('PARTIALLY_FAILED')
    expect(result.artifacts).toHaveLength(2)
  })

  it('does not poll when artifactIds empty', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    const result = await studyArtifactsService.pollStudyArtifactsUntilTerminal([])
    expect(fetchMock).not.toHaveBeenCalled()
    expect(result.aggregateStatus).toBe('FAILED')
  })

  it('stops after first poll when all artifacts already terminal (cache-hit path)', async () => {
    vi.useFakeTimers()
    const fetchMock = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({
        id: 7,
        subjectId: 1,
        ownerUserId: 1,
        artifactType: 'FLASHCARDS',
        status: 'COMPLETED',
        version: 1,
        sourceHash: 'h',
        optionsHash: 'o',
        sourceSelectionMode: 'ALL_READY',
        sourceMeetingIds: [],
        sources: [],
        cacheHit: true,
        stale: false,
      }),
    }) as Response)
    vi.stubGlobal('fetch', fetchMock)
    const pending = studyArtifactsService.pollStudyArtifactsUntilTerminal([7], { intervalMs: 5000 })
    await vi.runAllTimersAsync()
    const result = await pending
    expect(result.aggregateStatus).toBe('COMPLETED')
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })
})

describe('aggregate PARTIALLY_FAILED contract', () => {
  it('never returns COMPLETED when any failed', () => {
    expect(aggregateStudyStatuses(['COMPLETED', 'FAILED'])).toBe('PARTIALLY_FAILED')
    expect(aggregateStudyStatuses(['COMPLETED', 'FAILED'])).not.toBe('COMPLETED')
  })
})
