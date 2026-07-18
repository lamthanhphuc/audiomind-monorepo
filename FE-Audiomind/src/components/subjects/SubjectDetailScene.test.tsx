import { createRoot } from 'react-dom/client'
import { act } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { SubjectDetailScene } from './SubjectDetailScene'

vi.mock('../../hooks/useSubjectDetail', () => ({
  useSubjectDetail: () => ({
    subject: {
      id: 1,
      name: 'Toán rời rạc',
      code: 'MAT101',
      semester: '2026A',
      meetingCount: 1,
    },
    meetingsPage: {
      items: [
        {
          id: 11,
          title: 'Buổi 1',
          status: 'COMPLETED',
          language: 'vi',
          createdAt: '2026-01-01T00:00:00Z',
          subjectId: 1,
        },
      ],
      total: 1,
      page: 1,
      pageSize: 10,
      totalPages: 1,
    },
    loading: false,
    error: null,
    reload: vi.fn(),
  }),
}))

vi.mock('../../hooks/useStudyWorkspace', () => ({
  useStudyWorkspace: () => ({
    assignMeetingToSubject: vi.fn(),
    catalogRevision: 0,
    catalogSubjects: [{ id: 1, name: 'Toán rời rạc' }],
    catalogLoading: false,
  }),
}))

vi.mock('../../services/subjectSynthesis', () => ({
  getSubjectSynthesis: vi.fn(async () => null),
  createSubjectSynthesis: vi.fn(),
  regenerateSubjectSynthesis: vi.fn(),
  pollSubjectSynthesisUntilTerminal: vi.fn(),
}))

vi.mock('../../services/studyArtifacts', () => ({
  listSubjectStudyArtifacts: vi.fn(async () => []),
  createStudyArtifacts: vi.fn(),
  pollStudyArtifactsUntilTerminal: vi.fn(),
  regenerateStudyArtifact: vi.fn(),
}))

describe('SubjectDetailScene', () => {
  let container: HTMLDivElement
  let root: ReturnType<typeof createRoot>

  beforeEach(() => {
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
  })

  afterEach(() => {
    act(() => {
      root.unmount()
    })
    container.remove()
  })

  it('renders meetings tab by default (Phase 1)', () => {
    act(() => {
      root.render(
        <SubjectDetailScene
          subjectId={1}
          onOpenMeeting={vi.fn()}
          onBack={vi.fn()}
        />,
      )
    })

    expect(container.querySelector('[data-testid="subject-detail-scene"]')).not.toBeNull()
    expect(container.querySelector('[data-testid="subject-detail-tabs"]')).not.toBeNull()
    expect(container.querySelector('[data-testid="subject-meetings-tab"]')).not.toBeNull()
    expect(container.textContent).toContain('Buổi học')
    expect(container.textContent).toContain('Buổi 1')
    expect(container.textContent).toContain('Toán rời rạc')
  })

  it('switches to synthesis tab without auto-generating', () => {
    const onTabChange = vi.fn()
    act(() => {
      root.render(
        <SubjectDetailScene
          subjectId={1}
          activeTab="meetings"
          onTabChange={onTabChange}
          onOpenMeeting={vi.fn()}
          onBack={vi.fn()}
        />,
      )
    })

    const synthesisTab = container.querySelector('[data-testid="subject-tab-synthesis"]') as HTMLButtonElement
    act(() => {
      synthesisTab.click()
    })
    expect(onTabChange).toHaveBeenCalledWith('synthesis')
  })
})
