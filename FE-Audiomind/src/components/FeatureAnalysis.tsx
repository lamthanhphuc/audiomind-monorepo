import { useState } from 'react'
import type { AiAnalysis, TranscriptResponse } from '../types'
import AiAssistant from './AiAssistant'

type ProcessedMeetingItem = {
  id: number
  title: string
  processedAt: string
}

type FeatureAnalysisProps = {
  meetingId?: number | null
  meetingTitle?: string
  busy?: boolean
  analysis: AiAnalysis | null
  transcript: TranscriptResponse | null
  processingStatus?: string
  processedMeetings: ProcessedMeetingItem[]
  onStartProcessing: () => Promise<void>
  onLoadAnalysis: () => Promise<void>
}

export default function FeatureAnalysis({
  meetingId,
  meetingTitle,
  busy,
  analysis,
  transcript: _transcript,
  processingStatus: _processingStatus,
  processedMeetings: _processedMeetings,
  onStartProcessing,
  onLoadAnalysis: _onLoadAnalysis,
}: FeatureAnalysisProps) {
  const [activeTab, setActiveTab] = useState<'content' | 'model' | 'mindmap'>('content')

  const title = meetingTitle || 'Thuyết trình môn AI cho các bạn sinh viên'

  return (
    <div className="dashboard-page bg-gray-light">
      <header className="analysis-page-header">
        <div className="breadcrumbs">
          <button className="back-btn">←</button>
          <span>{title}</span>
        </div>
        <div className="header-actions">
          <button className="secondary-cta" style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
            <span>⬇</span> Tải slide
          </button>
        </div>
      </header>

      <div className="analysis-main-content">
        <div className="analysis-left-panel">
          
          <div className="audio-player-card">
            <div className="audio-waves"></div>
            <div className="audio-controls">
              <button className="play-btn">⏸</button>
              <div className="time-info">
                <span className="time-title">thuyet-trinh.mp3</span>
                <span className="time-duration">12:00:00</span>
              </div>
              <div className="audio-options">
                <button>🔊</button>
                <select><option>1x</option></select>
                <button>⚙</button>
              </div>
            </div>
          </div>

          <div className="analysis-tabs">
            <button 
              className={`tab-btn ${activeTab === 'content' ? 'active' : ''}`}
              onClick={() => setActiveTab('content')}
            >
              Phân tích nội dung
            </button>
            <button 
              className={`tab-btn ${activeTab === 'model' ? 'active' : ''}`}
              onClick={() => setActiveTab('model')}
            >
              Mô hình và Kiến trúc
            </button>
            <button 
              className={`tab-btn ${activeTab === 'mindmap' ? 'active' : ''}`}
              onClick={() => setActiveTab('mindmap')}
            >
              Mindmap
            </button>
          </div>

          <div className="doc-content">
            {activeTab === 'mindmap' ? (
              <div style={{ textAlign: 'center', padding: '40px 0' }}>
                <img src="/tính năng/mindmap_scene.png" alt="Mindmap" style={{ maxWidth: '100%', borderRadius: '8px' }} />
              </div>
            ) : (
              <>
                <h2>Nhận dạng Giọng nói và Xử lý Ngôn ngữ Tự nhiên</h2>
                
                <h3>1. Nhận dạng Giọng nói (Speech Recognition)</h3>
                <p>Khái niệm: Là quá trình máy tính nhận diện và chuyển đổi giọng nói con người thành văn bản.</p>
                <p>Ứng dụng: Trợ lý ảo (Siri, Google Assistant), hệ thống tổng đài tự động, phần mềm chuyển ngữ (dictation).</p>
                
                <h3>2. Xử lý Ngôn ngữ Tự nhiên (NLP)</h3>
                <p>Khái niệm: Lĩnh vực nghiên cứu giúp máy tính hiểu, phân tích, và tạo ra ngôn ngữ của con người một cách tự nhiên.</p>
                <p>Các ứng dụng tiêu biểu:</p>
                <ul>
                  <li>Dịch tự động: Google Translate.</li>
                  <li>Phân tích cảm xúc: Xác định xem phản hồi của người dùng là tích cực, tiêu cực, hay trung lập.</li>
                  <li>Chatbot: Trợ lý ảo giao tiếp tự nhiên như ChatGPT.</li>
                </ul>
                
                {analysis && (
                  <div style={{ marginTop: '30px', padding: '20px', background: '#f8f9fa', borderRadius: '8px' }}>
                    <h3>Kết quả AI chi tiết:</h3>
                    <p>{analysis.summary}</p>
                    {analysis.keywords && <p><strong>Từ khóa:</strong> {analysis.keywords.join(', ')}</p>}
                    {analysis.action_items && (
                      <ul>
                        {analysis.action_items.map((item, idx) => (
                          <li key={idx}>{item.task}</li>
                        ))}
                      </ul>
                    )}
                  </div>
                )}

                {(!analysis && !busy) && (
                  <div style={{ marginTop: '20px' }}>
                    <button className="btn-primary" onClick={onStartProcessing} style={{ width: 'auto' }}>
                      Bắt đầu xử lý báo cáo AI
                    </button>
                  </div>
                )}
              </>
            )}
          </div>

        </div>
        
        <div className="analysis-right-panel">
          <AiAssistant 
            busy={busy}
            meetingId={meetingId}
            onAsk={async (_msg) => {
              return new Promise(resolve => setTimeout(() => {
                resolve("Dưới đây là một số ý chính được tóm tắt từ bài giảng:\n- Khái niệm: Xử lý Ngôn ngữ Tự nhiên (NLP).")
              }, 1000))
            }}
          />
        </div>
      </div>
    </div>
  )
}
