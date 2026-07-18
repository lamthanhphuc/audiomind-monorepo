import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { StudyArtifactGenerator } from './StudyArtifactGenerator'
import { SubjectSynthesisPanel } from './SubjectSynthesisPanel'

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
})
