import type { KnowledgeNote } from '../services/knowledgeLayer'
import { createKnowledgeNote } from '../services/knowledgeLayer'
import {
  GLOSSARY_NOTE_TITLE,
  GLOSSARY_NOTE_TYPE,
  type LocalGlossaryNote,
  listLocalGlossaryNotes,
  saveGlossaryNotes,
} from './glossaryNotes'

export type VaultNote = KnowledgeNote & {
  localOnly?: boolean
}

export type VaultMeetingGroup = {
  meetingId: number | null
  notes: VaultNote[]
}

const LOCAL_NOTE_ID_BASE = -1_000_000_000

export const isGlossaryVaultNote = (note: Pick<KnowledgeNote, 'meetingId' | 'noteType' | 'title' | 'term'>): boolean => {
  if (note.noteType === GLOSSARY_NOTE_TYPE) {
    return true
  }
  return note.title?.trim() === GLOSSARY_NOTE_TITLE
}

export const hasServerGlossaryNote = (notes: KnowledgeNote[], meetingId: number): boolean => {
  return notes.some((note) => note.meetingId === meetingId && isGlossaryVaultNote(note))
}

export const toLocalVaultNote = (local: LocalGlossaryNote): VaultNote => ({
  id: LOCAL_NOTE_ID_BASE - local.meetingId,
  meetingId: local.meetingId,
  noteType: GLOSSARY_NOTE_TYPE,
  title: GLOSSARY_NOTE_TITLE,
  body: local.body,
  localOnly: true,
})

export const isLocalVaultNoteId = (id: number): boolean => id <= LOCAL_NOTE_ID_BASE

export const meetingIdFromLocalVaultNoteId = (id: number): number => {
  return Math.abs(id + LOCAL_NOTE_ID_BASE)
}

const matchesVaultQuery = (note: VaultNote, query: string): boolean => {
  if (!query) {
    return true
  }
  const normalized = query.trim().toLowerCase()
  if (!normalized) {
    return true
  }
  const haystack = [
    note.term,
    note.title,
    note.body,
    note.noteType,
    note.meetingId != null ? `meeting ${note.meetingId}` : '',
  ]
    .filter(Boolean)
    .join(' ')
    .toLowerCase()
  return haystack.includes(normalized)
}

export const mergeVaultNotes = (
  serverNotes: KnowledgeNote[],
  localNotes: LocalGlossaryNote[],
  query = '',
): VaultNote[] => {
  const pendingLocal = localNotes.filter((local) => !hasServerGlossaryNote(serverNotes, local.meetingId))
  const merged: VaultNote[] = [
    ...serverNotes,
    ...pendingLocal.map(toLocalVaultNote),
  ]
  return merged.filter((note) => matchesVaultQuery(note, query))
}

export const formatVaultTimestamp = (value?: string): string | null => {
  if (!value) {
    return null
  }
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) {
    return value
  }
  return new Intl.DateTimeFormat('vi-VN', {
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  }).format(date)
}

export const groupVaultNotesByMeeting = (notes: VaultNote[]): VaultMeetingGroup[] => {
  const grouped = new Map<string, VaultNote[]>()
  for (const note of notes) {
    const key = note.meetingId != null ? String(note.meetingId) : 'general'
    const bucket = grouped.get(key) ?? []
    bucket.push(note)
    grouped.set(key, bucket)
  }

  return Array.from(grouped.entries())
    .map(([key, groupNotes]) => ({
      meetingId: key === 'general' ? null : Number(key),
      notes: groupNotes,
    }))
    .sort((left, right) => (right.meetingId ?? -1) - (left.meetingId ?? -1))
}

export const syncPendingLocalGlossaryNotes = async (
  serverNotes: KnowledgeNote[],
): Promise<{ synced: KnowledgeNote[]; remainingLocal: LocalGlossaryNote[] }> => {
  const localNotes = listLocalGlossaryNotes()
  const synced: KnowledgeNote[] = []
  const remainingLocal: LocalGlossaryNote[] = []

  for (const local of localNotes) {
    if (hasServerGlossaryNote([...serverNotes, ...synced], local.meetingId)) {
      saveGlossaryNotes(local.meetingId, '')
      continue
    }

    try {
      const created = await createKnowledgeNote({
        meetingId: local.meetingId,
        noteType: GLOSSARY_NOTE_TYPE,
        title: GLOSSARY_NOTE_TITLE,
        body: local.body,
      })
      saveGlossaryNotes(local.meetingId, '')
      synced.push(created)
    } catch {
      remainingLocal.push(local)
    }
  }

  return { synced, remainingLocal }
}
