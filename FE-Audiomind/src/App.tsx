import { useEffect, useMemo, useRef, useState } from 'react'
import { getAnalysis, getTranscript, uploadToMeetingApi, startProcessingByPath, getProcessingStatus } from './services/api'
import { clearAccessToken, getAccessToken, getCurrentUserId, login, setAccessToken } from './services/auth'
import { REALTIME_WS_ENABLED } from './services/config'
import { AudioRecorderButton } from './components/AudioRecorderButton'
import { RealtimeTranscript } from './components/RealtimeTranscript'
import { useAudioRecorder } from './hooks/useAudioRecorder'
import { useRealtimeMeetingStream } from './hooks/useRealtimeMeetingStream'

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

const pollWithRetry = async (meetingId: number, retries = 3, delay = 2000) => {
  for (let i = 0; i < retries; i++) {
    try {
      return await getProcessingStatus(meetingId)
    } catch (error: any) {
      // Không retry lỗi 4xx (client error)
      if (error.status >= 400 && error.status < 500) throw error
      if (i === retries - 1) throw error
      console.warn(`Polling failed, retrying in ${delay}ms...`, error)
      await new Promise(resolve => setTimeout(resolve, delay))
    }
  }
  throw new Error('Unreachable')
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

    const status = await pollWithRetry(meetingId)
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
  const [errorMessage, setErrorMessage] = useState<string | null>(null)
  const [status, setStatus] = useState('idle')
  const [result, setResult] = useState<ResultView | null>(null)
  const [liveMeetingId, setLiveMeetingId] = useState<number | null>(null)
  const [liveError, setLiveError] = useState<string | null>(null)
  const [liveStatusMessage, setLiveStatusMessage] = useState<string | null>(null)
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [authError, setAuthError] = useState('')
  const [isAuthenticated, setIsAuthenticated] = useState(false)
  const [viewMode, setViewMode] = useState<'batch' | 'realtime'>('batch')
  const [joinMeetingIdInput, setJoinMeetingIdInput] = useState('')
  const [showJoinOtherMeeting, setShowJoinOtherMeeting] = useState(false)
  const abortControllerRef = useRef<AbortController | null>(null)
  const liveMeetingIdRef = useRef<number | null>(null)

  const isRealtimeEnabled = REALTIME_WS_ENABLED
  const currentUserId = getCurrentUserId()
  const parsedRealtimeUserId = currentUserId ? Number(currentUserId) : null
  const realtimeUserId = parsedRealtimeUserId !== null && Number.isFinite(parsedRealtimeUserId)
    ? parsedRealtimeUserId
    : null
  const realtimeToken = getAccessToken() ?? ''
  const audioRecorder = useAudioRecorder()
  const realtimeStream = useRealtimeMeetingStream({
    meetingId: liveMeetingId,
    userId: realtimeUserId,
    token: realtimeToken,
    enabled: isAuthenticated && isRealtimeEnabled && viewMode === 'realtime',
    autoReconnect: true,
  })

  useEffect(() => {
    setIsAuthenticated(Boolean(getAccessToken()))
    return () => {
      abortControllerRef.current?.abort()
    }
  }, [])

  useEffect(() => {
    liveMeetingIdRef.current = liveMeetingId
  }, [liveMeetingId])

  useEffect(() => {
    if (viewMode !== 'realtime' && (audioRecorder.state === 'recording' || audioRecorder.state === 'paused')) {
      audioRecorder.stopRecording()
    }
  }, [audioRecorder, viewMode])

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
    audioRecorder.stopRecording()
    clearAccessToken()
    setIsAuthenticated(false)
    setResult(null)
    setLiveMeetingId(null)
    liveMeetingIdRef.current = null
    setStatus('idle')
    setErrorMessage(null)
    setLiveError(null)
    setLiveStatusMessage(null)
    setPassword('')
    setJoinMeetingIdInput('')
    setShowJoinOtherMeeting(false)
    setViewMode('batch')
  }

  const transcriptText = useMemo(() => result?.transcript || '(empty)', [result])
  const summaryText = useMemo(() => result?.summary || '(empty)', [result])
  const liveTranscriptKeywords = useMemo(() => realtimeStream.keywords.map((keyword) => keyword.keyword), [realtimeStream.keywords])
  const liveModeActive = isRealtimeEnabled && viewMode === 'realtime' && realtimeUserId !== null

  const handleProcess = async () => {
    if (!selectedFile) {
      setErrorMessage('Vui lòng chọn file audio trước khi xử lý')
      return
    }

    setBusy(true)
    setErrorMessage(null)
    setResult(null)
    abortControllerRef.current?.abort()
    abortControllerRef.current = new AbortController()

    let meetingId: number | null = null

    try {
      setStatus('uploading')
      const meeting = await uploadToMeetingApi(selectedFile.name, selectedFile)
      meetingId = meeting.id

      setStatus('processing')
      await startProcessingByPath(meetingId)

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
    } catch (error: any) {
      setStatus('failed')
      if (error instanceof DOMException && error.name === 'AbortError') {
        setErrorMessage('Processing cancelled')
      } else {
        const message = error.status === 401 
          ? 'Phiên đăng nhập hết hạn, vui lòng đăng nhập lại'
          : error.status === 413 
          ? 'File quá lớn (tối đa 200MB)'
          : error.status === 415
          ? 'Định dạng file không được hỗ trợ'
          : error.message || 'Lỗi không xác định, vui lòng thử lại'
        
        setErrorMessage(message)
        
        if (error.status === 401) {
          handleLogout()
        }
      }
      console.error('handleProcess error:', error)
    } finally {
      abortControllerRef.current = null
      setBusy(false)
    }
  }

  const handleCancel = () => {
    abortControllerRef.current?.abort()
  }

  const handleJoinMeeting = () => {
    const parsedMeetingId = Number(joinMeetingIdInput)
    if (!Number.isFinite(parsedMeetingId) || parsedMeetingId <= 0) {
      setLiveError('Vui lòng nhập Meeting ID hợp lệ')
      return
    }

    setLiveError(null)
    setLiveMeetingId(parsedMeetingId)
    liveMeetingIdRef.current = parsedMeetingId
    setShowJoinOtherMeeting(false)
    setViewMode('realtime')
  }

  const handlePrepareLiveMeeting = async () => {
    setLiveError(null)
    setLiveStatusMessage('Đang tạo meeting mới...')

    try {
      const bootstrapFile = createLiveMeetingBootstrapFile()
      const meeting = await uploadToMeetingApi('Live recording session', bootstrapFile)
      const normalizedMeetingId = Number(meeting.id)
      if (!Number.isFinite(normalizedMeetingId)) {
        throw new Error('Meeting ID trả về không hợp lệ')
      }

      setLiveMeetingId(normalizedMeetingId)
      liveMeetingIdRef.current = normalizedMeetingId
      setLiveStatusMessage(`Meeting ${normalizedMeetingId} sẵn sàng ghi âm`)
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Không thể tạo meeting mới'
      setLiveError(message)
      setLiveStatusMessage(null)
      throw error
    }
  }

  const handleLiveChunkReady = async (chunk: Blob) => {
    const activeMeetingId = liveMeetingIdRef.current
    if (!activeMeetingId) {
      return
    }

    try {
      await realtimeStream.sendAudioChunk(chunk, String(activeMeetingId))
    } catch (error) {
      console.error('Failed to send audio chunk:', error)
      setLiveError(error instanceof Error ? error.message : 'Không thể gửi audio chunk')
    }
  }

  const handleLiveRecordingComplete = async (fullAudio: Blob) => {
    setLiveStatusMessage(`Đã ghi âm ${Math.max(1, Math.round(fullAudio.size / 1024))} KB`)
    try {
      if (realtimeStream?.stopStream) {
        realtimeStream.stopStream()
      }
      // Wait briefly to allow final transcript to arrive
      await new Promise((resolve) => setTimeout(resolve, 1500))
      // Close connection gracefully
      if (realtimeStream?.disconnect) {
        realtimeStream.disconnect()
      }
    } catch (err) {
      console.error('Error during finalization after recording stop:', err)
    }
  }

  const createLiveMeetingBootstrapFile = () => {
    const bootstrapBytes = new Uint8Array([0])
    return new File([bootstrapBytes], `live-recording-${Date.now()}.webm`, {
      type: 'audio/webm; codecs=opus',
    })
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

  return (
    <main style={{ maxWidth: 920, margin: '40px auto', fontFamily: 'Segoe UI, sans-serif', padding: 16 }}>
      <h1>AudioMind Production Flow</h1>
      <p>Flow: upload - processing - transcript - summary</p>
      <button type="button" onClick={handleLogout} style={{ marginBottom: 16 }}>
        Đăng xuất
      </button>

      <div style={{ display: 'flex', gap: 8, marginBottom: 20 }}>
        <button
          type="button"
          onClick={() => setViewMode('batch')}
          style={{
            padding: '10px 14px',
            borderRadius: 999,
            border: '1px solid #cbd5e1',
            background: viewMode === 'batch' ? '#0f172a' : '#f8fafc',
            color: viewMode === 'batch' ? '#f8fafc' : '#0f172a',
            fontWeight: 600,
          }}
        >
          Upload File
        </button>
        {isRealtimeEnabled && (
          <button
            type="button"
            onClick={() => setViewMode('realtime')}
            style={{
              padding: '10px 14px',
              borderRadius: 999,
              border: '1px solid #cbd5e1',
              background: viewMode === 'realtime' ? '#0f172a' : '#f8fafc',
              color: viewMode === 'realtime' ? '#f8fafc' : '#0f172a',
              fontWeight: 600,
            }}
          >
            Ghi âm Trực tiếp
          </button>
        )}
      </div>

      {viewMode === 'batch' && (
        <>
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

          {errorMessage && (
            <div className="error-banner" style={{
              padding: '12px 16px',
              background: '#fee2e2',
              color: '#991b1b',
              borderRadius: 8,
              marginTop: 12,
              marginBottom: 12,
            }}>
              {errorMessage}
            </div>
          )}

          {result && (
            <section style={{ border: '1px solid #ddd', borderRadius: 8, padding: 16 }}>
              <p><strong>ID:</strong> {result.meetingId}</p>
              <p><strong>Status:</strong> {result.status}</p>
              <p data-testid="e2e-transcript"><strong>Transcript:</strong> {transcriptText}</p>
              <p data-testid="e2e-summary"><strong>Summary:</strong> {summaryText}</p>
            </section>
          )}
        </>
      )}

      {liveModeActive && (
        <section style={{ display: 'grid', gap: 16 }}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 16 }}>
            <div>
              <h2 style={{ margin: 0 }}>Ghi âm trực tiếp</h2>
              <p style={{ margin: '6px 0 0', color: '#475569' }}>
                {liveStatusMessage || realtimeStream.status.message || 'Sẵn sàng tạo meeting và bắt đầu ghi âm'}
              </p>
            </div>
            {liveMeetingId && (
              <span style={{ padding: '6px 10px', borderRadius: 999, background: '#e0e7ff', color: '#312e81' }}>
                Meeting #{liveMeetingId}
              </span>
            )}
          </div>

          <AudioRecorderButton
            recorder={audioRecorder}
            onBeforeStartRecording={handlePrepareLiveMeeting}
            onChunkReady={handleLiveChunkReady}
            onRecordingComplete={handleLiveRecordingComplete}
          />

          {liveError && (
            <div className="error-banner" style={{
              padding: '12px 16px',
              background: '#fee2e2',
              color: '#991b1b',
              borderRadius: 8,
            }}>
              {liveError}
            </div>
          )}

          {showJoinOtherMeeting && (
            <div style={{ display: 'grid', gap: 8, padding: 12, borderRadius: 8, background: '#f8fafc' }}>
              <strong>Tham gia Meeting khác</strong>
              <input
                type="number"
                placeholder="Meeting ID"
                value={joinMeetingIdInput}
                onChange={(e) => setJoinMeetingIdInput(e.target.value)}
              />
              <button
                type="button"
                onClick={handleJoinMeeting}
                disabled={!joinMeetingIdInput.trim()}
                style={{ justifySelf: 'start' }}
              >
                Join Meeting
              </button>
            </div>
          )}

          <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 1fr) 280px', gap: 16 }}>
            <RealtimeTranscript
              segments={realtimeStream.transcripts}
              highlightKeywords={liveTranscriptKeywords}
              maxHeight="620px"
            />

            <aside style={{ display: 'grid', gap: 12, alignContent: 'start' }}>
              <div style={{ padding: 12, borderRadius: 12, background: '#f8fafc', border: '1px solid #e2e8f0' }}>
                <div style={{ fontSize: 12, textTransform: 'uppercase', letterSpacing: '0.08em', color: '#64748b' }}>
                  Connection
                </div>
                <div style={{ fontSize: 18, fontWeight: 700, marginTop: 4 }}>
                  {realtimeStream.status.state}
                </div>
                <div style={{ marginTop: 6, color: '#475569' }}>
                  {realtimeStream.isConnected ? 'WebSocket đang mở' : realtimeStream.status.message || 'Chờ kết nối'}
                </div>
                {realtimeStream.closeReason && (
                  <div style={{ marginTop: 6, color: '#991b1b', fontSize: 13 }}>
                    Close reason: {realtimeStream.closeReason}
                  </div>
                )}
              </div>

              <div style={{ padding: 12, borderRadius: 12, background: '#f8fafc', border: '1px solid #e2e8f0' }}>
                <div style={{ fontSize: 12, textTransform: 'uppercase', letterSpacing: '0.08em', color: '#64748b' }}>
                  Keywords
                </div>
                <div style={{ fontSize: 18, fontWeight: 700, marginTop: 4 }}>
                  {realtimeStream.keywords.length}
                </div>
              </div>

              <div style={{ padding: 12, borderRadius: 12, background: '#f8fafc', border: '1px solid #e2e8f0' }}>
                <div style={{ fontSize: 12, textTransform: 'uppercase', letterSpacing: '0.08em', color: '#64748b' }}>
                  User
                </div>
                <div style={{ fontSize: 18, fontWeight: 700, marginTop: 4 }}>
                  {currentUserId || 'Unknown'}
                </div>
              </div>
            </aside>
          </div>
        </section>
      )}
    </main>
  )
}
