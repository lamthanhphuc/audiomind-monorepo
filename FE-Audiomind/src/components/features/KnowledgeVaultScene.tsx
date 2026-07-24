import { useCallback, useEffect, useMemo, useState } from 'react'
import { BookOpenText, RefreshCw, Search } from 'lucide-react'

import {
  createKnowledgeNote,
  deleteKnowledgeNote,
  listKnowledgeNotes,
} from '../../services/knowledgeLayer'
import { listLocalGlossaryNotes, notifyGlossaryNotesChanged, saveGlossaryNotes, GLOSSARY_NOTE_TITLE, GLOSSARY_NOTE_TYPE } from '../../utils/glossaryNotes'
import {
  formatVaultTimestamp,
  groupVaultNotesByMeeting,
  isLocalVaultNoteId,
  mergeVaultNotes,
  syncPendingLocalGlossaryNotes,
  type VaultNote,
} from '../../utils/knowledgeVaultNotes'

type Props = {
  onOpenMeeting?: (meetingId: number) => void
}

const groupKeyFor = (meetingId: number | null): string => (
  meetingId != null ? String(meetingId) : 'general'
)

export default function KnowledgeVaultScene({ onOpenMeeting }: Props) {
  const [query, setQuery] = useState('')
  const [debouncedQuery, setDebouncedQuery] = useState('')
  const [items, setItems] = useState<VaultNote[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [info, setInfo] = useState<string | null>(null)
  const [refreshToken, setRefreshToken] = useState(0)
  const [collapsedGroups, setCollapsedGroups] = useState<Record<string, boolean>>({})

  const groups = useMemo(() => groupVaultNotesByMeeting(items), [items])
  const localOnlyCount = useMemo(() => items.filter((item) => item.localOnly).length, [items])

  useEffect(() => {
    const timer = window.setTimeout(() => setDebouncedQuery(query.trim()), 250)
    return () => window.clearTimeout(timer)
  }, [query])

  const reload = useCallback(async () => {
    setLoading(true)
    setError(null)
    setInfo(null)

    try {
      const serverNotes = await listKnowledgeNotes()
      const { synced } = await syncPendingLocalGlossaryNotes(serverNotes)
      if (synced.length > 0) {
        setInfo(`Đã đồng bộ ${synced.length} ghi chú cục bộ lên server.`)
      }

      const refreshedServerNotes = synced.length > 0
        ? await listKnowledgeNotes()
        : serverNotes
      const merged = mergeVaultNotes(
        refreshedServerNotes,
        listLocalGlossaryNotes(),
        debouncedQuery,
      )
      setItems(merged)
    } catch (loadError) {
      const merged = mergeVaultNotes([], listLocalGlossaryNotes(), debouncedQuery)
      setItems(merged)
      if (merged.length > 0) {
        setError(loadError instanceof Error ? loadError.message : 'Không tải được từ server')
        setInfo('Đang hiển thị ghi chú cục bộ chưa đồng bộ.')
      } else {
        setError(loadError instanceof Error ? loadError.message : 'Không tải được Knowledge Vault')
      }
    } finally {
      setLoading(false)
    }
  }, [debouncedQuery])

  useEffect(() => {
    void reload()
  }, [reload, refreshToken])

  useEffect(() => {
    const handleNotesChanged = () => {
      setRefreshToken((value) => value + 1)
    }
    window.addEventListener('audiomind:glossary-notes-changed', handleNotesChanged)
    return () => {
      window.removeEventListener('audiomind:glossary-notes-changed', handleNotesChanged)
    }
  }, [])

  const toggleGroup = (meetingId: number | null) => {
    const key = groupKeyFor(meetingId)
    setCollapsedGroups((current) => ({
      ...current,
      [key]: !current[key],
    }))
  }

  const handleDelete = async (item: VaultNote) => {
    try {
      if (item.localOnly && item.meetingId != null) {
        saveGlossaryNotes(item.meetingId, '')
        setItems((current) => current.filter((note) => note.id !== item.id))
        notifyGlossaryNotesChanged()
        return
      }

      await deleteKnowledgeNote(item.id)
      if (item.meetingId != null) {
        saveGlossaryNotes(item.meetingId, '')
      }
      setItems((current) => current.filter((note) => note.id !== item.id))
      notifyGlossaryNotesChanged()
    } catch (deleteError) {
      setError(deleteError instanceof Error ? deleteError.message : 'Không xóa được ghi chú')
    }
  }

  const handleSyncLocal = async (item: VaultNote) => {
    if (!item.localOnly || item.meetingId == null) {
      return
    }

    setLoading(true)
    setError(null)
    try {
      const created = await createKnowledgeNote({
        meetingId: item.meetingId,
        noteType: GLOSSARY_NOTE_TYPE,
        title: GLOSSARY_NOTE_TITLE,
        body: item.body,
      })
      saveGlossaryNotes(item.meetingId, '')
      setItems((current) => current.map((note) => (
        note.id === item.id ? { ...created, localOnly: false } : note
      )))
      setInfo('Đã đồng bộ ghi chú lên server.')
      notifyGlossaryNotesChanged()
    } catch (syncError) {
      setError(syncError instanceof Error ? syncError.message : 'Không đồng bộ được ghi chú')
    } finally {
      setLoading(false)
    }
  }

  return (
    <section className="feature-scene knowledge-vault-scene" data-testid="knowledge-vault-scene">
      <header className="knowledge-vault-scene__hero">
        <div className="knowledge-vault-scene__hero-copy">
          <span className="knowledge-vault-scene__icon" aria-hidden="true">
            <BookOpenText size={20} />
          </span>
          <div>
            <h1>Kho tri thức</h1>
            <p className="knowledge-vault-scene__subtitle">
              Tìm lại ghi chú, thuật ngữ và giải thích đã lưu từ mọi cuộc họp.
            </p>
          </div>
        </div>
        <button
          type="button"
          className="btn btn--secondary knowledge-vault-scene__refresh"
          onClick={() => setRefreshToken((value) => value + 1)}
          disabled={loading}
          data-testid="knowledge-vault-refresh"
        >
          <RefreshCw size={16} aria-hidden="true" />
          {loading ? 'Đang tải' : 'Làm mới'}
        </button>
      </header>

      <div className="knowledge-vault-scene__toolbar">
        <label className="knowledge-vault-scene__search">
          <Search size={17} aria-hidden="true" />
          <span className="sr-only">Tìm trong Kho tri thức</span>
          <input
            type="search"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Tìm theo thuật ngữ, nội dung hoặc meeting…"
            data-testid="knowledge-vault-search"
          />
        </label>
        <div className="knowledge-vault-scene__stats" aria-label="Thống kê kho tri thức">
          <span><strong>{items.length}</strong> ghi chú</span>
          <span><strong>{groups.length}</strong> nhóm</span>
          <span><strong>{localOnlyCount}</strong> chờ đồng bộ</span>
        </div>
      </div>

      {loading && <p className="knowledge-vault-scene__status knowledge-vault-scene__loading">Đang tải…</p>}
      {error && <p className="knowledge-vault-scene__status knowledge-vault-scene__error" role="alert">{error}</p>}
      {info && !loading && <p className="knowledge-vault-scene__status knowledge-vault-scene__info">{info}</p>}

      {!loading && items.length === 0 && !error && (
        <div className="knowledge-vault-scene__empty">
          <strong>Chưa có ghi chú nào</strong>
          <p>Hãy lưu thuật ngữ hoặc ghi chú từ tab “Ghi chú & thuật ngữ” trong màn phân tích.</p>
        </div>
      )}

      <ul className="knowledge-vault-scene__list">
        {groups.map((group) => {
          const groupKey = groupKeyFor(group.meetingId)
          const collapsed = Boolean(collapsedGroups[groupKey])

          return (
            <li
              key={groupKey}
              className={`knowledge-vault-scene__group${collapsed ? ' knowledge-vault-scene__group--collapsed' : ''}`}
              data-testid={group.meetingId != null ? `knowledge-vault-group-${group.meetingId}` : 'knowledge-vault-group-general'}
            >
              <header className="knowledge-vault-scene__group-header">
                <div className="knowledge-vault-scene__group-heading">
                  <button
                    type="button"
                    className="knowledge-vault-scene__group-toggle"
                    aria-expanded={!collapsed}
                    onClick={() => toggleGroup(group.meetingId)}
                    data-testid={`knowledge-vault-toggle-${groupKey}`}
                  >
                    {collapsed ? '▸' : '▾'}
                  </button>
                  <div>
                    <h2 className="knowledge-vault-scene__group-title">
                      {group.meetingId != null ? `Mã hỗ trợ #${String(group.meetingId).slice(-6)}` : 'Ghi chú chung'}
                    </h2>
                    <p className="knowledge-vault-scene__group-meta">
                      {group.notes.length} ghi chú
                    </p>
                  </div>
                </div>
                <div className="knowledge-vault-scene__group-actions">
                  <button
                    type="button"
                    className="btn btn--secondary"
                    onClick={() => toggleGroup(group.meetingId)}
                    data-testid={`knowledge-vault-collapse-${groupKey}`}
                  >
                    {collapsed ? 'Mở rộng' : 'Thu gọn'}
                  </button>
                  {group.meetingId != null && onOpenMeeting && (
                    <button
                      type="button"
                      className="btn btn--secondary"
                      onClick={() => onOpenMeeting(group.meetingId as number)}
                      data-testid={`knowledge-vault-open-meeting-${group.meetingId}`}
                    >
                      Mở cuộc họp
                    </button>
                  )}
                </div>
              </header>

              {!collapsed && (
                <ul className="knowledge-vault-scene__group-notes">
                  {group.notes.map((item) => {
                    const updatedLabel = formatVaultTimestamp(item.updatedAt ?? undefined)
                    return (
                      <li
                        key={isLocalVaultNoteId(item.id) ? `local-${item.meetingId}` : item.id}
                        className="knowledge-vault-scene__card"
                        data-testid={item.localOnly ? `knowledge-vault-local-${item.meetingId}` : `knowledge-vault-note-${item.id}`}
                      >
                        <div className="knowledge-vault-scene__card-header">
                          <div className="knowledge-vault-scene__card-title-row">
                            <strong>{item.term?.trim() || item.title?.trim() || 'Ghi chú chung'}</strong>
                            {item.noteType && <span className="meta-pill">{item.noteType}</span>}
                            {item.localOnly && <span className="meta-pill">Chưa đồng bộ</span>}
                          </div>
                          <div className="knowledge-vault-scene__card-actions">
                            {item.localOnly && (
                              <button
                                type="button"
                                className="btn btn--primary"
                                onClick={() => void handleSyncLocal(item)}
                                data-testid={`knowledge-vault-sync-${item.meetingId}`}
                              >
                                Đồng bộ
                              </button>
                            )}
                            <button
                              type="button"
                              className="btn btn--secondary"
                              onClick={() => void handleDelete(item)}
                              data-testid={`knowledge-vault-delete-${item.localOnly ? `local-${item.meetingId}` : item.id}`}
                            >
                              Xóa
                            </button>
                          </div>
                        </div>
                        <p className="knowledge-vault-scene__card-body">{item.body}</p>
                        {updatedLabel && (
                          <p className="knowledge-vault-scene__meta">{updatedLabel}</p>
                        )}
                      </li>
                    )
                  })}
                </ul>
              )}
            </li>
          )
        })}
      </ul>
    </section>
  )
}
