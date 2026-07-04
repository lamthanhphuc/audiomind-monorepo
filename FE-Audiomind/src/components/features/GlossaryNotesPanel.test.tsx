// @vitest-environment jsdom
import { createRoot } from 'react-dom/client'
import { act } from 'react-dom/test-utils'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import GlossaryNotesPanel from './GlossaryNotesPanel'
import { getGlossaryNotes, saveGlossaryNotes } from '../../utils/glossaryNotes'
import { ApiError } from '../../services/api'

vi.mock('../../services/knowledgeLayer', () => ({
  listKnowledgeNotes: vi.fn().mockResolvedValue([]),
  createKnowledgeNote: vi.fn(),
  updateKnowledgeNote: vi.fn(),
  deleteKnowledgeNote: vi.fn(),
}))

import {
  createKnowledgeNote,
  deleteKnowledgeNote,
  listKnowledgeNotes,
  updateKnowledgeNote,
} from '../../services/knowledgeLayer'

const setTextareaValue = (textarea: HTMLTextAreaElement, value: string) => {
  const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value')?.set
  setter?.call(textarea, value)
  textarea.dispatchEvent(new Event('input', { bubbles: true }))
}

describe('GlossaryNotesPanel', () => {
  let container: HTMLDivElement
  let root: ReturnType<typeof createRoot>

  beforeEach(() => {
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
    localStorage.clear()
    vi.mocked(listKnowledgeNotes).mockResolvedValue([])
    vi.mocked(createKnowledgeNote).mockResolvedValue({
      id: 11,
      meetingId: 9,
      noteType: 'glossary',
      title: 'Ghi chú thuật ngữ',
      body: 'Server note',
    } as never)
    vi.mocked(updateKnowledgeNote).mockResolvedValue({
      id: 12,
      meetingId: 9,
      noteType: 'glossary',
      title: 'Ghi chú thuật ngữ',
      body: 'Updated note',
    } as never)
    vi.mocked(deleteKnowledgeNote).mockResolvedValue()
  })

  afterEach(() => {
    act(() => {
      root.unmount()
    })
    container.remove()
    vi.clearAllMocks()
  })

  it('returns null without meetingId', () => {
    act(() => {
      root.render(<GlossaryNotesPanel meetingId={null} analysis={null} />)
    })
    expect(container.querySelector('[data-testid="glossary-notes-panel"]')).toBeNull()
  })

  it('shows empty state when analysis has no technical terms', async () => {
    await act(async () => {
      root.render(<GlossaryNotesPanel meetingId={5} analysis={{ technicalTerms: [] } as never} />)
      await Promise.resolve()
    })
    expect(container.querySelector('[data-testid="glossary-notes-panel"]')).toBeTruthy()
    expect(container.textContent).toContain('Chưa có thuật ngữ')
  })

  it('renders technical terms from analysis', async () => {
    await act(async () => {
      root.render(
        <GlossaryNotesPanel
          meetingId={9}
          analysis={{
            technicalTerms: [{ term: 'API', meaning: 'Giao dien', category: 'protocol' }],
          } as never}
        />,
      )
      await Promise.resolve()
    })

    expect(container.textContent).toContain('API')
    expect(container.textContent).toContain('Giao dien')
  })

  it('loads persisted notes for meeting from local fallback', async () => {
    saveGlossaryNotes(9, 'Ghi chu da luu')
    await act(async () => {
      root.render(
        <GlossaryNotesPanel
          meetingId={9}
          analysis={{
            technicalTerms: [{ term: 'API', meaning: 'Giao dien', category: 'protocol' }],
          } as never}
        />,
      )
      await Promise.resolve()
    })

    const input = container.querySelector('[data-testid="glossary-notes-input"]') as HTMLTextAreaElement
    expect(input.value).toBe('Ghi chu da luu')
  })

  it('shows validation error when saving empty note without server note', async () => {
    await act(async () => {
      root.render(<GlossaryNotesPanel meetingId={9} analysis={null} />)
      await Promise.resolve()
    })

    const saveButton = container.querySelector('[data-testid="glossary-notes-save"]') as HTMLButtonElement
    await act(async () => {
      saveButton.click()
      await Promise.resolve()
    })

    expect(container.textContent).toContain('Nhập nội dung trước khi lưu')
    expect(createKnowledgeNote).not.toHaveBeenCalled()
  })

  it('creates server note and sync hint on save', async () => {
    await act(async () => {
      root.render(<GlossaryNotesPanel meetingId={9} analysis={null} />)
      await Promise.resolve()
    })

    const input = container.querySelector('[data-testid="glossary-notes-input"]') as HTMLTextAreaElement
    await act(async () => {
      setTextareaValue(input, 'Note moi')
    })

    const saveButton = container.querySelector('[data-testid="glossary-notes-save"]') as HTMLButtonElement
    await act(async () => {
      saveButton.click()
      await Promise.resolve()
    })

    expect(createKnowledgeNote).toHaveBeenCalled()
    expect(container.textContent).toContain('Đã đồng bộ lên server')
    expect(getGlossaryNotes(9)).toBe('Note moi')
  })

  it('deletes server note when saving empty content', async () => {
    vi.mocked(listKnowledgeNotes).mockResolvedValue([
      { id: 21, meetingId: 9, noteType: 'glossary', title: 'Ghi chú', body: 'Old note' },
    ] as never)

    await act(async () => {
      root.render(<GlossaryNotesPanel meetingId={9} analysis={null} />)
      await Promise.resolve()
    })

    const input = container.querySelector('[data-testid="glossary-notes-input"]') as HTMLTextAreaElement
    await act(async () => {
      setTextareaValue(input, '')
    })

    const saveButton = container.querySelector('[data-testid="glossary-notes-save"]') as HTMLButtonElement
    await act(async () => {
      saveButton.click()
      await Promise.resolve()
    })

    expect(deleteKnowledgeNote).toHaveBeenCalledWith(21)
    expect(getGlossaryNotes(9)).toBe('')
  })

  it('shows auth error on 401 save failure', async () => {
    vi.mocked(createKnowledgeNote).mockRejectedValueOnce(new ApiError('Unauthorized', 401))

    await act(async () => {
      root.render(<GlossaryNotesPanel meetingId={9} analysis={null} />)
      await Promise.resolve()
    })

    const input = container.querySelector('[data-testid="glossary-notes-input"]') as HTMLTextAreaElement
    await act(async () => {
      setTextareaValue(input, 'Note auth fail')
    })

    const saveButton = container.querySelector('[data-testid="glossary-notes-save"]') as HTMLButtonElement
    await act(async () => {
      saveButton.click()
      await Promise.resolve()
    })

    expect(container.textContent).toContain('Cần đăng nhập lại')
  })
})
