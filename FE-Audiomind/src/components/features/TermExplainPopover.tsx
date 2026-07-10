import { useEffect, useState } from 'react'

import type { AiAnalysis } from '../../types'
import { createKnowledgeNote, explainMeetingTerm } from '../../services/knowledgeLayer'

type Props = {
  meetingId: number
  term: string
  analysis?: AiAnalysis | null
  onClose: () => void
  onSaved?: () => void
}

export default function TermExplainPopover({ meetingId, term, onClose, onSaved }: Props) {
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [explanation, setExplanation] = useState('')
  const [provider, setProvider] = useState<string | undefined>()
  const [error, setError] = useState<string | null>(null)
  const [savedHint, setSavedHint] = useState('')

  useEffect(() => {
    let cancelled = false
    const load = async () => {
      setLoading(true)
      setError(null)
      try {
        const result = await explainMeetingTerm(meetingId, term)
        if (!cancelled) {
          setExplanation(result.explanation)
          setProvider(result.provider)
        }
      } catch (loadError) {
        if (!cancelled) {
          setError(loadError instanceof Error ? loadError.message : 'Không giải thích được thuật ngữ')
        }
      } finally {
        if (!cancelled) {
          setLoading(false)
        }
      }
    }
    void load()
    return () => {
      cancelled = true
    }
  }, [meetingId, term])

  const handleSaveNote = async () => {
    const body = explanation.trim() || `Ghi chú cho thuật ngữ ${term}`
    setSaving(true)
    setError(null)
    try {
      await createKnowledgeNote({
        meetingId,
        term,
        noteType: 'term',
        title: term,
        body,
      })
      setSavedHint('Đã lưu vào Kho tri thức.')
      onSaved?.()
      window.setTimeout(() => setSavedHint(''), 2000)
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : 'Không lưu được ghi chú')
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="term-explain-popover__backdrop" data-testid="term-explain-popover">
      <div className="term-explain-popover" role="dialog" aria-label={`Giải thích ${term}`}>
        <header className="term-explain-popover__header">
          <div>
            <p className="term-explain-popover__eyebrow">Thuật ngữ</p>
            <h3>{term}</h3>
          </div>
          <button type="button" className="btn btn--secondary" onClick={onClose} aria-label="Đóng">
            Đóng
          </button>
        </header>

        {loading && <p>Đang giải thích…</p>}
        {error && <p className="term-explain-popover__error" role="alert">{error}</p>}
        {!loading && !error && (
          <p className="term-explain-popover__body">{explanation}</p>
        )}
        {provider && !loading && (
          <p className="term-explain-popover__meta">Nguồn: {provider}</p>
        )}
        {savedHint && <p className="term-explain-popover__hint">{savedHint}</p>}

        <footer className="term-explain-popover__actions">
          <button
            type="button"
            className="btn btn--primary"
            onClick={() => void handleSaveNote()}
            disabled={saving || loading}
            data-testid="term-explain-save-note"
          >
            {saving ? 'Đang lưu…' : 'Lưu thành ghi chú'}
          </button>
        </footer>
      </div>
    </div>
  )
}
