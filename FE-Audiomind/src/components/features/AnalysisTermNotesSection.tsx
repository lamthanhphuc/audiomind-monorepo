import { useCallback, useEffect, useMemo, useState } from 'react'

import type { AiAnalysis, AnalysisTechnicalTerm } from '../../types'
import { ApiError } from '../../services/api'
import {
  createKnowledgeNote,
  deleteKnowledgeNote,
  listKnowledgeNotes,
  updateKnowledgeNote,
  type KnowledgeNote,
} from '../../services/knowledgeLayer'
import {
  GLOSSARY_NOTE_TITLE,
  GLOSSARY_NOTE_TYPE,
  getGlossaryNotes,
  notifyGlossaryNotesChanged,
  saveGlossaryNotes,
} from '../../utils/glossaryNotes'

type Props = {
  meetingId?: number | null
  analysis?: AiAnalysis | null
}

type TermDraft = {
  term: string
  meaning: string
  note: string
  serverNoteId: number | null
}

const TERM_NOTE_TYPE = 'term'

const findGlossaryNote = (notes: KnowledgeNote[]): KnowledgeNote | null => {
  const glossaryNote = notes.find((note) => note.noteType === GLOSSARY_NOTE_TYPE)
  if (glossaryNote) {
    return glossaryNote
  }
  return notes.find((note) => !note.term?.trim()) ?? null
}

const findTermNote = (notes: KnowledgeNote[], term: string): KnowledgeNote | null => {
  const normalized = term.trim().toLowerCase()
  return notes.find((note) => note.term?.trim().toLowerCase() === normalized) ?? null
}

const buildTermBody = (term: AnalysisTechnicalTerm, note: string): string => {
  const trimmedNote = note.trim()
  const meaning = term.meaning?.trim()
  if (trimmedNote) {
    return trimmedNote
  }
  if (meaning) {
    return meaning
  }
  return `Ghi chú cho thuật ngữ ${term.term}`
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

export default function AnalysisTermNotesSection({ meetingId, analysis }: Props) {
  const [generalNote, setGeneralNote] = useState('')
  const [generalNoteId, setGeneralNoteId] = useState<number | null>(null)
  const [termDrafts, setTermDrafts] = useState<TermDraft[]>([])
  const [loading, setLoading] = useState(false)
  const [savingTerm, setSavingTerm] = useState<string | null>(null)
  const [savingAll, setSavingAll] = useState(false)
  const [customTerm, setCustomTerm] = useState('')
  const [customTermNote, setCustomTermNote] = useState('')
  const [savingCustomTerm, setSavingCustomTerm] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [savedHint, setSavedHint] = useState('')

  const terms = useMemo(
    () => analysis?.technicalTerms?.filter((item) => item.term?.trim()) ?? [],
    [analysis?.technicalTerms],
  )

  const loadNotes = useCallback(async () => {
    if (!meetingId) {
      setGeneralNote('')
      setGeneralNoteId(null)
      setTermDrafts([])
      return
    }

    setLoading(true)
    setError(null)
    setSavedHint('')

    try {
      const serverNotes = await listKnowledgeNotes({ meetingId })
      const glossaryNote = findGlossaryNote(serverNotes)
      if (glossaryNote) {
        setGeneralNote(glossaryNote.body)
        setGeneralNoteId(glossaryNote.id)
      } else {
        setGeneralNote(getGlossaryNotes(meetingId))
        setGeneralNoteId(null)
      }

      setTermDrafts(terms.map((term) => {
        const existing = findTermNote(serverNotes, term.term)
        return {
          term: term.term,
          meaning: term.meaning?.trim() ?? '',
          note: existing?.body ?? '',
          serverNoteId: existing?.id ?? null,
        }
      }))
    } catch (loadError) {
      setGeneralNote(getGlossaryNotes(meetingId))
      setGeneralNoteId(null)
      setTermDrafts(terms.map((term) => ({
        term: term.term,
        meaning: term.meaning?.trim() ?? '',
        note: '',
        serverNoteId: null,
      })))
      setError(loadError instanceof Error ? loadError.message : 'Không tải được ghi chú')
    } finally {
      setLoading(false)
    }
  }, [meetingId, terms])

  useEffect(() => {
    void loadNotes()
  }, [loadNotes])

  const showSavedHint = (message: string) => {
    setSavedHint(message)
    window.setTimeout(() => setSavedHint(''), 2500)
  }

  const persistGeneralNote = async () => {
    if (!meetingId || loading) {
      return
    }

    const trimmed = generalNote.trim()
    setError(null)

    if (!trimmed && generalNoteId == null) {
      setError('Nhập nội dung trước khi lưu')
      return
    }

    setLoading(true)
    try {
      if (!trimmed && generalNoteId != null) {
        await deleteKnowledgeNote(generalNoteId)
        saveGlossaryNotes(meetingId, '')
        setGeneralNoteId(null)
        setGeneralNote('')
        notifyGlossaryNotesChanged()
        showSavedHint('Đã xóa ghi chú chung')
        return
      }

      if (generalNoteId != null) {
        await updateKnowledgeNote(generalNoteId, { body: trimmed, noteType: GLOSSARY_NOTE_TYPE })
      } else {
        const created = await createKnowledgeNote({
          meetingId,
          noteType: GLOSSARY_NOTE_TYPE,
          title: GLOSSARY_NOTE_TITLE,
          body: trimmed,
        })
        setGeneralNoteId(created.id)
      }

      saveGlossaryNotes(meetingId, trimmed)
      notifyGlossaryNotesChanged()
      showSavedHint('Đã lưu ghi chú chung')
    } catch (saveError) {
      if (trimmed) {
        saveGlossaryNotes(meetingId, generalNote)
        notifyGlossaryNotesChanged()
        showSavedHint('Đã lưu cục bộ — chưa đồng bộ server')
      }
      setError(getSaveErrorMessage(saveError))
    } finally {
      setLoading(false)
    }
  }

  const persistTermNote = async (termName: string) => {
    if (!meetingId) {
      return
    }

    const term = terms.find((item) => item.term === termName)
    const draft = termDrafts.find((item) => item.term === termName)
    if (!term || !draft) {
      return
    }

    const body = buildTermBody(term, draft.note)
    setSavingTerm(termName)
    setError(null)

    try {
      if (draft.serverNoteId != null) {
        await updateKnowledgeNote(draft.serverNoteId, { body, noteType: TERM_NOTE_TYPE, term: term.term, title: term.term })
      } else {
        const created = await createKnowledgeNote({
          meetingId,
          term: term.term,
          noteType: TERM_NOTE_TYPE,
          title: term.term,
          body,
        })
        setTermDrafts((current) => current.map((item) => (
          item.term === termName
            ? { ...item, serverNoteId: created.id, note: body }
            : item
        )))
        notifyGlossaryNotesChanged()
        showSavedHint(`Đã lưu thuật ngữ "${termName}"`)
        return
      }

      setTermDrafts((current) => current.map((item) => (
        item.term === termName ? { ...item, note: body } : item
      )))
      notifyGlossaryNotesChanged()
      showSavedHint(`Đã lưu thuật ngữ "${termName}"`)
    } catch (saveError) {
      setError(getSaveErrorMessage(saveError))
    } finally {
      setSavingTerm(null)
    }
  }

  const persistCustomTerm = async () => {
    if (!meetingId) {
      return
    }

    const term = customTerm.trim()
    const body = customTermNote.trim()
    setError(null)

    if (!term) {
      setError('Nhập thuật ngữ trước khi lưu')
      return
    }
    if (!body) {
      setError('Nhập định nghĩa hoặc ghi chú cho thuật ngữ')
      return
    }

    setSavingCustomTerm(true)
    try {
      const existingDraft = termDrafts.find((item) => item.term.trim().toLowerCase() === term.toLowerCase())
      if (existingDraft?.serverNoteId != null) {
        await updateKnowledgeNote(existingDraft.serverNoteId, {
          body,
          noteType: TERM_NOTE_TYPE,
          term,
          title: term,
        })
      } else {
        await createKnowledgeNote({
          meetingId,
          term,
          noteType: TERM_NOTE_TYPE,
          title: term,
          body,
        })
      }

      setTermDrafts((current) => {
        const existing = current.find((item) => item.term.trim().toLowerCase() === term.toLowerCase())
        if (existing) {
          return current.map((item) => (
            item.term.trim().toLowerCase() === term.toLowerCase()
              ? { ...item, note: body, meaning: item.meaning || body }
              : item
          ))
        }
        return [
          { term, meaning: body, note: body, serverNoteId: null },
          ...current,
        ]
      })
      setCustomTerm('')
      setCustomTermNote('')
      notifyGlossaryNotesChanged()
      showSavedHint(`Đã lưu thuật ngữ "${term}"`)
      void loadNotes()
    } catch (saveError) {
      setError(getSaveErrorMessage(saveError))
    } finally {
      setSavingCustomTerm(false)
    }
  }

  const persistAllTermNotes = async () => {
    if (!meetingId || terms.length === 0) {
      return
    }

    setSavingAll(true)
    setError(null)
    let savedCount = 0

    try {
      for (const term of terms) {
        const draft = termDrafts.find((item) => item.term === term.term)
        if (!draft) {
          continue
        }
        const body = buildTermBody(term, draft.note)
        if (draft.serverNoteId != null) {
          await updateKnowledgeNote(draft.serverNoteId, { body, noteType: TERM_NOTE_TYPE, term: term.term, title: term.term })
        } else {
          const created = await createKnowledgeNote({
            meetingId,
            term: term.term,
            noteType: TERM_NOTE_TYPE,
            title: term.term,
            body,
          })
          setTermDrafts((current) => current.map((item) => (
            item.term === term.term
              ? { ...item, serverNoteId: created.id, note: body }
              : item
          )))
        }
        savedCount += 1
      }
      notifyGlossaryNotesChanged()
      showSavedHint(`Đã lưu ${savedCount} thuật ngữ vào Kho tri thức`)
    } catch (saveError) {
      setError(getSaveErrorMessage(saveError))
    } finally {
      setSavingAll(false)
    }
  }

  if (!meetingId) {
    return null
  }

  return (
    <section className="analysis-term-notes" data-testid="analysis-term-notes">
      <header className="analysis-term-notes__header">
        <div>
          <h3>Ghi chú & thuật ngữ</h3>
          <p className="analysis-term-notes__subtitle">
            Lưu ghi chú chung hoặc từng thuật ngữ vào Kho tri thức.
          </p>
        </div>
      </header>

      {loading && <p className="analysis-term-notes__hint">Đang tải ghi chú…</p>}
      {error && <p className="analysis-term-notes__error" role="alert">{error}</p>}
      {savedHint && <p className="analysis-term-notes__hint">{savedHint}</p>}

      <div className="analysis-term-notes__general">
        <div className="analysis-term-notes__general-head">
          <h4>Ghi chú chung</h4>
          <button
            type="button"
            className="btn btn--secondary"
            onClick={() => void persistGeneralNote()}
            disabled={loading || savingAll}
            data-testid="analysis-general-note-save"
          >
            Lưu ghi chú
          </button>
        </div>
        <textarea
          className="analysis-term-notes__editor"
          value={generalNote}
          onChange={(event) => setGeneralNote(event.target.value)}
          placeholder="Ghi chú tổng hợp cho cuộc họp, viết tắt, ngữ cảnh dự án..."
          rows={3}
          data-testid="analysis-general-note-input"
        />
      </div>

      <div className="analysis-term-notes__custom">
        <div className="analysis-term-notes__custom-head">
          <h4>Tự thêm thuật ngữ</h4>
          <button
            type="button"
            className="btn btn--secondary"
            onClick={() => void persistCustomTerm()}
            disabled={loading || savingAll || savingCustomTerm || Boolean(savingTerm)}
            data-testid="analysis-custom-term-save"
          >
            {savingCustomTerm ? 'Đang lưu…' : 'Lưu thuật ngữ'}
          </button>
        </div>
        <div className="analysis-term-notes__custom-grid">
          <label>
            <span>Thuật ngữ</span>
            <input
              type="text"
              value={customTerm}
              onChange={(event) => setCustomTerm(event.target.value)}
              placeholder="Ví dụ: SLA, Backlog grooming..."
              data-testid="analysis-custom-term-input"
            />
          </label>
          <label>
            <span>Định nghĩa / ghi chú</span>
            <textarea
              className="analysis-term-notes__editor"
              value={customTermNote}
              onChange={(event) => setCustomTermNote(event.target.value)}
              placeholder="Ý nghĩa trong ngữ cảnh cuộc họp hoặc dự án này..."
              rows={2}
              data-testid="analysis-custom-term-note-input"
            />
          </label>
        </div>
      </div>

      {terms.length > 0 ? (
        <div className="analysis-term-notes__terms">
          <div className="analysis-term-notes__terms-head">
            <h4>Thuật ngữ ({terms.length})</h4>
            <button
              type="button"
              className="btn btn--primary"
              onClick={() => void persistAllTermNotes()}
              disabled={loading || savingAll || Boolean(savingTerm)}
              data-testid="analysis-term-notes-save-all"
            >
              {savingAll ? 'Đang lưu…' : 'Lưu tất cả'}
            </button>
          </div>
          <ul className="analysis-term-notes__list">
            {termDrafts.map((draft) => (
              <li key={draft.term} className="analysis-term-notes__item" data-testid={`analysis-term-note-${draft.term}`}>
                <div className="analysis-term-notes__item-head">
                  <strong>{draft.term}</strong>
                  {draft.meaning && <span className="analysis-term-notes__meaning">{draft.meaning}</span>}
                  {draft.serverNoteId != null && <span className="meta-pill">Đã lưu</span>}
                </div>
                <textarea
                  className="analysis-term-notes__editor"
                  value={draft.note}
                  onChange={(event) => {
                    const value = event.target.value
                    setTermDrafts((current) => current.map((item) => (
                      item.term === draft.term ? { ...item, note: value } : item
                    )))
                  }}
                  placeholder={draft.meaning || 'Thêm ghi chú cho thuật ngữ này...'}
                  rows={2}
                  data-testid={`analysis-term-note-input-${draft.term}`}
                />
                <button
                  type="button"
                  className="btn btn--secondary"
                  onClick={() => void persistTermNote(draft.term)}
                  disabled={loading || savingAll || savingTerm === draft.term}
                  data-testid={`analysis-term-note-save-${draft.term}`}
                >
                  {savingTerm === draft.term ? 'Đang lưu…' : 'Lưu thuật ngữ này'}
                </button>
              </li>
            ))}
          </ul>
        </div>
      ) : (
        <p className="analysis-term-notes__empty">Chưa có thuật ngữ từ phân tích AI.</p>
      )}
    </section>
  )
}
