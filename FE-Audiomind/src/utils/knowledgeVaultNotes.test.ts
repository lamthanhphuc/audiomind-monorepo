import { describe, expect, it } from 'vitest'

import { GLOSSARY_NOTE_TITLE, GLOSSARY_NOTE_TYPE } from './glossaryNotes'
import {
  mergeVaultNotes,
  toLocalVaultNote,
} from './knowledgeVaultNotes'

describe('knowledgeVaultNotes', () => {
  it('merges local glossary notes when server has no matching meeting note', () => {
    const merged = mergeVaultNotes(
      [{ id: 1, meetingId: 5, noteType: 'term', title: 'API', body: 'Application interface' }],
      [{ meetingId: 9, body: 'Local glossary body' }],
    )

    expect(merged).toHaveLength(2)
    expect(merged[1]).toMatchObject({
      meetingId: 9,
      body: 'Local glossary body',
      localOnly: true,
      title: GLOSSARY_NOTE_TITLE,
    })
  })

  it('skips local glossary notes already present on server', () => {
    const merged = mergeVaultNotes(
      [{
        id: 2,
        meetingId: 9,
        noteType: GLOSSARY_NOTE_TYPE,
        title: GLOSSARY_NOTE_TITLE,
        body: 'Server body',
      }],
      [{ meetingId: 9, body: 'Local body' }],
    )

    expect(merged).toHaveLength(1)
    expect(merged[0].body).toBe('Server body')
  })

  it('filters merged notes by query', () => {
    const merged = mergeVaultNotes(
      [],
      [{ meetingId: 3, body: 'Webhook retry policy' }],
      'webhook',
    )

    expect(merged).toHaveLength(1)
    expect(toLocalVaultNote({ meetingId: 3, body: 'Webhook retry policy' }).id).toBeLessThan(0)
  })
})
