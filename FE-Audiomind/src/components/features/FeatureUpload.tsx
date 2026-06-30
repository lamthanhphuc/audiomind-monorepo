import { useRef, useState } from 'react'
import type { RealtimeLanguage } from '../../hooks/useRealtimeMeetingStream'
import { useUpload } from '../../hooks/useUpload'
import type { DomainMode } from '../../constants/domainMode'
import DomainModeSelector from '../ui/DomainModeSelector'
import OnboardingTour from '../onboarding/OnboardingTour'
import { ErrorState } from '../ui/ErrorState'
import { getStatusBadgeClass } from '../../utils/statusBadge'
import { formatUploadStatus } from '../../utils/uiLabels'

type FeatureUploadProps = {
  disabled?: boolean
  userName?: string
  uploadLanguage: RealtimeLanguage
  onUploadLanguageChange: (language: RealtimeLanguage) => void
  domainMode: DomainMode
  onDomainModeChange: (mode: DomainMode) => void
  showOnboarding?: boolean
  onDismissOnboarding?: () => void
  onNavigateRealtime?: () => void
  onNavigateIntegrations?: () => void
  status?: string
  errorMessage?: string | null
  errorCode?: string
  onNavigateBilling?: () => void
  duplicateNotice?: string | null
  onUpload: (title: string, file: File) => Promise<void>
  onCancel?: () => void
}

export default function FeatureUpload({
  disabled,
  userName = 'bạn',
  uploadLanguage,
  onUploadLanguageChange,
  domainMode,
  onDomainModeChange,
  showOnboarding = false,
  onDismissOnboarding,
  onNavigateRealtime,
  onNavigateIntegrations,
  status = 'idle',
  errorMessage,
  errorCode,
  onNavigateBilling,
  duplicateNotice,
  onUpload,
  onCancel,
}: FeatureUploadProps) {
  const fileInputRef = useRef<HTMLInputElement | null>(null)
  const [dragActive, setDragActive] = useState(false)
  const [selectedFile, setSelectedFile] = useState<File | null>(null)
  const { supportedFormatsLabel, config } = useUpload()
  const acceptExtensions = config.allowedExtensions.join(',')

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
      <div className="upload-container">
        <div className="upload-content studio-reveal studio-reveal--delay-1">
          {showOnboarding && onDismissOnboarding && onNavigateRealtime && onNavigateIntegrations && (
            <OnboardingTour
              onNavigateUpload={() => undefined}
              onNavigateRealtime={onNavigateRealtime}
              onNavigateIntegrations={onNavigateIntegrations}
              onDismiss={onDismissOnboarding}
            />
          )}
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
            <p className="upload-subtext">{supportedFormatsLabel}</p>
            <input
              ref={fileInputRef}
              className="sr-only"
              type="file"
              accept={acceptExtensions}
              data-testid="e2e-upload-input"
              onChange={handleFileChange}
              disabled={disabled}
            />
          </div>

          <div className="upload-form">
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
            <DomainModeSelector
              id="upload-domain-mode"
              value={domainMode}
              onChange={onDomainModeChange}
              disabled={disabled}
              testId="e2e-upload-domain-mode-select"
            />
          </div>

          <p className="status-line upload-status-line" data-testid="e2e-status">
            <span>Trạng thái</span>
            <span className={getStatusBadgeClass(status)}>{formatUploadStatus(status)}</span>
          </p>

          {duplicateNotice && (
            <div className="ui-state ui-state--empty upload-selected-banner" data-testid="duplicate-upload-banner">
              <p className="upload-duplicate-notice">{duplicateNotice}</p>
            </div>
          )}

          {selectedFile && !disabled && (
            <div className="upload-selected-banner" data-testid="upload-selected-banner">
              Đã chọn: <strong>{selectedFile.name}</strong> — bấm &quot;Phân tích file&quot; để bắt đầu.
            </div>
          )}

          {errorMessage && (
            <ErrorState
              message={errorMessage}
              errorCode={errorCode}
              title="Lỗi xử lý"
              onCtaClick={onNavigateBilling}
            />
          )}

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
