import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import TopNav from './components/TopNav'
import HeroChart from './components/HeroChart'
import FeatureUpload from './components/FeatureUpload'
import FeatureAnalysis from './components/FeatureAnalysis'
import NewsAbout from './components/NewsAbout'
import LoginModal from './components/LoginModal'
import StatusToast from './components/StatusToast'
import DashboardLayout from './components/DashboardLayout'
import FilesList from './components/FilesList'
import SubjectsList from './components/SubjectsList'
import {
  processAudio,
  getTranscript,
  getAnalysis,
  uploadAudio,
} from './services/api'
import { API_BASE } from './services/config'
import type { AiAnalysis, Meeting, TranscriptResponse } from './types'

type ProcessedMeetingItem = {
  id: number
  title: string
  processedAt: string
}

const mockUser = {
  name: 'Nguyễn Văn A',
  role: 'Học viên',
}

const meetingStorageKey = 'audiomind.currentMeeting'
const analysisStorageKey = 'audiomind.currentAnalysis'
const transcriptStorageKey = 'audiomind.currentTranscript'
const statusStorageKey = 'audiomind.processingStatus'
const processedMeetingsStorageKey = 'audiomind.processedMeetings'

const getStoredUser = () => {
  const raw = localStorage.getItem('audiomind.user')
  return raw ? (JSON.parse(raw) as typeof mockUser) : null
}

const getStoredMeeting = () => {
  const raw = localStorage.getItem(meetingStorageKey)
  return raw ? (JSON.parse(raw) as Meeting) : null
}

const getStoredAnalysis = () => {
  const raw = localStorage.getItem(analysisStorageKey)
  return raw ? (JSON.parse(raw) as AiAnalysis) : null
}

const getStoredTranscript = () => {
  const raw = localStorage.getItem(transcriptStorageKey)
  return raw ? (JSON.parse(raw) as TranscriptResponse) : null
}

const getStoredStatus = () => localStorage.getItem(statusStorageKey) ?? 'IDLE'

const getStoredProcessedMeetings = () => {
  const raw = localStorage.getItem(processedMeetingsStorageKey)
  return raw ? (JSON.parse(raw) as ProcessedMeetingItem[]) : []
}

export default function App() {
  const [user, setUser] = useState<typeof mockUser | null>(() => getStoredUser())
  const [meeting, setMeeting] = useState<Meeting | null>(() => getStoredMeeting())
  const [toast, setToast] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [showLogin, setShowLogin] = useState(false)
  const [activeNav, setActiveNav] = useState('Trang chủ')
  const [featureScene, setFeatureScene] = useState<'upload' | 'analysis' | 'mindmap' | 'files' | 'subjects'>('upload')
  const [analysis, setAnalysis] = useState<AiAnalysis | null>(() => getStoredAnalysis())
  const [transcript, setTranscript] = useState<TranscriptResponse | null>(() => getStoredTranscript())
  const [processingStatus, setProcessingStatus] = useState(() => getStoredStatus())
  const [processedMeetings, setProcessedMeetings] = useState<ProcessedMeetingItem[]>(
    () => getStoredProcessedMeetings()
  )
  const pollRunIdRef = useRef(0)

  const showToast = useCallback((message: string) => {
    setToast(message)
    window.setTimeout(() => setToast(null), 3200)
  }, [])

  const handleLogin = useCallback((name: string) => {
    const nextUser = {
      name: name.trim() || mockUser.name,
      role: mockUser.role,
    }
    localStorage.setItem('audiomind.user', JSON.stringify(nextUser))
    setUser(nextUser)
    setShowLogin(false)
  }, [])

  const handleLogout = useCallback(() => {
    localStorage.removeItem('audiomind.user')
    setUser(null)
    setActiveNav('Trang chủ')
  }, [])

  const wait = (ms: number) => new Promise((resolve) => window.setTimeout(resolve, ms))

  const getErrorMessage = (error: unknown) => {
    if (error instanceof Error) return error.message
    return 'Lỗi không xác định từ API.'
  }

  useEffect(() => {
    if (meeting) {
      localStorage.setItem(meetingStorageKey, JSON.stringify(meeting))
    } else {
      localStorage.removeItem(meetingStorageKey)
    }
  }, [meeting])

  useEffect(() => {
    if (analysis) {
      localStorage.setItem(analysisStorageKey, JSON.stringify(analysis))
    } else {
      localStorage.removeItem(analysisStorageKey)
    }
  }, [analysis])

  useEffect(() => {
    if (transcript) {
      localStorage.setItem(transcriptStorageKey, JSON.stringify(transcript))
    } else {
      localStorage.removeItem(transcriptStorageKey)
    }
  }, [transcript])

  useEffect(() => {
    localStorage.setItem(statusStorageKey, processingStatus)
  }, [processingStatus])

  useEffect(() => {
    localStorage.setItem(processedMeetingsStorageKey, JSON.stringify(processedMeetings))
  }, [processedMeetings])

  const addProcessedMeeting = useCallback((id: number, title?: string | null) => {
    const trimmedTitle = title?.trim()
    const safeTitle = trimmedTitle && trimmedTitle.length > 0
      ? trimmedTitle
      : `Meeting #${id}`

    setProcessedMeetings((prev) => {
      const next = prev.filter((item) => item.id !== id)
      next.unshift({
        id,
        title: safeTitle,
        processedAt: new Date().toISOString(),
      })
      return next.slice(0, 10)
    })
  }, [])

  const pollProcessingUntilDone = useCallback(async (meetingId: number, meetingTitle?: string) => {
    const runId = ++pollRunIdRef.current

    for (let attempt = 0; attempt < 80; attempt += 1) {
      try {
        setProcessingStatus('FETCHING_TRANSCRIPT')
        const transcriptResult = await getTranscript(meetingId)
        if (runId !== pollRunIdRef.current) return
        setTranscript(transcriptResult)
      } catch (error) {
        console.error('Transcript polling error', error)
      }

      try {
        setProcessingStatus('FETCHING_ANALYSIS')
        const result = await getAnalysis(meetingId)
        if (runId !== pollRunIdRef.current) return
        setAnalysis(result)
        setProcessingStatus('DONE')
        addProcessedMeeting(meetingId, meetingTitle)
        showToast('Xử lý hoàn tất. Đã tải transcript + phân tích.')
        return
      } catch (error) {
        console.error('Analysis polling error', error)
      }

      await wait(3000)
    }

    if (runId === pollRunIdRef.current) {
      setProcessingStatus('FAILED')
      showToast('Xử lý đang lâu hơn dự kiến, vui lòng chờ thêm.')
    }
  }, [addProcessedMeeting, showToast])

  const runProcessingFlow = useCallback(async (targetMeeting: Meeting) => {
    setBusy(true)
    setAnalysis(null)
    setTranscript(null)
    setProcessingStatus('PROCESSING_AUDIO')

    try {
      await processAudio({
        meeting_id: targetMeeting.id,
        audio_path: targetMeeting.audioPath,
        language: 'vi',
      })

      showToast(`Đã gửi xử lý tới ${API_BASE} cho meeting #${targetMeeting.id}`)
      setProcessingStatus('RUNNING')
      await pollProcessingUntilDone(targetMeeting.id, targetMeeting.title)
    } catch (error) {
      console.error('Process API error', error)
      setProcessingStatus('FAILED')
      showToast(`Gọi API thất bại: ${getErrorMessage(error)}`)
    } finally {
      setBusy(false)
    }
  }, [pollProcessingUntilDone, showToast])

  const handleUpload = useCallback(async (title: string, file: File) => {
    setBusy(true)

    let uploadedPath = ''
    try {
      const uploadResult = await uploadAudio(file)
      uploadedPath = uploadResult.audio_path
    } catch (error) {
      console.error('Upload audio error', error)
      showToast(`Tải file lên backend thất bại: ${getErrorMessage(error)}`)
      setBusy(false)
      return
    } finally {
      setBusy(false)
    }

    const nextMeeting: Meeting = {
      id: Math.floor(Date.now() / 1000) + Math.floor(Math.random() * 1000),
      title,
      audioPath: uploadedPath,
      createdAt: new Date().toISOString(),
    }

    setMeeting(nextMeeting)
    setFeatureScene('analysis')
    await runProcessingFlow(nextMeeting)
  }, [runProcessingFlow, showToast])

  const handleStartProcessing = useCallback(async () => {
    if (!meeting?.id) {
      showToast('Hãy tải file ghi âm trước khi xử lý.')
      return
    }

    await runProcessingFlow(meeting)
  }, [meeting, runProcessingFlow, showToast])

  const handleLoadAnalysis = useCallback(async () => {
    if (!meeting?.id) {
      showToast('Hãy tải file ghi âm trước khi tải phân tích.')
      return
    }

    if (
      processingStatus === 'RUNNING' ||
      processingStatus === 'PROCESSING_AUDIO' ||
      processingStatus === 'FETCHING_TRANSCRIPT' ||
      processingStatus === 'FETCHING_ANALYSIS'
    ) {
      showToast('Dữ liệu đang được xử lý. Hệ thống sẽ tự cập nhật khi hoàn tất.')
      return
    }

    setBusy(true)
    let transcriptLoaded = false
    let analysisLoaded = false

    try {
      setProcessingStatus('FETCHING_TRANSCRIPT')
      try {
        const transcriptResult = await getTranscript(meeting.id)
        setTranscript(transcriptResult)
        transcriptLoaded = true
      } catch (error) {
        console.error('Load transcript error', error)
      }

      setProcessingStatus('FETCHING_ANALYSIS')
      try {
        const result = await getAnalysis(meeting.id)
        setAnalysis(result)
        analysisLoaded = true
      } catch (error) {
        console.error('Load analysis error', error)
      }

      if (analysisLoaded) {
        setProcessingStatus('DONE')
      } else if (transcriptLoaded) {
        setProcessingStatus('FETCHING_ANALYSIS')
      } else {
        setProcessingStatus('FAILED')
      }

      if (transcriptLoaded && analysisLoaded) {
        showToast('Đã tải transcript + kết quả phân tích.')
      } else if (transcriptLoaded) {
        showToast('Đã tải full transcript. Phân tích AI chưa sẵn sàng.')
      } else if (analysisLoaded) {
        showToast('Đã tải phân tích AI. Transcript chưa sẵn sàng.')
      } else {
        showToast('Chưa lấy được transcript và phân tích, vui lòng thử lại.')
      }
    } finally {
      setBusy(false)
    }
  }, [meeting, processingStatus, showToast])

  const renderFeatureScene = () => {
    if (featureScene === 'analysis') {
      return (
        <FeatureAnalysis
          meetingId={meeting?.id}
          meetingTitle={meeting?.title}
          busy={busy}
          analysis={analysis}
          transcript={transcript}
          processingStatus={processingStatus}
          processedMeetings={processedMeetings}
          onStartProcessing={handleStartProcessing}
          onLoadAnalysis={handleLoadAnalysis}
        />
      )
    }

    if (featureScene === 'files') return <FilesList />
    if (featureScene === 'subjects') return <SubjectsList />

    return <FeatureUpload disabled={busy} onUpload={handleUpload} />
  }

  const heroSubtitle = useMemo(() => (
    'Chào mừng đến với MIND - nền tảng AI giúp ghi âm và tóm tắt bài giảng, ' +
    'cuộc họp hoặc văn bản, giúp bạn nắm ý chính nhanh chóng và học tập hiệu quả hơn.'
  ), [])

  const openFeatureUploadFlow = useCallback(() => {
    setActiveNav('Tính năng')
    setFeatureScene('upload')
  }, [])

  const guestIsNews = activeNav === 'Tin tức'

  return (
    <div className={`app ${user ? '' : 'app--guest'} ${user && activeNav === 'Tính năng' ? 'app--dashboard' : ''}`}>
      {!(user && activeNav === 'Tính năng') && (
        <TopNav
          user={user}
          onLogout={handleLogout}
          onTry={() => setShowLogin(true)}
          isGuest={!user}
          activeNav={activeNav}
          onNavChange={setActiveNav}
        />
      )}

      {(() => {
        if (user) {
          if (activeNav === 'Tính năng') {
            return (
              <DashboardLayout
                user={user}
                onLogout={handleLogout}
                activeMenu={featureScene}
                onNavigate={(scene) => setFeatureScene(scene)}
              >
                {renderFeatureScene()}
              </DashboardLayout>
            )
          }

          return (
            <main className="page">
              {activeNav === 'Tin tức' ? (
                <NewsAbout />
              ) : (
                <>
                  <section className="hero">
                    <div className="hero__search">
                      <input
                        className="search-input"
                        type="search"
                        placeholder="Tìm bài giảng, môn học, ghi chú..."
                      />
                      <span className="search-icon">⌕</span>
                    </div>
                    <div className="hero__content">
                      <h1>Cách mạng hóa quy trình học bài</h1>
                      <p>{heroSubtitle}</p>
                    </div>
                    <button className="hero__cta" type="button" onClick={openFeatureUploadFlow}>
                      Tải file/Phân tích
                    </button>
                    <HeroChart />
                  </section>
                </>
              )}
            </main>
          )
        }

        return (
          <main className="guest">
            <div className="guest__search">
              <input
                className="search-input"
                type="search"
                placeholder="Tìm bài giảng, môn học, ghi chú..."
              />
              <span className="search-icon">⌕</span>
            </div>
            <div className="guest__content">
              <h1>{guestIsNews ? 'Về chúng tôi' : 'Cách mạng hóa quy trình học bài'}</h1>
              <p>
                Chào mừng bạn đến với <span className="guest__brand">MIND</span> - nền tảng AI giúp
                ghi âm và tóm tắt bài giảng hoặc cuộc họp thành văn bản để đọc. Thay vì phải nghe
                lại 1-2 giờ ghi âm, người dùng chỉ cần 5-10 phút để đọc bản tóm tắt các ý chính,
                khái niệm, công thức và ví dụ quan trọng. <span className="guest__brand">MIND</span>
                hỗ trợ tiếng Việt học thuật, giúp người dùng hiểu các thuật ngữ chuyên ngành dễ
                dàng hơn. Nền tảng có thể sử dụng cho học online, lớp học trực tiếp hoặc các cuộc
                họp, giúp việc học và làm việc trở nên nhanh chóng và hiệu quả hơn.
              </p>
              <button
                className="guest__cta"
                type="button"
                onClick={() => {
                  setShowLogin(true)
                  setActiveNav('Tính năng')
                  setFeatureScene('upload')
                }}
              >
                {guestIsNews ? 'Xem thêm' : 'Tải file/Phân tích'}
              </button>
            </div>
          </main>
        )
      })()}

      {showLogin && (
        <LoginModal onLogin={handleLogin} onClose={() => setShowLogin(false)} />
      )}
      {toast && <StatusToast message={toast} />}
    </div>
  )
}
