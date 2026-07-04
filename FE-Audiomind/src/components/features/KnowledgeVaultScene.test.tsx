import { createRoot } from 'react-dom/client'
import { act } from 'react-dom/test-utils'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import * as knowledgeLayer from '../../services/knowledgeLayer'
import { saveGlossaryNotes } from '../../utils/glossaryNotes'
import KnowledgeVaultScene from './KnowledgeVaultScene'

vi.mock('../../services/knowledgeLayer', () => ({
  listKnowledgeNotes: vi.fn(),
  createKnowledgeNote: vi.fn(),
  deleteKnowledgeNote: vi.fn(),
}))

const flush = async () => {
  await act(async () => {
    await Promise.resolve()
    await Promise.resolve()
  })
}

describe('KnowledgeVaultScene', () => {
  let container: HTMLDivElement
  let root: ReturnType<typeof createRoot>

  beforeEach(() => {
    localStorage.clear()
    vi.mocked(knowledgeLayer.listKnowledgeNotes).mockResolvedValue([])
    vi.mocked(knowledgeLayer.createKnowledgeNote).mockResolvedValue({
      id: 99,
      meetingId: 7,
      noteType: 'glossary',
      title: 'Ghi chú thuật ngữ',
      body: 'Synced body',
    })
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
  })

  afterEach(() => {
    act(() => {
      root.unmount()
    })
    container.remove()
    vi.restoreAllMocks()
    localStorage.clear()
  })

  it('shows local glossary notes when server list fails', async () => {
    saveGlossaryNotes(7, 'Ghi chu local')
    vi.mocked(knowledgeLayer.listKnowledgeNotes).mockRejectedValue(new Error('Unauthorized'))

    await act(async () => {
      root.render(<KnowledgeVaultScene />)
    })
    await flush()

    expect(container.querySelector('[data-testid="knowledge-vault-local-7"]')).toBeTruthy()
    expect(container.textContent).toContain('Ghi chu local')
    expect(container.textContent).toContain('Chưa đồng bộ')
  })

  it('auto-syncs pending local glossary notes on load', async () => {
    saveGlossaryNotes(7, 'Can dong bo')
    vi.mocked(knowledgeLayer.listKnowledgeNotes)
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{
        id: 99,
        meetingId: 7,
        noteType: 'glossary',
        title: 'Ghi chú thuật ngữ',
        body: 'Synced body',
      }])

    await act(async () => {
      root.render(<KnowledgeVaultScene />)
    })
    await flush()

    expect(knowledgeLayer.createKnowledgeNote).toHaveBeenCalledWith({
      meetingId: 7,
      noteType: 'glossary',
      title: 'Ghi chú thuật ngữ',
      body: 'Can dong bo',
    })
    expect(container.textContent).toContain('Synced body')
  })

  it('groups notes by meeting and shows one open-meeting action per group', async () => {
    vi.mocked(knowledgeLayer.listKnowledgeNotes).mockResolvedValue([
      {
        id: 1,
        meetingId: 7,
        noteType: 'glossary',
        title: 'Term A',
        body: 'Body A',
        updatedAt: '2026-06-25T10:00:00.000Z',
      },
      {
        id: 2,
        meetingId: 7,
        noteType: 'glossary',
        title: 'Term B',
        body: 'Body B',
        updatedAt: '2026-06-25T11:00:00.000Z',
      },
    ])

    await act(async () => {
      root.render(<KnowledgeVaultScene onOpenMeeting={() => undefined} />)
    })
    await flush()

    expect(container.querySelectorAll('[data-testid="knowledge-vault-open-meeting-7"]')).toHaveLength(1)
    expect(container.querySelector('[data-testid="knowledge-vault-group-7"]')).toBeTruthy()
    expect(container.textContent).toContain('2 ghi chú')
    expect(container.textContent).not.toContain('Mở meeting #7')
  })

  it('collapses and expands a meeting group', async () => {
    vi.mocked(knowledgeLayer.listKnowledgeNotes).mockResolvedValue([
      {
        id: 1,
        meetingId: 7,
        noteType: 'glossary',
        title: 'Term A',
        body: 'Body A',
      },
    ])

    await act(async () => {
      root.render(<KnowledgeVaultScene />)
    })
    await flush()

    expect(container.textContent).toContain('Body A')

    const collapseButton = container.querySelector('[data-testid="knowledge-vault-collapse-7"]') as HTMLButtonElement
    expect(collapseButton).toBeTruthy()

    await act(async () => {
      collapseButton.click()
    })
    await flush()

    expect(container.textContent).not.toContain('Body A')

    await act(async () => {
      collapseButton.click()
    })
    await flush()

    expect(container.textContent).toContain('Body A')
  })
})
