import { createRoot } from 'react-dom/client'
import { act } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import UnclassifiedMeetingsScene from './UnclassifiedMeetingsScene'
import type { Meeting } from '../../types'

const UNCLASSIFIED_SORT = 'createdAt_desc'

const { listUnclassifiedMeetingsMock, assignMeetingToSubjectMock, workspaceState } = vi.hoisted(() => {
  const workspaceState = { catalogRevision: 0 }
  return {
    workspaceState,
    listUnclassifiedMeetingsMock: vi.fn(),
    assignMeetingToSubjectMock: vi.fn(async () => {
      // Real StudyWorkspaceProvider bumps catalogRevision after assignment,
      // which is what triggers the unclassified list to reload.
      workspaceState.catalogRevision += 1
    }),
  }
})

vi.mock('../../services/subjects', () => ({
  listUnclassifiedMeetings: listUnclassifiedMeetingsMock,
}))

vi.mock('../../hooks/useStudyWorkspace', () => ({
  useStudyWorkspace: () => ({
    folderTree: null,
    catalogSubjects: [
      {
        id: 11,
        name: 'Toán rời rạc',
        code: 'MAT101',
        semester: 'HK1',
        color: null,
        folderId: null,
        archivedAt: null,
        meetingCount: 2,
      },
    ],
    treeRevision: 0,
    catalogRevision: workspaceState.catalogRevision,
    treeLoading: false,
    catalogLoading: false,
    treeError: null,
    catalogError: null,
    refreshFolderTree: vi.fn(),
    refreshCatalog: vi.fn(),
    invalidateAfterFolderMutation: vi.fn(),
    invalidateAfterSubjectMutation: vi.fn(),
    invalidateAfterMeetingSubjectMutation: vi.fn(),
    createFolder: vi.fn(),
    updateFolder: vi.fn(),
    removeFolder: vi.fn(),
    createSubjectEntry: vi.fn(),
    updateSubjectEntry: vi.fn(),
    archiveSubjectEntry: vi.fn(),
    assignMeetingToSubject: assignMeetingToSubjectMock,
  }),
}))

const makeMeeting = (id: number, title: string, createdAt: string): Meeting => ({
  id,
  title,
  audioPath: `/tmp/${id}.wav`,
  createdAt,
  language: 'vi',
  status: 'completed',
  subjectId: null,
} as Meeting)

const makePage = (
  items: Meeting[],
  options?: { total?: number; page?: number; pageSize?: number },
) => {
  const total = options?.total ?? items.length
  const pageSize = options?.pageSize ?? 10
  return {
    items,
    total,
    page: options?.page ?? 1,
    pageSize,
    totalPages: total === 0 ? 0 : Math.ceil(total / pageSize),
  }
}

const flush = async () => {
  await act(async () => {
    await Promise.resolve()
    await Promise.resolve()
  })
}

const setNativeValue = (element: HTMLInputElement | HTMLSelectElement, value: string) => {
  const valueSetter = Object.getOwnPropertyDescriptor(element, 'value')?.set
  const prototype = Object.getPrototypeOf(element)
  const prototypeValueSetter = Object.getOwnPropertyDescriptor(prototype, 'value')?.set
  if (prototypeValueSetter && valueSetter !== prototypeValueSetter) {
    prototypeValueSetter.call(element, value)
    return
  }
  valueSetter?.call(element, value)
}

describe('UnclassifiedMeetingsScene', () => {
  let container: HTMLDivElement
  let root: ReturnType<typeof createRoot>

  const mountScene = async () => {
    await act(async () => {
      root.render(<UnclassifiedMeetingsScene onOpenMeeting={vi.fn()} />)
    })
    await flush()
  }

  beforeEach(() => {
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
    workspaceState.catalogRevision = 0
    listUnclassifiedMeetingsMock.mockReset()
    assignMeetingToSubjectMock.mockClear()
    listUnclassifiedMeetingsMock.mockResolvedValue(
      makePage([
        makeMeeting(2, 'Buổi mới hơn', '2026-07-17T10:00:00Z'),
        makeMeeting(1, 'Buổi cũ hơn', '2026-07-15T10:00:00Z'),
      ]),
    )
  })

  afterEach(() => {
    act(() => {
      root.unmount()
    })
    container.remove()
    vi.useRealTimers()
  })

  it('requests newest-first contract sort on initial load', async () => {
    await mountScene()

    expect(listUnclassifiedMeetingsMock).toHaveBeenCalledWith(
      expect.objectContaining({
        sort: UNCLASSIFIED_SORT,
        page: 1,
        pageSize: 10,
      }),
    )
  })

  it('renders newer meetings before older ones from the sorted response', async () => {
    await mountScene()

    const rows = Array.from(container.querySelectorAll('tbody tr'))
    expect(rows.length).toBe(2)
    expect(rows[0]?.textContent).toContain('Buổi mới hơn')
    expect(rows[1]?.textContent).toContain('Buổi cũ hơn')
  })

  it('keeps contract sort when searching', async () => {
    vi.useFakeTimers()
    await mountScene()

    const searchInput = container.querySelector('[data-testid="unclassified-search"]') as HTMLInputElement
    await act(async () => {
      setNativeValue(searchInput, 'giải tích')
      searchInput.dispatchEvent(new Event('input', { bubbles: true }))
      await vi.advanceTimersByTimeAsync(300)
    })
    await flush()

    const lastCall = listUnclassifiedMeetingsMock.mock.calls.at(-1)?.[0]
    expect(lastCall).toEqual(
      expect.objectContaining({
        search: 'giải tích',
        sort: UNCLASSIFIED_SORT,
        page: 1,
      }),
    )
  })

  it('keeps contract sort when changing page', async () => {
    listUnclassifiedMeetingsMock.mockResolvedValue(
      makePage(
        [makeMeeting(2, 'Buổi mới hơn', '2026-07-17T10:00:00Z')],
        { total: 25, page: 1, pageSize: 10 },
      ),
    )
    await mountScene()

    const nextButton = Array.from(container.querySelectorAll('button'))
      .find((button) => button.textContent?.trim() === 'Trang sau') as HTMLButtonElement | undefined
    expect(nextButton).toBeTruthy()

    await act(async () => {
      nextButton?.click()
    })
    await flush()

    const lastCall = listUnclassifiedMeetingsMock.mock.calls.at(-1)?.[0]
    expect(lastCall).toEqual(
      expect.objectContaining({
        sort: UNCLASSIFIED_SORT,
        page: 2,
        pageSize: 10,
      }),
    )
  })

  it('keeps contract sort when reloading after subject assignment', async () => {
    await mountScene()
    const callsBeforeAssign = listUnclassifiedMeetingsMock.mock.calls.length

    const picker = container.querySelector('#unclassified-picker-2') as HTMLSelectElement
    expect(picker).toBeTruthy()

    await act(async () => {
      setNativeValue(picker, '11')
      picker.dispatchEvent(new Event('change', { bubbles: true }))
    })
    await flush()

    expect(assignMeetingToSubjectMock).toHaveBeenCalledWith(2, 11)
    expect(listUnclassifiedMeetingsMock.mock.calls.length).toBeGreaterThan(callsBeforeAssign)
    const lastCall = listUnclassifiedMeetingsMock.mock.calls.at(-1)?.[0]
    expect(lastCall).toEqual(
      expect.objectContaining({
        sort: UNCLASSIFIED_SORT,
      }),
    )
  })
})
