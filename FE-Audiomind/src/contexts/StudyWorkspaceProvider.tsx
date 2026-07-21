import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react'
import {
  createStudyFolder,
  deleteStudyFolder,
  getStudyFolderTree,
  updateStudyFolder,
  type CreateStudyFolderInput,
  type UpdateStudyFolderInput,
} from '../services/studyFolders'
import {
  archiveSubject,
  assignMeetingSubject,
  createSubject,
  listSubjects,
  updateSubject,
  type CreateSubjectInput,
  type UpdateSubjectInput,
} from '../services/subjects'
import type { StudyFolderTreeResponse, Subject, SubjectSummary } from '../types/study'

/** Safety cap on catalog pages fetched, to avoid unbounded requests if the backend ever returns a huge count. */
const CATALOG_MAX_PAGES = 40
const CATALOG_PAGE_SIZE = 50

const toSubjectSummary = (subject: Subject): SubjectSummary => ({
  id: subject.id,
  name: subject.name,
  code: subject.code,
  semester: subject.semester,
  color: subject.color,
  folderId: subject.folderId,
  archivedAt: subject.archivedAt,
  meetingCount: subject.meetingCount,
})

/** Fetches every page of active subjects (up to a safety limit) so the catalog isn't capped at the first page. */
const fetchFullSubjectCatalog = async (): Promise<SubjectSummary[]> => {
  const seen = new Map<number, SubjectSummary>()
  let pageIndex = 1
  let totalPages = 1
  do {
    const page = await listSubjects({
      archived: false,
      page: pageIndex,
      pageSize: CATALOG_PAGE_SIZE,
      sort: 'name_asc',
    })
    for (const subject of page.items) {
      seen.set(subject.id, toSubjectSummary(subject))
    }
    totalPages = Math.max(1, page.totalPages)
    pageIndex += 1
  } while (pageIndex <= totalPages && pageIndex <= CATALOG_MAX_PAGES)

  return Array.from(seen.values()).sort((a, b) => a.name.localeCompare(b.name, 'vi'))
}

type StudyWorkspaceContextValue = {
  folderTree: StudyFolderTreeResponse | null
  catalogSubjects: SubjectSummary[]
  treeRevision: number
  catalogRevision: number
  treeLoading: boolean
  catalogLoading: boolean
  treeError: string | null
  catalogError: string | null
  refreshFolderTree: () => Promise<void>
  refreshCatalog: () => Promise<void>
  invalidateAfterFolderMutation: () => Promise<void>
  invalidateAfterSubjectMutation: () => Promise<void>
  invalidateAfterMeetingSubjectMutation: () => Promise<void>
  createFolder: (input: CreateStudyFolderInput) => Promise<void>
  updateFolder: (folderId: number, input: UpdateStudyFolderInput) => Promise<void>
  removeFolder: (folderId: number) => Promise<void>
  createSubjectEntry: (input: CreateSubjectInput) => Promise<void>
  updateSubjectEntry: (subjectId: number, input: UpdateSubjectInput) => Promise<void>
  archiveSubjectEntry: (subjectId: number) => Promise<void>
  assignMeetingToSubject: (meetingId: number, subjectId: number | null) => Promise<void>
}

const StudyWorkspaceContext = createContext<StudyWorkspaceContextValue | null>(null)

export function StudyWorkspaceProvider({ children }: { children: ReactNode }) {
  const [folderTree, setFolderTree] = useState<StudyFolderTreeResponse | null>(null)
  const [catalogSubjects, setCatalogSubjects] = useState<SubjectSummary[]>([])
  const [treeRevision, setTreeRevision] = useState(0)
  const [catalogRevision, setCatalogRevision] = useState(0)
  const [treeLoading, setTreeLoading] = useState(false)
  const [catalogLoading, setCatalogLoading] = useState(false)
  const [treeError, setTreeError] = useState<string | null>(null)
  const [catalogError, setCatalogError] = useState<string | null>(null)

  const refreshFolderTree = useCallback(async () => {
    setTreeLoading(true)
    setTreeError(null)
    try {
      const tree = await getStudyFolderTree()
      setFolderTree(tree)
      setTreeRevision((value) => value + 1)
    } catch (error) {
      setTreeError(error instanceof Error ? error.message : 'Không tải được cây thư mục')
    } finally {
      setTreeLoading(false)
    }
  }, [])

  const refreshCatalog = useCallback(async () => {
    setCatalogLoading(true)
    setCatalogError(null)
    try {
      const subjects = await fetchFullSubjectCatalog()
      setCatalogSubjects(subjects)
      setCatalogRevision((value) => value + 1)
    } catch (error) {
      setCatalogError(error instanceof Error ? error.message : 'Không tải được danh sách môn học')
    } finally {
      setCatalogLoading(false)
    }
  }, [])

  useEffect(() => {
    void refreshFolderTree()
    void refreshCatalog()
  }, [refreshCatalog, refreshFolderTree])

  const invalidateAfterFolderMutation = useCallback(async () => {
    await Promise.all([refreshFolderTree(), refreshCatalog()])
  }, [refreshCatalog, refreshFolderTree])

  const invalidateAfterSubjectMutation = useCallback(async () => {
    await Promise.all([refreshFolderTree(), refreshCatalog()])
  }, [refreshCatalog, refreshFolderTree])

  const invalidateAfterMeetingSubjectMutation = useCallback(async () => {
    await Promise.all([refreshFolderTree(), refreshCatalog()])
  }, [refreshCatalog, refreshFolderTree])

  const createFolder = useCallback(async (input: CreateStudyFolderInput) => {
    await createStudyFolder(input)
    await invalidateAfterFolderMutation()
  }, [invalidateAfterFolderMutation])

  const updateFolder = useCallback(async (folderId: number, input: UpdateStudyFolderInput) => {
    await updateStudyFolder(folderId, input)
    await invalidateAfterFolderMutation()
  }, [invalidateAfterFolderMutation])

  const removeFolder = useCallback(async (folderId: number) => {
    await deleteStudyFolder(folderId)
    await invalidateAfterFolderMutation()
  }, [invalidateAfterFolderMutation])

  const createSubjectEntry = useCallback(async (input: CreateSubjectInput) => {
    await createSubject(input)
    await invalidateAfterSubjectMutation()
  }, [invalidateAfterSubjectMutation])

  const updateSubjectEntry = useCallback(async (subjectId: number, input: UpdateSubjectInput) => {
    await updateSubject(subjectId, input)
    await invalidateAfterSubjectMutation()
  }, [invalidateAfterSubjectMutation])

  const archiveSubjectEntry = useCallback(async (subjectId: number) => {
    await archiveSubject(subjectId)
    await invalidateAfterSubjectMutation()
  }, [invalidateAfterSubjectMutation])

  const assignMeetingToSubject = useCallback(async (meetingId: number, subjectId: number | null) => {
    await assignMeetingSubject(meetingId, subjectId)
    await invalidateAfterMeetingSubjectMutation()
  }, [invalidateAfterMeetingSubjectMutation])

  const value = useMemo<StudyWorkspaceContextValue>(() => ({
    folderTree,
    catalogSubjects,
    treeRevision,
    catalogRevision,
    treeLoading,
    catalogLoading,
    treeError,
    catalogError,
    refreshFolderTree,
    refreshCatalog,
    invalidateAfterFolderMutation,
    invalidateAfterSubjectMutation,
    invalidateAfterMeetingSubjectMutation,
    createFolder,
    updateFolder,
    removeFolder,
    createSubjectEntry,
    updateSubjectEntry,
    archiveSubjectEntry,
    assignMeetingToSubject,
  }), [
    archiveSubjectEntry,
    assignMeetingToSubject,
    catalogError,
    catalogLoading,
    catalogRevision,
    catalogSubjects,
    createFolder,
    createSubjectEntry,
    folderTree,
    invalidateAfterFolderMutation,
    invalidateAfterMeetingSubjectMutation,
    invalidateAfterSubjectMutation,
    refreshCatalog,
    refreshFolderTree,
    removeFolder,
    treeError,
    treeLoading,
    treeRevision,
    updateFolder,
    updateSubjectEntry,
  ])

  return (
    <StudyWorkspaceContext.Provider value={value}>
      {children}
    </StudyWorkspaceContext.Provider>
  )
}

export const useStudyWorkspaceContext = (): StudyWorkspaceContextValue => {
  const context = useContext(StudyWorkspaceContext)
  if (!context) {
    throw new Error('useStudyWorkspaceContext must be used within StudyWorkspaceProvider')
  }
  return context
}
