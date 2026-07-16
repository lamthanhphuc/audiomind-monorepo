import { useMemo, useState } from 'react'
import { BookOpen, FolderPlus, GraduationCap, Inbox, Plus } from 'lucide-react'
import type { DashboardScene } from '../dashboard/DashboardLayout'
import { useStudyWorkspace } from '../../hooks/useStudyWorkspace'
import type { StudyFolder, StudyFolderTreeNode, SubjectSummary } from '../../types'
import { FolderDialog } from './FolderDialog'
import { SubjectDialog } from './SubjectDialog'
import './subjects.css'

export type SubjectSidebarSectionProps = {
  activeScene: DashboardScene | string
  selectedSubjectId: number | null
  onNavigateSubjects: () => void
  onNavigateSubjectDetail: (subjectId: number) => void
  onNavigateUnclassified: () => void
}

const flattenFolders = (nodes: StudyFolderTreeNode[]): StudyFolder[] => {
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

function SubjectNavButton({
  label,
  active,
  onClick,
  color,
  icon,
  testId,
}: {
  label: string
  active: boolean
  onClick: () => void
  color?: string | null
  icon?: 'subject' | 'inbox' | 'list'
  testId?: string
}) {
  const Icon = icon === 'inbox' ? Inbox : icon === 'list' ? BookOpen : GraduationCap
  return (
    <button
      type="button"
      className={`subject-sidebar__link${active ? ' subject-sidebar__link--active' : ''}`}
      onClick={onClick}
      data-testid={testId}
      aria-current={active ? 'page' : undefined}
    >
      {color ? (
        <span className="subject-sidebar__folder-dot" style={{ background: color }} aria-hidden />
      ) : (
        <Icon size={14} aria-hidden />
      )}
      <span>{label}</span>
    </button>
  )
}

function FolderTreeNodeView({
  node,
  selectedSubjectId,
  onNavigateSubjectDetail,
}: {
  node: StudyFolderTreeNode
  selectedSubjectId: number | null
  onNavigateSubjectDetail: (subjectId: number) => void
}) {
  return (
    <li className="subject-sidebar__folder">
      <div className="subject-sidebar__folder-label">
        <span
          className="subject-sidebar__folder-dot"
          style={{ background: node.color || '#6366f1' }}
          aria-hidden
        />
        <span>{node.name}</span>
      </div>
      <ul className="subject-sidebar__children">
        {node.subjects.map((subject) => (
          <li key={subject.id}>
            <SubjectNavButton
              label={subject.name}
              color={subject.color}
              active={selectedSubjectId === subject.id}
              onClick={() => onNavigateSubjectDetail(subject.id)}
              testId={`subject-sidebar-subject-${subject.id}`}
            />
          </li>
        ))}
        {node.children.map((child) => (
          <FolderTreeNodeView
            key={child.id}
            node={child}
            selectedSubjectId={selectedSubjectId}
            onNavigateSubjectDetail={onNavigateSubjectDetail}
          />
        ))}
      </ul>
    </li>
  )
}

export function SubjectSidebarSection({
  activeScene,
  selectedSubjectId,
  onNavigateSubjects,
  onNavigateSubjectDetail,
  onNavigateUnclassified,
}: SubjectSidebarSectionProps) {
  const {
    folderTree,
    treeLoading,
    treeError,
    createFolder,
    createSubjectEntry,
  } = useStudyWorkspace()

  const [folderDialogOpen, setFolderDialogOpen] = useState(false)
  const [subjectDialogOpen, setSubjectDialogOpen] = useState(false)

  const flatFolders = useMemo(
    () => flattenFolders(folderTree?.folders ?? []),
    [folderTree],
  )

  const rootSubjects: SubjectSummary[] = folderTree?.rootSubjects ?? []

  return (
    <div className="dashboard-sidebar__section subject-sidebar" data-testid="subject-sidebar-section">
      <div className="subject-sidebar__header">
        <div className="dashboard-sidebar__title">Học tập</div>
        <div className="subject-sidebar__actions">
          <button
            type="button"
            className="btn btn--secondary btn--compact"
            title="Thư mục mới"
            aria-label="Thư mục mới"
            onClick={() => setFolderDialogOpen(true)}
            data-testid="subject-sidebar-new-folder"
          >
            <FolderPlus size={14} aria-hidden />
          </button>
          <button
            type="button"
            className="btn btn--secondary btn--compact"
            title="Môn mới"
            aria-label="Môn mới"
            onClick={() => setSubjectDialogOpen(true)}
            data-testid="subject-sidebar-new-subject"
          >
            <Plus size={14} aria-hidden />
          </button>
        </div>
      </div>

      <ul className="subject-sidebar__tree">
        <li>
          <SubjectNavButton
            label="Tất cả môn học"
            icon="list"
            active={activeScene === 'subjects' && selectedSubjectId == null}
            onClick={onNavigateSubjects}
            testId="subject-sidebar-all-subjects"
          />
        </li>
        <li>
          <SubjectNavButton
            label="Chưa phân loại"
            icon="inbox"
            active={activeScene === 'unclassified'}
            onClick={onNavigateUnclassified}
            testId="subject-sidebar-unclassified"
          />
        </li>
      </ul>

      {treeLoading ? (
        <p className="subject-sidebar__empty">Đang tải thư mục…</p>
      ) : treeError ? (
        <p className="subject-sidebar__empty">{treeError}</p>
      ) : (
        <>
          {(folderTree?.folders.length ?? 0) === 0 && rootSubjects.length === 0 ? (
            <p className="subject-sidebar__empty">Chưa có thư mục hoặc môn học</p>
          ) : null}

          <ul className="subject-sidebar__tree">
            {(folderTree?.folders ?? []).map((node) => (
              <FolderTreeNodeView
                key={node.id}
                node={node}
                selectedSubjectId={selectedSubjectId}
                onNavigateSubjectDetail={onNavigateSubjectDetail}
              />
            ))}
          </ul>

          {rootSubjects.length > 0 ? (
            <ul className="subject-sidebar__tree">
              {rootSubjects.map((subject) => (
                <li key={subject.id}>
                  <SubjectNavButton
                    label={subject.name}
                    color={subject.color}
                    active={selectedSubjectId === subject.id}
                    onClick={() => onNavigateSubjectDetail(subject.id)}
                    testId={`subject-sidebar-subject-${subject.id}`}
                  />
                </li>
              ))}
            </ul>
          ) : null}
        </>
      )}

      <FolderDialog
        open={folderDialogOpen}
        mode="create"
        folders={flatFolders}
        onClose={() => setFolderDialogOpen(false)}
        onSubmit={async (payload) => {
          await createFolder(payload)
        }}
      />

      <SubjectDialog
        open={subjectDialogOpen}
        mode="create"
        folders={flatFolders}
        onClose={() => setSubjectDialogOpen(false)}
        onSubmit={async (payload) => {
          await createSubjectEntry(payload)
        }}
      />
    </div>
  )
}

export default SubjectSidebarSection
