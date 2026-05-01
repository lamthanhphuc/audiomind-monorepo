import { useEffect, useMemo, useRef, useState } from 'react'
import { getAnalysis, getProcessingStatus, getTranscript, processAudio, uploadAudio } from './services/api'
import { clearAccessToken, getAccessToken, login, setAccessToken } from './services/auth'
import { REALTIME_WS_ENABLED } from './services/config'
import { RealtimeMeetingView } from './components/RealtimeMeetingView'

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
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [authError, setAuthError] = useState('')
  const [isAuthenticated, setIsAuthenticated] = useState(false)
  const [viewMode, setViewMode] = useState<'batch' | 'realtime'>('batch')
  const [realtimeMeetingId, setRealtimeMeetingId] = useState<number | null>(null)
  const [realtimeUserId, setRealtimeUserId] = useState<number | null>(null)
  const [realtimeToken] = useState<string>('')
  const abortControllerRef = useRef<AbortController | null>(null)

  const isRealtimeEnabled = REALTIME_WS_ENABLED

  useEffect(() => {
    setIsAuthenticated(Boolean(getAccessToken()))
    return () => {
      abortControllerRef.current?.abort()
    }
  }, [])

  const handleLogin = async () => {
    if (!username.trim() || !password) {
      setAuthError('Vui lòng nhập username và mật khẩu')
      return
    }

    try {
      setAuthError('')
      const auth = await login({
        username: username.trim(),
        password,
      })
      setAccessToken(auth.accessToken, auth.expiresInSeconds)
      setIsAuthenticated(true)
    } catch (loginError) {
      setAuthError(loginError instanceof Error ? loginError.message : 'Đăng nhập thất bại')
    }
  }

  const handleLogout = () => {
    clearAccessToken()
    setIsAuthenticated(false)
    setResult(null)
    setStatus('idle')
    setError('')
    setPassword('')
  }

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

  if (!isAuthenticated) {
    return (
      <main style={{ maxWidth: 480, margin: '40px auto', fontFamily: 'Segoe UI, sans-serif', padding: 16 }}>
        <h1>AudioMind Login</h1>
        <p>Đăng nhập để sử dụng API thật.</p>
        <div style={{ display: 'grid', gap: 12, marginTop: 16 }}>
          <input
            type="text"
            placeholder="Username"
            data-testid="e2e-login-username"
            value={username}
            onChange={(event) => setUsername(event.target.value)}
          />
          <input
            type="password"
            placeholder="Password"
            data-testid="e2e-login-password"
            value={password}
            onChange={(event) => setPassword(event.target.value)}
          />
          <button type="button" data-testid="e2e-login-submit" onClick={handleLogin}>Đăng nhập</button>
        </div>
        {authError && <p style={{ color: 'crimson', marginTop: 12 }}>{authError}</p>}
      </main>
    )
  }

  // Show realtime view if enabled and mode is realtime
  if (isRealtimeEnabled && viewMode === 'realtime' && realtimeMeetingId && realtimeUserId) {
    return (
      <div style={{ display: 'flex', flexDirection: 'column', height: '100vh' }}>
        <div style={{ padding: '12px 20px', borderBottom: '1px solid #e2e8f0', background: '#f8fafc' }}>
          <button onClick={() => setViewMode('batch')} style={{ marginRight: 8 }}>
            ← Back to Batch Mode
          </button>
          <button onClick={handleLogout} style={{ float: 'right' }}>
            Đăng xuất
          </button>
        </div>
        <RealtimeMeetingView
          meetingId={realtimeMeetingId}
          userId={realtimeUserId}
          token={realtimeToken}
        />
      </div>
    )
  }

  return (
    <main style={{ maxWidth: 720, margin: '40px auto', fontFamily: 'Segoe UI, sans-serif', padding: 16 }}>
      <h1>AudioMind Production Flow</h1>
      <p>Flow: upload - processing - transcript - summary</p>
      <button type="button" onClick={handleLogout} style={{ marginBottom: 16 }}>
        Đăng xuất
      </button>

      {isRealtimeEnabled && (
        <div style={{ marginBottom: 16, padding: 12, background: '#e0e7ff', borderRadius: 8 }}>
          <label style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer' }}>
            <input
              type="checkbox"
              checked={viewMode === 'realtime'}
              onChange={(e) => {
                setViewMode(e.target.checked ? 'realtime' : 'batch')
                if (e.target.checked && realtimeMeetingId) {
                  // Keep existing realtime session
                } else {
                  setRealtimeMeetingId(null)
                }
              }}
            />
            Realtime Mode (Beta)
          </label>
          {viewMode === 'realtime' && !realtimeMeetingId && (
            <div style={{ marginTop: 12, display: 'grid', gap: 8 }}>
              <input
                type="number"
                placeholder="Meeting ID"
                onChange={(e) => setRealtimeMeetingId(Number(e.target.value) || null)}
              />
              <input
                type="number"
                placeholder="User ID"
                onChange={(e) => setRealtimeUserId(Number(e.target.value) || null)}
              />
              <button
                onClick={() => realtimeMeetingId && realtimeUserId && setViewMode('realtime')}
                disabled={!realtimeMeetingId || !realtimeUserId}
              >
                Join Meeting
              </button>
            </div>
          )}
        </div>
      )}

      <div style={{ display: 'grid', gap: 12, marginBottom: 16 }}>
        <input
          type="file"
          accept="audio/*"
          data-testid="e2e-upload-input"
          onChange={(event) => setSelectedFile(event.target.files?.[0] || null)}
          disabled={busy}
        />
        <button data-testid="e2e-process-submit" onClick={handleProcess} disabled={busy || !selectedFile}>
          Phân tích file
        </button>
        {busy && (
          <button onClick={handleCancel}>
            Hủy xử lý
          </button>
        )}
      </div>

      <p data-testid="e2e-status"><strong>Status:</strong> {status}</p>
      {error && <p style={{ color: 'crimson' }}>{error}</p>}

      {result && (
        <section style={{ border: '1px solid #ddd', borderRadius: 8, padding: 16 }}>
          <p><strong>ID:</strong> {result.meetingId}</p>
          <p><strong>Status:</strong> {result.status}</p>
          <p data-testid="e2e-transcript"><strong>Transcript:</strong> {transcriptText}</p>
          <p data-testid="e2e-summary"><strong>Summary:</strong> {summaryText}</p>
        </section>
      )}
    </main>
  )
}
