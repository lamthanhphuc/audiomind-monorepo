import { useState } from 'react'
import { createMeeting, getMeeting, processMeeting } from './services/verticalSliceApi'

type MeetingView = {
  id: string
  status: string
  transcript?: string | null
  summary?: string | null
}

export default function App() {
  const [meeting, setMeeting] = useState<MeetingView | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  const handleCreateMeeting = async () => {
    setBusy(true)
    setError('')
    try {
      const created = await createMeeting()
      setMeeting(created)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Create meeting failed')
    } finally {
      setBusy(false)
    }
  }

  const handleProcess = async () => {
    if (!meeting) return

    setBusy(true)
    setError('')
    try {
      await processMeeting(meeting.id)
      const refreshed = await getMeeting(meeting.id)
      setMeeting(refreshed)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Processing failed')
    } finally {
      setBusy(false)
    }
  }

  return (
    <main style={{ maxWidth: 720, margin: '40px auto', fontFamily: 'Segoe UI, sans-serif', padding: 16 }}>
      <h1>AudioMind Vertical Slice</h1>
      <p>Flow: web ? meeting-api ? processing-api ? ai-api ? meeting-api ? web</p>

      <div style={{ display: 'flex', gap: 12, marginBottom: 16 }}>
        <button onClick={handleCreateMeeting} disabled={busy}>Create Meeting</button>
        <button onClick={handleProcess} disabled={busy || !meeting}>Process</button>
      </div>

      {error && <p style={{ color: 'crimson' }}>{error}</p>}

      {meeting && (
        <section style={{ border: '1px solid #ddd', borderRadius: 8, padding: 16 }}>
          <p><strong>ID:</strong> {meeting.id}</p>
          <p><strong>Status:</strong> {meeting.status}</p>
          <p><strong>Transcript:</strong> {meeting.transcript || '(empty)'}</p>
          <p><strong>Summary:</strong> {meeting.summary || '(empty)'}</p>
        </section>
      )}
    </main>
  )
}
