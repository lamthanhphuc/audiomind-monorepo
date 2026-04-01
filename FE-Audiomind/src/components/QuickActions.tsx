import { useRef } from 'react'

type QuickActionsProps = {
  disabled?: boolean
  meetingReady: boolean
  onUpload: (title: string, file: File) => Promise<void>
  onStartProcessing: () => Promise<void>
}

const actions = [
  'Thẻ ghi nhớ',
  'Ôn tập nhanh',
  'Ghi chú',
  'Thi thử',
  'Biểu đồ',
  'Ghép cặp',
]

export default function QuickActions({
  disabled,
  meetingReady,
  onUpload,
  onStartProcessing,
}: QuickActionsProps) {
  const fileInputRef = useRef<HTMLInputElement | null>(null)

  const handleUploadClick = () => {
    fileInputRef.current?.click()
  }

  const handleFileChange = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0]
    if (!file) return
    const title = window.prompt('Nhập tiêu đề buổi ghi âm', file.name) || file.name
    await onUpload(title, file)
    event.target.value = ''
  }

  return (
    <section className="quick-actions">
      <button
        className="quick-actions__upload"
        type="button"
        onClick={handleUploadClick}
        disabled={disabled}
      >
        <span className="upload-icon">▶</span>
        File ghi âm
      </button>
      <input
        ref={fileInputRef}
        className="sr-only"
        type="file"
        accept="audio/*"
        onChange={handleFileChange}
      />

      <div className="quick-actions__grid">
        {actions.map((item) => (
          <button
            key={item}
            className={`pill-button ${item === 'Biểu đồ' ? 'pill-button--active' : ''}`}
            type="button"
            disabled={disabled || (item === 'Biểu đồ' && !meetingReady)}
            onClick={item === 'Biểu đồ' ? onStartProcessing : undefined}
          >
            {item}
          </button>
        ))}
      </div>
    </section>
  )
}
