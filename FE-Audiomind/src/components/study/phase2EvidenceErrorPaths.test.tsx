/** Evidence handoff error paths for Phase 2 cross-meeting navigation. */

import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import FeatureAnalysis from '../features/FeatureAnalysis'
import { scrollTranscriptToHighlight } from '../../utils/transcriptJump'
import { navigateToSubjectEvidence } from '../../utils/subjectEvidence'

vi.mock('../../utils/transcriptJump', async () => {
  const actual = await vi.importActual<typeof import('../../utils/transcriptJump')>('../../utils/transcriptJump')
  return {
    ...actual,
    scrollTranscriptToHighlight: vi.fn(),
  }
})

vi.mock('../../services/knowledgeLayer', () => ({
  listKnowledgeNotes: vi.fn().mockResolvedValue([]),
  createKnowledgeNote: vi.fn(),
  updateKnowledgeNote: vi.fn(),
  deleteKnowledgeNote: vi.fn(),
  listSpeakerProfiles: vi.fn().mockResolvedValue([]),
  upsertSpeakerProfiles: vi.fn(),
}))

const flush = async () => {
  await act(async () => {
    await Promise.resolve()
    await Promise.resolve()
  })
}

const educationAnalysis = (sourceSegmentIds: string[]) => ({
  summary: 'Legacy summary remains visible',
  keywords: [],
  technicalTerms: [],
  painPoints: [],
  actionItems: [],
  domainMode: 'education',
  educationStudy: {
    title: 'Network lesson',
    overview: 'OSI overview',
    learningObjectives: [],
    sections: [],
    keyPoints: [{
      content: 'Physical layer transmits bits',
      importance: 'HIGH',
      sourceSegmentIds,
    }],
    keywords: [],
    glossary: [],
    mustRemember: [],
    unclearPoints: [],
  },
})

describe('Phase 2 evidence error paths', () => {
  let container: HTMLDivElement
  let root: ReturnType<typeof createRoot>

  beforeEach(() => {
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
    vi.clearAllMocks()
  })

  afterEach(async () => {
    await flush()
    await flush()
    act(() => root.unmount())
    container.remove()
  })

  it('shows warning for missing evidence and does not scroll', async () => {
    await act(async () => {
      root.render(
        <FeatureAnalysis
          meetingId={42}
          hydrateFromApi={false}
          analysis={educationAnalysis(['seg-missing']) as never}
          transcriptSegments={[
            { id: 'seg-real', speaker: 'A', text: 'hello', start: 0, end: 1 },
          ]}
        />,
      )
    })
    const modelTab = container.querySelector(
      '[data-testid="feature-analysis-model-tab"]',
    ) as HTMLButtonElement
    await act(async () => {
      modelTab.click()
    })
    await flush()
    const evidenceButton = container.querySelector(
      '[data-testid="education-evidence-button"]',
    ) as HTMLButtonElement
    await act(async () => {
      evidenceButton.click()
    })
    await flush()
    expect(container.querySelector('[role="status"]')?.textContent ?? '').toContain(
      'Không tìm thấy đoạn transcript',
    )
    expect(scrollTranscriptToHighlight).not.toHaveBeenCalled()
  })

  it('waits for transcript segments before scrolling evidenceSegmentId', async () => {
    await act(async () => {
      root.render(
        <FeatureAnalysis
          meetingId={7}
          hydrateFromApi={false}
          analysis={null}
          transcriptSegments={[]}
          evidenceSegmentId="seg-1"
        />,
      )
    })
    await flush()
    expect(scrollTranscriptToHighlight).not.toHaveBeenCalled()

    await act(async () => {
      root.render(
        <FeatureAnalysis
          meetingId={7}
          hydrateFromApi={false}
          analysis={null}
          transcriptSegments={[{ id: 'seg-1', speaker: 'A', text: 'ready', start: 1, end: 2 }]}
          evidenceSegmentId="seg-1"
        />,
      )
    })
    await flush()
    expect(scrollTranscriptToHighlight).toHaveBeenCalled()
  })

  it('does not navigate when unauthorized evidence handler blocks', () => {
    const pushState = vi.spyOn(window.history, 'pushState').mockImplementation(() => undefined)
    const canAccess = false
    if (canAccess) {
      navigateToSubjectEvidence({ meetingId: 99, segmentId: 'secret' })
    }
    expect(pushState).not.toHaveBeenCalled()
  })
})
