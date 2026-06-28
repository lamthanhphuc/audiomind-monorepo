import { useEffect, useState } from 'react'
import type { AiAnalysis } from '../../types'
import {
  createKnowledgeNote,
  deleteKnowledgeNote,
  listKnowledgeNotes,
  updateKnowledgeNote,
  type KnowledgeNote,
} from '../../services/knowledgeLayer'
import { ApiError } from '../../services/api'
import {
  GLOSSARY_NOTE_TYPE,
  getGlossaryNotes,
  notifyGlossaryNotesChanged,
  saveGlossaryNotes,
} from '../../utils/glossaryNotes'

type Props = {
  meetingId?: number | null
  analysis?: AiAnalysis | null
  onTermSelect?: (term: string) => void
}

const TERM_PREVIEW_LIMIT = 10

const findGlossaryNote = (notes: KnowledgeNote[]): KnowledgeNote | null => {
  const glossaryNote = notes.find((note) => note.noteType === GLOSSARY_NOTE_TYPE)
  if (glossaryNote) {
    return glossaryNote
  }
  return notes.find((note) => !note.term?.trim()) ?? null
}

const getSaveErrorMessage = (error: unknown): string => {
  if (error instanceof ApiError && (error.status === 401 || error.status === 403)) {
    return 'Cần đăng nhập lại'
  }
  if (error instanceof Error) {
    return error.message
  }
  return 'Không lưu được ghi chú lên server'
}

export default function GlossaryNotesPanel({ meetingId, analysis, onTermSelect }: Props) {
  const [notes, setNotes] = useState('')
  const [glossaryNoteId, setGlossaryNoteId] = useState<number | null>(null)
  const [savedHint, setSavedHint] = useState('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [showAllTerms, setShowAllTerms] = useState(false)

  const terms = analysis?.technicalTerms?.filter((term) => term.term?.trim()) ?? []
  const visibleTerms = showAllTerms ? terms : terms.slice(0, TERM_PREVIEW_LIMIT)

  useEffect(() => {
    let cancelled = false

    const loadNotes = async () => {
      if (!meetingId) {
        setNotes('')
        setGlossaryNoteId(null)
        return
      }

      setLoading(true)
      setError(null)
      setSavedHint('')
      setShowAllTerms(false)

      try {
        const serverNotes = await listKnowledgeNotes({ meetingId })
        if (cancelled) {
          return
        }
        const glossaryNote = findGlossaryNote(serverNotes)
        if (glossaryNote) {
          setNotes(glossaryNote.body)
          setGlossaryNoteId(glossaryNote.id)
          return
        }

        const localNotes = getGlossaryNotes(meetingId)
        setNotes(localNotes)
        setGlossaryNoteId(null)
      } catch (loadError) {
        if (!cancelled) {
          setNotes(getGlossaryNotes(meetingId))
          setGlossaryNoteId(null)
          setError(loadError instanceof Error ? loadError.message : 'Không tải được ghi chú từ server')
        }
      } finally {
        if (!cancelled) {
          setLoading(false)
        }
      }
    }

    void loadNotes()
    return () => {
      cancelled = true
    }
  }, [meetingId])

  const handleSave = async () => {
    if (!meetingId || loading) {
      return
    }

    const trimmed = notes.trim()
    setError(null)
    setSavedHint('')

    if (!trimmed && glossaryNoteId == null) {
      setError('Nhập nội dung trước khi lưu')
      return
    }

    setLoading(true)

    try {
      if (!trimmed && glossaryNoteId != null) {
        await deleteKnowledgeNote(glossaryNoteId)
        saveGlossaryNotes(meetingId, '')
        notifyGlossaryNotesChanged()
        setGlossaryNoteId(null)
        setNotes('')
        setSavedHint('Đã xóa ghi chú và đồng bộ lên server')
        window.setTimeout(() => setSavedHint(''), 2500)
        return
      }

      if (glossaryNoteId != null) {
        await updateKnowledgeNote(glossaryNoteId, { body: trimmed, noteType: GLOSSARY_NOTE_TYPE })
      } else if (trimmed) {
        const created = await createKnowledgeNote({
          meetingId,
          noteType: GLOSSARY_NOTE_TYPE,
          title: 'Ghi chú thuật ngữ',
          body: trimmed,
        })
        setGlossaryNoteId(created.id)
      }

      saveGlossaryNotes(meetingId, trimmed)
      notifyGlossaryNotesChanged()
      setSavedHint('Đã đồng bộ lên server')
      window.setTimeout(() => setSavedHint(''), 2500)
    } catch (saveError) {
      if (trimmed) {
        saveGlossaryNotes(meetingId, notes)
        notifyGlossaryNotesChanged()
      }
      const message = getSaveErrorMessage(saveError)
      if (saveError instanceof ApiError && (saveError.status === 401 || saveError.status === 403)) {
        setError(message)
      } else if (trimmed) {
        setSavedHint('Đã lưu cục bộ — chưa đồng bộ server')
        setError(message)
        window.setTimeout(() => setSavedHint(''), 2500)
      } else {
        setError(message)
      }
    } finally {
      setLoading(false)
    }
  }

  if (!meetingId) {
    return null
  }

  return (
    <section className="glossary-notes-panel" data-testid="glossary-notes-panel">
      <header className="glossary-notes-panel__header">
        <div>
          <h3>Thuật ngữ & ghi chú</h3>
          <p className="glossary-notes-panel__subtitle">
            Đồng bộ server theo cuộc họp. Click thuật ngữ trong transcript để giải thích.
          </p>
        </div>
        <button
          type="button"
          className="secondary-cta"
          onClick={() => void handleSave()}
          disabled={loading}
          data-testid="glossary-notes-save"
        >
          Lưu ghi chú
        </button>
      </header>

      {loading && <p className="glossary-notes-panel__hint">Đang tải ghi chú…</p>}
      {error && <p className="glossary-notes-panel__error" role="alert">{error}</p>}

      {terms.length > 0 ? (
        <>
          <ul className="glossary-notes-panel__terms">
            {visibleTerms.map((term) => (
              <li key={term.term}>
                <button
                  type="button"
                  className="glossary-notes-panel__term-button"
                  onClick={() => onTermSelect?.(term.term)}
                  data-testid={`glossary-term-${term.term}`}
                >
                  <strong>{term.term}</strong>
                  {term.meaning?.trim() ? <span>{term.meaning.trim()}</span> : null}
                </button>
              </li>
            ))}
          </ul>
          {terms.length > TERM_PREVIEW_LIMIT && (
            <button
              type="button"
              className="glossary-notes-panel__toggle"
              onClick={() => setShowAllTerms((value) => !value)}
            >
              {showAllTerms ? 'Thu gọn' : `Xem thêm ${terms.length - TERM_PREVIEW_LIMIT} thuật ngữ`}
            </button>
          )}
        </>
      ) : (
        <p className="glossary-notes-panel__empty">Chưa có thuật ngữ từ phân tích. Hãy chạy phân tích AI trước.</p>
      )}

      <textarea
        className="glossary-notes-panel__editor"
        value={notes}
        onChange={(event) => setNotes(event.target.value)}
        placeholder="Thêm định nghĩa riêng, viết tắt, hoặc ngữ cảnh dự án cho thuật ngữ trong cuộc họp..."
        rows={4}
        data-testid="glossary-notes-input"
      />
      {savedHint && <p className="glossary-notes-panel__hint">{savedHint}</p>}
    </section>
  )
}
