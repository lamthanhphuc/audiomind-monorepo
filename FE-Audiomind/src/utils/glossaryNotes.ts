export const GLOSSARY_NOTE_STORAGE_PREFIX = 'audiomind_glossary_notes_'
export const GLOSSARY_NOTE_TYPE = 'glossary'
export const GLOSSARY_NOTE_TITLE = 'Ghi chú thuật ngữ'

export type LocalGlossaryNote = {
  meetingId: number
  body: string
}

const storageKey = (meetingId: number): string => `${GLOSSARY_NOTE_STORAGE_PREFIX}${meetingId}`

export const getGlossaryNotes = (meetingId: number | null | undefined): string => {
  if (!meetingId || typeof window === 'undefined') {
    return ''
  }
  try {
    return window.localStorage.getItem(storageKey(meetingId)) ?? ''
  } catch {
    return ''
  }
}

export const saveGlossaryNotes = (meetingId: number | null | undefined, notes: string): void => {
  if (!meetingId || typeof window === 'undefined') {
    return
  }
  try {
    const trimmed = notes.trim()
    if (!trimmed) {
      window.localStorage.removeItem(storageKey(meetingId))
      return
    }
    window.localStorage.setItem(storageKey(meetingId), notes)
  } catch {
    // Ignore quota/private mode errors.
  }
}

export const listLocalGlossaryNotes = (): LocalGlossaryNote[] => {
  if (typeof window === 'undefined') {
    return []
  }

  const results: LocalGlossaryNote[] = []
  try {
    for (let index = 0; index < window.localStorage.length; index += 1) {
      const key = window.localStorage.key(index)
      if (!key?.startsWith(GLOSSARY_NOTE_STORAGE_PREFIX)) {
        continue
      }
      const meetingId = Number(key.slice(GLOSSARY_NOTE_STORAGE_PREFIX.length))
      if (!Number.isFinite(meetingId) || meetingId <= 0) {
        continue
      }
      const body = (window.localStorage.getItem(key) ?? '').trim()
      if (body) {
        results.push({ meetingId, body })
      }
    }
  } catch {
    return []
  }

  return results.sort((left, right) => right.meetingId - left.meetingId)
}

export const notifyGlossaryNotesChanged = (): void => {
  if (typeof window === 'undefined') {
    return
  }
  window.dispatchEvent(new CustomEvent('audiomind:glossary-notes-changed'))
}
