import { useMemo, useState } from 'react'
import type { TranscriptSegment } from '../../hooks/useRealtimeMeetingStream'
import { normalizeAnalysisResponse, type AiAnalysis } from '../../types'
import { AnalysisPanel } from '../analysis/AnalysisPanel'
import AiAssistant from '../dashboard/AiAssistant'
import { TranscriptDisplay } from '../transcript/TranscriptDisplay'

type FeatureAnalysisProps = {
  meetingId?: number | null
  meetingTitle?: string
  fileName?: string
  busy?: boolean
  analysis: AiAnalysis | null
  transcriptSegments?: TranscriptSegment[]
  transcriptText?: string
  statusLabel?: string
}

export default function FeatureAnalysis({
  meetingId,
  meetingTitle,
  fileName,
  busy,
  analysis,
  transcriptSegments = [],
  transcriptText = '',
  statusLabel,
}: FeatureAnalysisProps) {
  const [activeTab, setActiveTab] = useState<'content' | 'model' | 'mindmap'>('content')
  const normalizedAnalysis = useMemo(
    () => (analysis ? normalizeAnalysisResponse(analysis) : null),
    [analysis],
  )
  const title = meetingTitle || fileName || 'Kết quả phân tích'
  const audioLabel = fileName || 'audio-file.mp3'
  const hasTranscript = transcriptSegments.length > 0 || transcriptText.trim().length > 0

  const statusBadge = useMemo(() => {
    if (!statusLabel) return null
    return <span className="meta-pill analysis-meta-pill">{statusLabel}</span>
  }, [statusLabel])

  return (
    <div className="dashboard-page bg-gray-light">
      <header className="analysis-page-header">
        <div className="breadcrumbs">
          <button type="button" className="back-btn" aria-label="Quay lại">←</button>
          <span>{title}</span>
          {meetingId && <span className="meta-pill">ID {meetingId}</span>}
          {statusBadge}
        </div>
        <div className="header-actions">
          <button type="button" className="secondary-cta" style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
            <span>⬇</span> Tải slide
          </button>
        </div>
      </header>

      <div className="analysis-main-content">
        <div className="analysis-left-panel">
          <div className="audio-player-card">
            <div className="audio-waves" />
            <div className="audio-controls">
              <button type="button" className="play-btn" aria-label="Phát">▶</button>
              <div className="time-info">
                <span className="time-title">{audioLabel}</span>
                <span className="time-duration">—</span>
              </div>
              <div className="audio-options">
                <button type="button" aria-label="Âm lượng">🔊</button>
                <select aria-label="Tốc độ phát"><option>1x</option></select>
                <button type="button" aria-label="Cài đặt">⚙</button>
              </div>
            </div>
          </div>

          <div className="analysis-tabs">
            <button
              type="button"
              className={`tab-btn ${activeTab === 'content' ? 'active' : ''}`}
              onClick={() => setActiveTab('content')}
            >
              Transcript
            </button>
            <button
              type="button"
              className={`tab-btn ${activeTab === 'model' ? 'active' : ''}`}
              onClick={() => setActiveTab('model')}
            >
              Phân tích AI
            </button>
            <button
              type="button"
              className={`tab-btn ${activeTab === 'mindmap' ? 'active' : ''}`}
              onClick={() => setActiveTab('mindmap')}
            >
              Mindmap
            </button>
          </div>

          <div className="doc-content">
            {activeTab === 'mindmap' && (
              <div className="mindmap-placeholder">
                <p>Sơ đồ mindmap sẽ hiển thị khi có dữ liệu từ phân tích.</p>
              </div>
            )}

            {activeTab === 'content' && (
              <div data-testid="e2e-transcript">
                {hasTranscript ? (
                  <TranscriptDisplay
                    segments={transcriptSegments}
                    transcriptTextFallback={transcriptText}
                    emptyMessage="Không có transcript"
                    maxHeight="520px"
                    enableDisplayGrouping
                  />
                ) : (
                  <p className="analysis-empty-hint">
                    {busy ? 'Đang xử lý transcript...' : 'Chưa có transcript. Hãy tải file và phân tích từ màn Tải & phân tích.'}
                  </p>
                )}
              </div>
            )}

            {activeTab === 'model' && (
              <div className="analysis-inline-panel">
                <AnalysisPanel
                  title="Phân tích AI"
                  analysis={normalizedAnalysis}
                  status={busy ? 'loading' : normalizedAnalysis ? 'ready' : 'empty'}
                  testId="e2e-analysis"
                  summaryTestId="e2e-summary"
                  summaryFallback="(empty)"
                  loadingMessage="Đang phân tích nội dung..."
                  emptyMessage="Chưa có kết quả phân tích"
                />
              </div>
            )}
          </div>
        </div>

        <div className="analysis-right-panel">
          <AnalysisPanel
            title="Tóm tắt"
            analysis={normalizedAnalysis}
            status={busy ? 'loading' : normalizedAnalysis ? 'ready' : 'empty'}
            summaryTestId="e2e-summary"
            summaryFallback="(empty)"
          />
          <AiAssistant
            busy={busy}
            meetingId={meetingId}
            onAsk={async () => {
              await new Promise((resolve) => window.setTimeout(resolve, 600))
              return normalizedAnalysis?.summary
                ? `Tóm tắt: ${normalizedAnalysis.summary}`
                : 'Chưa có dữ liệu phân tích để trả lời câu hỏi.'
            }}
          />
        </div>
      </div>
    </div>
  )
}
