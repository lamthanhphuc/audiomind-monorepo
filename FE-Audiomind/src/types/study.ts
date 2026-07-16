export type StudyFolder = {
  id: number
  ownerUserId?: number
  parentFolderId?: number | null
  name: string
  color?: string | null
  createdAt?: string
  updatedAt?: string
  deletedAt?: string | null
  subjectCount?: number
}

export type SubjectSummary = {
  id: number
  name: string
  code?: string | null
  semester?: string | null
  color?: string | null
  folderId?: number | null
  archivedAt?: string | null
  meetingCount?: number
}

export type StudyFolderTreeNode = {
  id: number
  name: string
  color?: string | null
  parentFolderId?: number | null
  children: StudyFolderTreeNode[]
  subjects: SubjectSummary[]
}

export type StudyFolderTreeResponse = {
  folders: StudyFolderTreeNode[]
  rootSubjects: SubjectSummary[]
}

export type Subject = {
  id: number
  ownerUserId?: number
  folderId?: number | null
  name: string
  code?: string | null
  semester?: string | null
  description?: string | null
  color?: string | null
  createdAt?: string
  updatedAt?: string
  archivedAt?: string | null
  meetingCount?: number
}

export type SubjectMeeting = {
  id: number
  title: string
  status: string
  language?: string | null
  createdAt?: string
  subjectId?: number | null
}

export type PageResponse<T> = {
  items: T[]
  total: number
  page: number
  pageSize: number
  totalPages: number
}

export type SubjectListFilters = {
  folderId?: number | null
  search?: string
  archived?: boolean
  page?: number
  pageSize?: number
  sort?: string
}

export type UnclassifiedFilters = {
  search?: string
  sort?: string
  page?: number
  pageSize?: number
}

/** Flattens a study folder tree into a plain list (depth-first), e.g. for dialog "parent folder" pickers. */
export const flattenStudyFolderTree = (nodes: StudyFolderTreeNode[]): StudyFolder[] => {
  const result: StudyFolder[] = []
  const walk = (items: StudyFolderTreeNode[]) => {
    for (const node of items) {
      result.push({
        id: node.id,
        name: node.name,
        color: node.color,
        parentFolderId: node.parentFolderId,
      })
      if (node.children?.length) {
        walk(node.children)
      }
    }
  }
  walk(nodes)
  return result
}
