import { useRef, useState } from 'react'
import type { RealtimeLanguage } from '../../hooks/useRealtimeMeetingStream'
import { useUpload } from '../../hooks/useUpload'
import type { DomainMode } from '../../constants/domainMode'
import DomainModeSelector from '../ui/DomainModeSelector'
import SubjectPicker from '../subjects/SubjectPicker'
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
  selectedSubjectId?: number | null
  onSubjectIdChange?: (subjectId: number | null) => void
  showOnboarding?: boolean
  onDismissOnboarding?: () => void
  onNavigateRealtime?: () => void
  status?: string
  errorMessage?: string | null
  errorCode?: string
  onNavigateBilling?: () => void
  duplicateNotice?: string | null
  lastMeetingId?: number | null
  onReanalyze?: () => void | Promise<void>
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
  selectedSubjectId = null,
  onSubjectIdChange,
  showOnboarding = false,
  onDismissOnboarding,
  onNavigateRealtime,
  status = 'idle',
  errorMessage,
  errorCode,
  onNavigateBilling,
  duplicateNotice,
  lastMeetingId = null,
  onReanalyze,
  onUpload,
  onCancel,
}: FeatureUploadProps) {
  const fileInputRef = useRef<HTMLInputElement | null>(null)
  const [dragActive, setDragActive] = useState(false)
  const [selectedFile, setSelectedFile] = useState<File | null>(null)
  const { supportedFormatsLabel, config } = useUpload()
  const acceptExtensions = config.allowedExtensions.join(',')
  const shouldShowStatus = status !== 'idle' || Boolean(errorMessage) || Boolean(duplicateNotice) || Boolean(disabled)
  const canReanalyze = status === 'failed'
    && Boolean(onReanalyze)
    && Number.isFinite(lastMeetingId)
    && (lastMeetingId ?? 0) > 0
    && errorCode !== 'QUOTA_EXCEEDED'

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
    <div className="dashboard-page pb-0">
      <div className="upload-container">
        <div className="upload-content studio-reveal studio-reveal--delay-1">
          {showOnboarding && onDismissOnboarding && onNavigateRealtime && (
            <OnboardingTour
              onNavigateUpload={() => undefined}
              onNavigateRealtime={onNavigateRealtime}
              onDismiss={onDismissOnboarding}
            />
          )}
          <div className="ui-section__header upload-head">
            <div>
              <p className="ui-section__eyebrow">Tạo phân tích mới</p>
              <h1 className="upload-welcome">Chào mừng trở lại, {userName}!</h1>
              <p className="upload-title">Chọn file âm thanh, kiểm tra tùy chọn và bắt đầu phân tích.</p>
            </div>
          </div>
          <div className="workflow-guide" aria-label="Hướng dẫn chọn luồng xử lý">
            <div>
              <strong>Upload file</strong>
              <span>Dùng khi bạn đã có bản ghi cuộc họp.</span>
            </div>
            <div>
              <strong>Ghi realtime</strong>
              <span>Dùng khi cuộc họp đang diễn ra và cần transcript trực tiếp.</span>
            </div>
            <div>
              <strong>Sau khi xử lý</strong>
              <span>Mở lịch sử để xem transcript, phân tích, chia sẻ hoặc xuất báo cáo.</span>
            </div>
          </div>
          <ol className="upload-steps" aria-label="Các bước xử lý file">
            <li className={`upload-step ${selectedFile ? 'upload-step--done' : 'upload-step--active'}`}>
              <span className="upload-step__index">1</span>
              <span>Chọn file</span>
            </li>
            <li className={`upload-step ${(uploadLanguage || domainMode) ? 'upload-step--active' : ''}`}>
              <span className="upload-step__index">2</span>
              <span>Chọn cấu hình</span>
            </li>
            <li className={`upload-step ${selectedFile && !disabled ? 'upload-step--active' : ''}`}>
              <span className="upload-step__index">3</span>
              <span>Bấm phân tích</span>
            </li>
          </ol>

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

          <section className="ui-section ui-section--subtle upload-options-panel">
            <div>
              <p className="ui-section__eyebrow">Tùy chọn</p>
              <h2 className="ui-section__title">Cấu hình phân tích</h2>
              <p className="ui-section__description">
                Giữ mặc định nếu bạn chỉ cần transcript và tóm tắt nhanh.
              </p>
            </div>
            <div className="upload-form ui-field-grid">
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
              {onSubjectIdChange ? (
                <div className="form-group">
                  <label htmlFor="upload-subject">Môn học (tuỳ chọn)</label>
                  <SubjectPicker
                    value={selectedSubjectId}
                    onChange={onSubjectIdChange}
                    disabled={disabled}
                    allowClear
                  />
                </div>
              ) : null}
            </div>
          </section>

          {shouldShowStatus && (
            <p className="ui-status-strip upload-status-line" data-testid="e2e-status">
              <span>Trạng thái</span>
              <span className={getStatusBadgeClass(status)}>{formatUploadStatus(status)}</span>
            </p>
          )}

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

          {canReanalyze && (
            <div className="upload-actions-row">
              <button
                type="button"
                className="btn btn--secondary btn--block form-submit"
                data-testid="upload-reanalyze-button"
                onClick={() => void onReanalyze?.()}
                disabled={disabled}
              >
                {disabled ? 'Đang phân tích lại…' : 'Phân tích lại'}
              </button>
            </div>
          )}

          <div className="upload-actions-row">
            <button
              type="button"
              className="btn btn--primary btn--block form-submit"
              data-testid="e2e-process-submit"
              onClick={handleSubmit}
              disabled={disabled || !selectedFile}
            >
              Phân tích file
            </button>
            {disabled && onCancel && (
              <button type="button" className="btn btn--secondary btn--block form-submit" onClick={onCancel}>
                Hủy xử lý
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}
