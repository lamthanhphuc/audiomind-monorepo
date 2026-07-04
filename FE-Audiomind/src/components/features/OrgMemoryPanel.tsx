import { useEffect, useState } from 'react'

import {
  listKnowledgeNotes,
  listSpeakerMemory,
  type KnowledgeNote,
  type SpeakerMemoryEntry,
} from '../../services/knowledgeLayer'
import { EmptyState } from '../ui/EmptyState'

type OrgMemoryPanelProps = {
  onOpenMeeting?: (meetingId: number) => void
}

export default function OrgMemoryPanel({ onOpenMeeting }: OrgMemoryPanelProps) {
  const [notes, setNotes] = useState<KnowledgeNote[]>([])
  const [speakers, setSpeakers] = useState<SpeakerMemoryEntry[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    const load = async () => {
      setLoading(true)
      setError(null)
      try {
        const [noteItems, speakerItems] = await Promise.all([
          listKnowledgeNotes(),
          listSpeakerMemory(),
        ])
        if (!cancelled) {
          setNotes(noteItems.slice(0, 8))
          setSpeakers(speakerItems.slice(0, 8))
        }
      } catch (loadError) {
        if (!cancelled) {
          setError(loadError instanceof Error ? loadError.message : 'Không tải được bộ nhớ tổ chức')
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
  }, [])

  if (loading) {
    return <p className="studio-muted-text">Đang tải bộ nhớ tổ chức…</p>
  }

  if (error) {
    return <p className="studio-muted-text" role="alert">{error}</p>
  }

  const hasContent = notes.length > 0 || speakers.length > 0

  return (
    <section className="org-memory-panel" data-testid="org-memory-panel">
      {!hasContent ? (
        <EmptyState message="Chưa có ghi chú thuật ngữ hoặc speaker đã lưu. Hãy đặt tên speaker và thêm glossary trong cuộc họp." />
      ) : (
        <div className="org-memory-panel__grid">
          {notes.length > 0 && (
            <div>
              <h3 className="org-memory-panel__title">Thuật ngữ & ghi chú</h3>
              <ul className="org-memory-panel__list">
                {notes.map((note) => (
                  <li key={note.id}>
                    <strong>{note.term || note.title || 'Ghi chú'}</strong>
                    <span>{note.body.slice(0, 120)}{note.body.length > 120 ? '…' : ''}</span>
                    {note.meetingId != null && onOpenMeeting && (
                      <button type="button" className="org-memory-panel__link" onClick={() => onOpenMeeting(note.meetingId!)}>
                        Mở meeting
                      </button>
                    )}
                  </li>
                ))}
              </ul>
            </div>
          )}
          {speakers.length > 0 && (
            <div>
              <h3 className="org-memory-panel__title">Speaker quen</h3>
              <ul className="org-memory-panel__list">
                {speakers.map((speaker) => (
                  <li key={speaker.speakerFingerprint}>
                    <strong>{speaker.displayName}</strong>
                    <span>
                      {speaker.speakerFingerprint}
                      {speaker.usageCount != null ? ` · dùng ${speaker.usageCount} lần` : ''}
                    </span>
                    {speaker.lastMeetingId != null && onOpenMeeting && (
                      <button type="button" className="org-memory-panel__link" onClick={() => onOpenMeeting(speaker.lastMeetingId!)}>
                        Meeting gần nhất
                      </button>
                    )}
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
      )}
    </section>
  )
}
