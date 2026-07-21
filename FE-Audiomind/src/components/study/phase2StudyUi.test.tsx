import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { StudyArtifactGenerator } from './StudyArtifactGenerator'
import { SubjectSynthesisPanel } from './SubjectSynthesisPanel'
import { StudyArtifactTabPanel } from './StudyArtifactTabPanel'
import { layoutNodes } from './SubjectMindMapView'

// ─── Module mocks (hoisted so vi.mock can reference them) ───────────────────
const { listSubjectStudyArtifactsMock, deleteStudyArtifactMock } = vi.hoisted(() => ({
  listSubjectStudyArtifactsMock: vi.fn(),
  deleteStudyArtifactMock: vi.fn(),
}))

vi.mock('../../services/studyArtifacts', async (importOriginal) => {
  const orig = await importOriginal<typeof import('../../services/studyArtifacts')>()
  return {
    ...orig,
    listSubjectStudyArtifacts: listSubjectStudyArtifactsMock,
    deleteStudyArtifact: deleteStudyArtifactMock,
  }
})

const flush = async () => {
  await act(async () => {
    await Promise.resolve()
    await Promise.resolve()
  })
}

const baseArtifact = {
  id: 7,
  subjectId: 1,
  artifactType: 'FLASHCARDS' as const,
  status: 'COMPLETED',
  version: 1,
}

const tabPanelProps = {
  subjectId: 1,
  artifactType: 'FLASHCARDS' as const,
  meetings: [] as { id: number; title: string; createdAt: string }[],
}

describe('StudyArtifactGenerator double-submit guard', () => {
  let container: HTMLDivElement
  let root: ReturnType<typeof createRoot>

  beforeEach(() => {
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
  })

  afterEach(() => {
    act(() => root.unmount())
    container.remove()
  })

  it('disables generate button while busy', () => {
    const onGenerate = vi.fn()
    act(() => {
      root.render(
        <StudyArtifactGenerator
          subjectId={1}
          meetings={[{ id: 1, title: 'B1', createdAt: '2026-01-01T00:00:00Z' }]}
          artifactTypes={['FLASHCARDS']}
          busy
          onGenerate={onGenerate}
        />,
      )
    })
    const button = container.querySelector('[data-testid="study-generate-button"]') as HTMLButtonElement
    expect(button.disabled).toBe(true)
    act(() => {
      button.click()
    })
    expect(onGenerate).not.toHaveBeenCalled()
  })
})

describe('SubjectSynthesisPanel stale banner', () => {
  let container: HTMLDivElement
  let root: ReturnType<typeof createRoot>

  beforeEach(() => {
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
  })

  afterEach(() => {
    act(() => root.unmount())
    container.remove()
  })

  it('shows stale banner and update button', () => {
    const onUpdate = vi.fn()
    act(() => {
      root.render(
        <SubjectSynthesisPanel
          synthesis={{
            id: 9,
            subjectId: 1,
            ownerUserId: 1,
            status: 'STALE',
            version: 1,
            sourceHash: 'h',
            sourceSelectionMode: 'ALL_READY',
            sourceMeetingIds: [1],
            sources: [],
            stale: true,
            cacheHit: false,
            content: {
              subjectOverview: 'Overview',
              learningObjectives: [],
              chapters: [],
              importantTerms: [],
              mustRemember: [],
              knowledgeGaps: [],
              examFocus: [],
            },
          }}
          onUpdate={onUpdate}
        />,
      )
    })
    expect(container.querySelector('[data-testid="synthesis-stale-banner"]')).toBeTruthy()
    expect(container.textContent).toMatch(/Cập nhật|Nguồn đã đổi/)
  })

  it('keeps generate button visible when error is set', () => {
    const onGenerate = vi.fn()
    act(() => {
      root.render(
        <SubjectSynthesisPanel
          error="SOURCE_MEETINGS_NOT_READY"
          onGenerate={onGenerate}
        />,
      )
    })
    expect(container.querySelector('[data-testid="synthesis-generate-button"]')).toBeTruthy()
    expect(container.textContent).toMatch(/SOURCE_MEETINGS_NOT_READY|phân tích sẵn sàng/)
  })
})

// ─── StudyArtifactTabPanel — delete flow ─────────────────────────────────────

describe('StudyArtifactTabPanel delete flow', () => {
  let container: HTMLDivElement
  let root: ReturnType<typeof createRoot>

  beforeEach(() => {
    deleteStudyArtifactMock.mockResolvedValue(undefined)
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
  })

  afterEach(async () => {
    await act(async () => { root.unmount() })
    container.remove()
    vi.clearAllMocks()
  })

  it('hides delete button while initial load is in progress', async () => {
    listSubjectStudyArtifactsMock.mockResolvedValue([baseArtifact])
    act(() => { root.render(<StudyArtifactTabPanel {...tabPanelProps} />) })
    // Before flush: still loading
    expect(container.querySelector('[data-testid="artifact-delete-btn"]')).toBeNull()
    await flush()
  })

  it('shows delete button once artifact is loaded', async () => {
    listSubjectStudyArtifactsMock.mockResolvedValue([baseArtifact])
    act(() => { root.render(<StudyArtifactTabPanel {...tabPanelProps} />) })
    await flush()
    expect(container.querySelector('[data-testid="artifact-delete-btn"]')).toBeTruthy()
  })

  it('does not show delete button when no artifact exists', async () => {
    listSubjectStudyArtifactsMock.mockResolvedValue([])
    act(() => { root.render(<StudyArtifactTabPanel {...tabPanelProps} />) })
    await flush()
    expect(container.querySelector('[data-testid="artifact-delete-btn"]')).toBeNull()
  })

  it('opens confirm dialog when delete button is clicked', async () => {
    listSubjectStudyArtifactsMock.mockResolvedValue([baseArtifact])
    act(() => { root.render(<StudyArtifactTabPanel {...tabPanelProps} />) })
    await flush()
    act(() => {
      ;(container.querySelector('[data-testid="artifact-delete-btn"]') as HTMLButtonElement).click()
    })
    expect(container.querySelector('[data-testid="artifact-delete-dialog"]')).toBeTruthy()
  })

  it('calls deleteStudyArtifact with artifact id on confirm', async () => {
    listSubjectStudyArtifactsMock.mockResolvedValue([baseArtifact])
    act(() => { root.render(<StudyArtifactTabPanel {...tabPanelProps} />) })
    await flush()
    act(() => {
      ;(container.querySelector('[data-testid="artifact-delete-btn"]') as HTMLButtonElement).click()
    })
    await act(async () => {
      ;(container.querySelector('[data-testid="artifact-delete-dialog-confirm"]') as HTMLButtonElement).click()
    })
    expect(deleteStudyArtifactMock).toHaveBeenCalledWith(baseArtifact.id)
  })

  it('refreshes artifact list after successful delete', async () => {
    listSubjectStudyArtifactsMock
      .mockResolvedValueOnce([baseArtifact])
      .mockResolvedValueOnce([])
    act(() => { root.render(<StudyArtifactTabPanel {...tabPanelProps} />) })
    await flush()
    act(() => {
      ;(container.querySelector('[data-testid="artifact-delete-btn"]') as HTMLButtonElement).click()
    })
    await act(async () => {
      ;(container.querySelector('[data-testid="artifact-delete-dialog-confirm"]') as HTMLButtonElement).click()
    })
    await flush()
    expect(listSubjectStudyArtifactsMock).toHaveBeenCalledTimes(2)
    expect(container.querySelector('[data-testid="artifact-delete-btn"]')).toBeNull()
  })

  it('shows error message inside dialog when delete fails', async () => {
    listSubjectStudyArtifactsMock.mockResolvedValue([baseArtifact])
    deleteStudyArtifactMock.mockRejectedValueOnce(new Error('Lỗi server'))
    act(() => { root.render(<StudyArtifactTabPanel {...tabPanelProps} />) })
    await flush()
    act(() => {
      ;(container.querySelector('[data-testid="artifact-delete-btn"]') as HTMLButtonElement).click()
    })
    await act(async () => {
      ;(container.querySelector('[data-testid="artifact-delete-dialog-confirm"]') as HTMLButtonElement).click()
    })
    await flush()
    expect(container.querySelector('[data-testid="artifact-delete-dialog"]')).toBeTruthy()
    expect(container.textContent).toContain('Lỗi server')
  })

  it('disables confirm button (busy) while delete is in-flight', async () => {
    listSubjectStudyArtifactsMock.mockResolvedValue([baseArtifact])
    let resolveDelete!: () => void
    deleteStudyArtifactMock.mockReturnValueOnce(new Promise<void>((res) => { resolveDelete = res }))
    act(() => { root.render(<StudyArtifactTabPanel {...tabPanelProps} />) })
    await flush()
    act(() => {
      ;(container.querySelector('[data-testid="artifact-delete-btn"]') as HTMLButtonElement).click()
    })
    act(() => {
      ;(container.querySelector('[data-testid="artifact-delete-dialog-confirm"]') as HTMLButtonElement).click()
    })
    const confirmBtn = container.querySelector('[data-testid="artifact-delete-dialog-confirm"]') as HTMLButtonElement
    expect(confirmBtn.disabled).toBe(true)
    // Resolve to let React clean up properly
    await act(async () => { resolveDelete() })
  })

  it('cancelling dialog leaves artifact in place', async () => {
    listSubjectStudyArtifactsMock.mockResolvedValue([baseArtifact])
    act(() => { root.render(<StudyArtifactTabPanel {...tabPanelProps} />) })
    await flush()
    act(() => {
      ;(container.querySelector('[data-testid="artifact-delete-btn"]') as HTMLButtonElement).click()
    })
    // Click cancel (second button in dialog actions)
    act(() => {
      const buttons = container.querySelectorAll('.subject-dialog__actions .btn')
      ;(buttons[0] as HTMLButtonElement).click()
    })
    expect(deleteStudyArtifactMock).not.toHaveBeenCalled()
    expect(container.querySelector('[data-testid="artifact-delete-dialog"]')).toBeNull()
    expect(container.querySelector('[data-testid="artifact-delete-btn"]')).toBeTruthy()
  })
})

// ─── layoutNodes — evidence wiring ───────────────────────────────────────────

describe('layoutNodes evidence wiring', () => {
  it('embeds evidenceMeetingId and evidenceSegmentId for nodes that have them', () => {
    const { nodes } = layoutNodes({
      root: { id: 'root', label: 'Root' },
      nodes: [
        {
          id: 'n1',
          parentId: 'root',
          label: 'Node 1',
          sourceMeetingIds: [42],
          sourceSegmentIds: ['seg-abc'],
        },
        {
          id: 'n2',
          parentId: 'root',
          label: 'Node 2',
        },
      ],
      edges: [],
    })

    const n1 = nodes.find((n) => n.id === 'n1')
    const n2 = nodes.find((n) => n.id === 'n2')

    expect(n1?.data.evidenceMeetingId).toBe(42)
    expect(n1?.data.evidenceSegmentId).toBe('seg-abc')
    expect(n2?.data.evidenceMeetingId).toBeUndefined()
    expect(n2?.data.evidenceSegmentId).toBeUndefined()
  })

  it('sets pointer cursor style only on nodes with evidence', () => {
    const { nodes } = layoutNodes({
      root: { id: 'root', label: 'Root' },
      nodes: [
        {
          id: 'e1',
          parentId: 'root',
          label: 'With evidence',
          sourceMeetingIds: [1],
          sourceSegmentIds: ['s1'],
        },
        {
          id: 'e2',
          parentId: 'root',
          label: 'No evidence',
        },
      ],
      edges: [],
    })

    const e1 = nodes.find((n) => n.id === 'e1')
    const e2 = nodes.find((n) => n.id === 'e2')
    expect((e1?.style as Record<string, unknown>)?.cursor).toBe('pointer')
    expect((e2?.style as Record<string, unknown>)?.cursor).toBeUndefined()
  })

  it('falls back to sourceMeetingIds[0] + sourceSegmentIds[0] when no evidence array', () => {
    const { nodes } = layoutNodes({
      root: { id: 'root', label: 'Root' },
      nodes: [
        {
          id: 'fb',
          parentId: 'root',
          label: 'Fallback',
          sourceMeetingIds: [99],
          sourceSegmentIds: ['seg-fallback'],
        },
      ],
      edges: [],
    })

    const fb = nodes.find((n) => n.id === 'fb')
    expect(fb?.data.evidenceMeetingId).toBe(99)
    expect(fb?.data.evidenceSegmentId).toBe('seg-fallback')
  })
})
