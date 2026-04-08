import { useEffect, useMemo, useRef, useState } from 'react'
import { getAnalysis, getProcessingStatus, getTranscript, processAudio, uploadAudio } from './services/api'

type ResultView = {
  meetingId: number
  status: string
  transcript: string
  summary: string
}

const waitWithSignal = (delayMs: number, signal: AbortSignal): Promise<void> => {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort)
      resolve()
    }, delayMs)

    const onAbort = () => {
      clearTimeout(timer)
      reject(new DOMException('Polling aborted', 'AbortError'))
    }

    signal.addEventListener('abort', onAbort, { once: true })
  })
}

const pollUntilCompleted = async (
  meetingId: number,
  signal: AbortSignal,
  maxAttempts = 120,
): Promise<void> => {
  let delayMs = 1000

  for (let i = 0; i < maxAttempts; i += 1) {
    if (signal.aborted) {
      throw new DOMException('Polling aborted', 'AbortError')
    }

    const status = await getProcessingStatus(meetingId)
    const value = String(status.status || '').toUpperCase()

    if (value === 'COMPLETED') {
      return
    }

    if (value === 'FAILED') {
      throw new Error(status.error || 'Processing failed')
    }

    if (i < maxAttempts - 1) {
      await waitWithSignal(delayMs, signal)
      delayMs = Math.min(Math.floor(delayMs * 1.35), 8000)
    }
  }

  throw new Error('Processing timeout exceeded')
}

export default function App() {
  const [selectedFile, setSelectedFile] = useState<File | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [status, setStatus] = useState('idle')
  const [result, setResult] = useState<ResultView | null>(null)
  const abortControllerRef = useRef<AbortController | null>(null)

  useEffect(() => {
    return () => {
      abortControllerRef.current?.abort()
    }
  }, [])

  const transcriptText = useMemo(() => result?.transcript || '(empty)', [result])
  const summaryText = useMemo(() => result?.summary || '(empty)', [result])

  const handleProcess = async () => {
    if (!selectedFile) {
      setError('Vui lòng chọn file audio trước khi xử lý')
      return
    }

    setBusy(true)
    setError('')
    setResult(null)
    abortControllerRef.current?.abort()
    abortControllerRef.current = new AbortController()

    const meetingId = Date.now()

    try {
      setStatus('uploading')
      const upload = await uploadAudio(selectedFile)

      setStatus('processing')
      await processAudio({
        meeting_id: meetingId,
        audio_path: upload.audio_path,
        language: 'vi',
      })

      await pollUntilCompleted(meetingId, abortControllerRef.current.signal)

      setStatus('fetching-result')
      const [transcript, analysis] = await Promise.all([
        getTranscript(meetingId),
        getAnalysis(meetingId),
      ])

      const mergedTranscript = (transcript.transcripts || [])
        .map((segment) => `${segment.speaker}: ${segment.text}`)
        .join(' ')
        .trim()

      setResult({
        meetingId,
        status: 'COMPLETED',
        transcript: mergedTranscript,
        summary: analysis.summary || '',
      })
      setStatus('completed')
    } catch (e) {
      setStatus('failed')
      if (e instanceof DOMException && e.name === 'AbortError') {
        setError('Processing cancelled')
      } else {
        setError(e instanceof Error ? e.message : 'Processing failed')
      }
    } finally {
      abortControllerRef.current = null
      setBusy(false)
    }
  }

  const handleCancel = () => {
    abortControllerRef.current?.abort()
  }

  return (
    <main style={{ maxWidth: 720, margin: '40px auto', fontFamily: 'Segoe UI, sans-serif', padding: 16 }}>
      <h1>AudioMind Production Flow</h1>
      <p>Flow: upload - processing - transcript - summary</p>

      <div style={{ display: 'grid', gap: 12, marginBottom: 16 }}>
        <input
          type="file"
          accept="audio/*"
          onChange={(event) => setSelectedFile(event.target.files?.[0] || null)}
          disabled={busy}
        />
        <button onClick={handleProcess} disabled={busy || !selectedFile}>
          Phân tích file
        </button>
        {busy && (
          <button onClick={handleCancel}>
            Hủy xử lý
          </button>
        )}
      </div>

      <p><strong>Status:</strong> {status}</p>
      {error && <p style={{ color: 'crimson' }}>{error}</p>}

      {result && (
        <section style={{ border: '1px solid #ddd', borderRadius: 8, padding: 16 }}>
          <p><strong>ID:</strong> {result.meetingId}</p>
          <p><strong>Status:</strong> {result.status}</p>
          <p><strong>Transcript:</strong> {transcriptText}</p>
          <p><strong>Summary:</strong> {summaryText}</p>
        </section>
      )}
    </main>
  )
}
