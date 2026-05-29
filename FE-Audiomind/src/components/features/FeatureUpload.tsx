import { useRef, useState } from 'react'
import type { RealtimeLanguage } from '../../hooks/useRealtimeMeetingStream'
import { ErrorState } from '../ui/ErrorState'
import { getStatusBadgeClass } from '../../utils/statusBadge'

type FeatureUploadProps = {
  disabled?: boolean
  userName?: string
  uploadLanguage: RealtimeLanguage
  onUploadLanguageChange: (language: RealtimeLanguage) => void
  status?: string
  errorMessage?: string | null
  duplicateNotice?: string | null
  onUpload: (title: string, file: File) => Promise<void>
  onCancel?: () => void
}

export default function FeatureUpload({
  disabled,
  userName = 'bạn',
  uploadLanguage,
  onUploadLanguageChange,
  status = 'idle',
  errorMessage,
  duplicateNotice,
  onUpload,
  onCancel,
}: FeatureUploadProps) {
  const fileInputRef = useRef<HTMLInputElement | null>(null)
  const [dragActive, setDragActive] = useState(false)
  const [subject, setSubject] = useState('')
  const [selectedFile, setSelectedFile] = useState<File | null>(null)

  const handleDrag = (e: React.DragEvent) => {
    e.preventDefault()
    e.stopPropagation()
    if (e.type === 'dragenter' || e.type === 'dragover') {
      setDragActive(true)
    } else if (e.type === 'dragleave') {
      setDragActive(false)
    }
  }

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault()
    e.stopPropagation()
    setDragActive(false)
    if (e.dataTransfer.files?.[0]) {
      setSelectedFile(e.dataTransfer.files[0])
    }
  }

  const handleFileChange = (event: React.ChangeEvent<HTMLInputElement>) => {
    if (event.target.files?.[0]) {
      setSelectedFile(event.target.files[0])
    }
  }

  const handleSubmit = async () => {
    if (!selectedFile) return
    await onUpload(selectedFile.name, selectedFile)
    setSelectedFile(null)
  }

  return (
    <div className="dashboard-page bg-gray-light pb-0">
      <header className="dashboard-header border-b">
        <div className="search-bar">
          <span className="icon">🔍</span>
          <input type="text" placeholder="Tìm bài giảng, môn học, ghi chú..." />
        </div>
        <div className="header-actions">
          <button type="button" className="icon-btn" aria-label="Thông báo">🔔</button>
          <div className="user-avatar-small">{userName.trim()[0]?.toUpperCase() || 'A'}</div>
        </div>
      </header>

      <div className="upload-container">
        <div className="upload-content">
          <h1 className="upload-welcome">Chào mừng trở lại, {userName}!</h1>
          <h2 className="upload-title">Tải lên file âm thanh của bạn</h2>

          <div
            className={`upload-dropzone ${dragActive ? 'active' : ''} ${selectedFile ? 'has-file' : ''}`}
            onDragEnter={handleDrag}
            onDragLeave={handleDrag}
            onDragOver={handleDrag}
            onDrop={handleDrop}
            onClick={() => fileInputRef.current?.click()}
            onKeyDown={(event) => {
              if (event.key === 'Enter' || event.key === ' ') {
                fileInputRef.current?.click()
              }
            }}
            role="button"
            tabIndex={0}
          >
            <div className="upload-icon">📁</div>
            <p className="upload-text">
              {selectedFile ? selectedFile.name : 'Kéo thả file vào đây hoặc Chọn file'}
            </p>
            <p className="upload-subtext">Định dạng hỗ trợ: .mp3, .wav, .m4a</p>
            <input
              ref={fileInputRef}
              className="sr-only"
              type="file"
              accept="audio/*"
              data-testid="e2e-upload-input"
              onChange={handleFileChange}
              disabled={disabled}
            />
          </div>

          <div className="upload-form">
            <div className="form-group">
              <label htmlFor="upload-subject">Môn học</label>
              <select id="upload-subject" value={subject} onChange={(e) => setSubject(e.target.value)} disabled={disabled}>
                <option value="">Chọn môn học (tuỳ chọn)</option>
                <option value="Trí tuệ nhân tạo">Trí tuệ nhân tạo</option>
                <option value="Toán rời rạc">Toán rời rạc</option>
                <option value="Lập trình web">Lập trình web</option>
              </select>
            </div>

            <div className="form-group">
              <label htmlFor="upload-language">Ngôn ngữ</label>
              <select
                id="upload-language"
                value={uploadLanguage}
                data-testid="e2e-upload-language-select"
                onChange={(e) => onUploadLanguageChange(e.target.value as RealtimeLanguage)}
                disabled={disabled}
              >
                <option value="vi">Tiếng Việt</option>
                <option value="en">Tiếng Anh</option>
                <option value="multi">Việt + Anh</option>
              </select>
            </div>
          </div>

          <p className="status-line upload-status-line" data-testid="e2e-status">
            <span>Trạng thái</span>
            <span className={getStatusBadgeClass(status)}>{status}</span>
          </p>

          {duplicateNotice && (
            <div className="ui-state ui-state--empty" data-testid="duplicate-upload-banner" style={{ marginBottom: '12px' }}>
              <p>{duplicateNotice}</p>
            </div>
          )}

          {errorMessage && <ErrorState message={errorMessage} title="Lỗi xử lý" />}

          <div className="upload-actions-row">
            <button
              type="button"
              className="btn-primary form-submit"
              data-testid="e2e-process-submit"
              onClick={handleSubmit}
              disabled={disabled || !selectedFile}
            >
              Phân tích file
            </button>
            {disabled && onCancel && (
              <button type="button" className="btn-secondary form-submit" onClick={onCancel}>
                Hủy xử lý
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}
