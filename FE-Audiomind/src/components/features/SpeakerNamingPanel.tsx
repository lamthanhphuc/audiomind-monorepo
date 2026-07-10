import { useCallback, useEffect, useMemo, useState } from 'react'

import type { TranscriptSegment } from '../../hooks/useRealtimeMeetingStream'
import {
  listSpeakerProfiles,
  listSpeakerMemory,
  rememberSpeakerDisplayName,
  suggestSpeakerDisplayName,
  upsertSpeakerProfiles,
  type SpeakerMemoryEntry,
  type SpeakerProfile,
} from '../../services/knowledgeLayer'
import { normalizeSpeakerBadge } from '../../utils/transcript'

type Props = {
  meetingId?: number | null
  transcriptSegments?: TranscriptSegment[]
  onProfilesSaved?: (profiles: SpeakerProfile[]) => void
}

type SpeakerDraft = {
  speakerKey: string
  displayName: string
  suggestedName?: string
}

const collectSpeakerKeys = (segments: TranscriptSegment[] | undefined): string[] => {
  const keys = new Set<string>()
  for (const segment of segments ?? []) {
    const key = normalizeSpeakerBadge(segment.speaker)
    if (key) {
      keys.add(key)
    }
  }
  return Array.from(keys).sort((left, right) => left.localeCompare(right))
}

export default function SpeakerNamingPanel({ meetingId, transcriptSegments, onProfilesSaved }: Props) {
  const speakerKeys = useMemo(() => collectSpeakerKeys(transcriptSegments), [transcriptSegments])
  const [drafts, setDrafts] = useState<SpeakerDraft[]>([])
  const [loading, setLoading] = useState(false)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [savedHint, setSavedHint] = useState('')
  const [knownSpeakers, setKnownSpeakers] = useState<SpeakerMemoryEntry[]>([])

  useEffect(() => {
    let cancelled = false
    const loadKnown = async () => {
      try {
        const items = await listSpeakerMemory()
        if (!cancelled) {
          setKnownSpeakers(items.slice(0, 6))
        }
      } catch {
        if (!cancelled) {
          setKnownSpeakers([])
        }
      }
    }
    void loadKnown()
    return () => {
      cancelled = true
    }
  }, [meetingId, savedHint])

  const loadProfiles = useCallback(async () => {
    if (!meetingId) {
      setDrafts([])
      return
    }
    setLoading(true)
    setError(null)
    try {
      const profiles = await listSpeakerProfiles(meetingId)
      const profileMap = new Map(profiles.map((profile) => [profile.speakerKey, profile.displayName]))
      const keys = speakerKeys.length > 0 ? speakerKeys : profiles.map((profile) => profile.speakerKey)
      const nextDrafts = await Promise.all(
        keys.map(async (speakerKey) => {
          const existing = profileMap.get(speakerKey) ?? ''
          if (existing) {
            return { speakerKey, displayName: existing }
          }
          try {
            const suggestion = await suggestSpeakerDisplayName(speakerKey)
            if (suggestion.suggested && suggestion.displayName) {
              return {
                speakerKey,
                displayName: suggestion.displayName,
                suggestedName: suggestion.displayName,
              }
            }
          } catch {
            // Ignore suggestion failures.
          }
          return { speakerKey, displayName: '' }
        }),
      )
      setDrafts(nextDrafts)
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : 'Không tải được hồ sơ người nói')
      setDrafts(speakerKeys.map((speakerKey) => ({ speakerKey, displayName: '' })))
    } finally {
      setLoading(false)
    }
  }, [meetingId, speakerKeys])

  useEffect(() => {
    void loadProfiles()
  }, [loadProfiles])

  const handleSave = async () => {
    if (!meetingId) {
      return
    }
    const profilesToSave = drafts
      .map((draft) => ({
        speakerKey: draft.speakerKey,
        displayName: draft.displayName.trim(),
      }))
      .filter((draft) => draft.displayName.length > 0)

    if (profilesToSave.length === 0) {
      setError('Hãy nhập ít nhất một tên hiển thị.')
      return
    }

    setSaving(true)
    setError(null)
    try {
      const saved = await upsertSpeakerProfiles(meetingId, profilesToSave)
      await Promise.all(
        profilesToSave.map((profile) =>
          rememberSpeakerDisplayName(profile.speakerKey, profile.displayName, meetingId),
        ),
      )
      onProfilesSaved?.(saved)
      setSavedHint('Đã lưu tên người nói cho cuộc họp này.')
      window.setTimeout(() => setSavedHint(''), 2500)
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : 'Không lưu được hồ sơ người nói')
    } finally {
      setSaving(false)
    }
  }

  if (!meetingId) {
    return null
  }

  return (
    <section className="speaker-naming-panel" data-testid="speaker-naming-panel">
      <header className="speaker-naming-panel__header">
        <div>
          <h3>Đặt tên người nói</h3>
          <p className="speaker-naming-panel__subtitle">
            Đổi SPEAKER_1 thành tên thật. Gợi ý từ lịch sử đặt tên trước đó.
          </p>
        </div>
        <button
          type="button"
          className="btn btn--secondary"
          onClick={() => void handleSave()}
          disabled={saving || loading}
          data-testid="speaker-naming-save"
        >
          {saving ? 'Đang lưu…' : 'Lưu tên'}
        </button>
      </header>

      {loading && <p className="speaker-naming-panel__hint">Đang tải người nói…</p>}
      {error && <p className="speaker-naming-panel__error" role="alert">{error}</p>}
      {savedHint && <p className="speaker-naming-panel__hint">{savedHint}</p>}

      {knownSpeakers.length > 0 && (
        <div className="speaker-naming-panel__memory" data-testid="speaker-memory-suggestions">
          <p className="speaker-naming-panel__memory-title">Người nói quen từ các cuộc họp trước</p>
          <div className="speaker-naming-panel__memory-chips">
            {knownSpeakers.map((speaker) => (
              <button
                key={speaker.speakerFingerprint}
                type="button"
                className="speaker-naming-panel__memory-chip"
                onClick={() => {
                  setDrafts((current) => current.map((draft) => (
                    draft.speakerKey === speaker.speakerFingerprint && !draft.displayName.trim()
                      ? { ...draft, displayName: speaker.displayName, suggestedName: speaker.displayName }
                      : draft
                  )))
                }}
              >
                {speaker.displayName}
              </button>
            ))}
          </div>
        </div>
      )}

      {drafts.length === 0 && !loading ? (
        <p className="speaker-naming-panel__empty">Chưa phát hiện người nói trong transcript.</p>
      ) : (
        <ul className="speaker-naming-panel__list">
          {drafts.map((draft) => (
            <li key={draft.speakerKey} className="speaker-naming-panel__row">
              <label htmlFor={`speaker-name-${draft.speakerKey}`}>{draft.speakerKey}</label>
              <input
                id={`speaker-name-${draft.speakerKey}`}
                type="text"
                value={draft.displayName}
                placeholder={draft.suggestedName ? `Gợi ý: ${draft.suggestedName}` : 'Tên hiển thị'}
                onChange={(event) => {
                  const value = event.target.value
                  setDrafts((current) =>
                    current.map((item) =>
                      item.speakerKey === draft.speakerKey ? { ...item, displayName: value } : item,
                    ),
                  )
                }}
                data-testid={`speaker-name-input-${draft.speakerKey}`}
              />
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}
