import { describe, expect, it } from 'vitest'
import { collectEvidenceMatchesFromActionPlan, collectEvidenceMatchesFromAnalysis, mapSearchEvidenceMatches } from './evidenceMatches'
import type { MeetingActionPlanData, TranscriptEvidenceMatch } from '../services/api'

describe('evidenceMatches', () => {
  it('collects verified evidence from action plan items', () => {
    const plan: MeetingActionPlanData = {
      meeting: { meetingId: 7 },
      actionItems: [
        {
          task: 'Ship fix',
          evidence: {
            evidenceId: 'ev-1',
            segmentId: 'seg-1',
            index: 0,
            speaker: 'Alice',
            startTime: 1,
            endTime: 2,
            text: 'we should ship the fix',
            textTruncated: false,
            contextBefore: [],
            contextAfter: [],
            score: 0.9,
            rank: 1,
            matchType: 'phrase',
            verificationStatus: 'verified',
          },
        },
      ],
      painPoints: [],
      risks: [],
      blockers: [],
      analysisMetadata: {},
    }

    expect(collectEvidenceMatchesFromActionPlan(plan)).toEqual([
      {
        verificationStatus: 'verified',
        score: 0.9,
        snippet: 'we should ship the fix',
        speaker: 'Alice',
        startTime: 1,
        endTime: 2,
      },
    ])
  })

  it('maps transcript search matches for analysis panel preview', () => {
    const matches: TranscriptEvidenceMatch[] = [
      {
        evidenceId: 'ev-2',
        segmentId: 'seg-2',
        index: 1,
        speaker: 'Bob',
        startTime: 3,
        endTime: 4,
        text: 'deadline next week',
        textTruncated: false,
        contextBefore: [],
        contextAfter: [],
        score: 0.5,
        rank: 1,
        matchType: 'token',
        verificationStatus: 'weak',
      },
    ]

    expect(mapSearchEvidenceMatches(matches)[0].verificationStatus).toBe('weak')
  })

  it('collects evidence matches from analysis.evidence block', () => {
    expect(collectEvidenceMatchesFromAnalysis({
      evidence: {
        matches: [
          {
            verificationStatus: 'verified',
            score: 0.8,
            snippet: 'ship the fix',
            speaker: 'Alice',
            startTime: 1,
            endTime: 2,
          },
        ],
      },
    })).toEqual([
      {
        verificationStatus: 'verified',
        score: 0.8,
        snippet: 'ship the fix',
        speaker: 'Alice',
        startTime: 1,
        endTime: 2,
      },
    ])
  })
})
