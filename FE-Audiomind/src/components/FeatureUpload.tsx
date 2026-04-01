import { useRef, useState } from 'react'

type FeatureUploadProps = {
  disabled?: boolean
  onUpload: (title: string, file: File) => Promise<void>
}

export default function FeatureUpload({ disabled, onUpload }: FeatureUploadProps) {
  const fileInputRef = useRef<HTMLInputElement | null>(null)
  const [dragActive, setDragActive] = useState(false)
  const [subject, setSubject] = useState('')
  const [language, setLanguage] = useState('vi')
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
    if (e.dataTransfer.files && e.dataTransfer.files[0]) {
      setSelectedFile(e.dataTransfer.files[0])
    }
  }

  const handleFileChange = (event: React.ChangeEvent<HTMLInputElement>) => {
    if (event.target.files && event.target.files[0]) {
      setSelectedFile(event.target.files[0])
    }
  }

  const handleSubmit = async () => {
    if (!selectedFile) return
    const title = selectedFile.name
    await onUpload(title, selectedFile)
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
          <button className="icon-btn">🔔</button>
          <div className="user-avatar-small">J</div>
        </div>
      </header>

      <div className="upload-container">
        <div className="upload-content">
          <h1 className="upload-welcome">Chào mừng trở lại, John!</h1>
          <h2 className="upload-title">Tải lên file âm thanh của bạn</h2>

          <div 
            className={`upload-dropzone ${dragActive ? 'active' : ''} ${selectedFile ? 'has-file' : ''}`}
            onDragEnter={handleDrag}
            onDragLeave={handleDrag}
            onDragOver={handleDrag}
            onDrop={handleDrop}
            onClick={() => fileInputRef.current?.click()}
          >
            <div className="upload-icon">📁</div>
            <p className="upload-text">
              {selectedFile ? selectedFile.name : 'Kéo thả file vào đây hoặc Chọn file'}
            </p>
            <p className="upload-subtext">Định dạng hỗ trợ: .mp3, .wav, .m4a. Dung lượng tối đa: 500MB</p>
            <input
              ref={fileInputRef}
              className="sr-only"
              type="file"
              accept="audio/*"
              onChange={handleFileChange}
              style={{ display: 'none' }}
            />
          </div>

          <div className="upload-form">
            <div className="form-group">
              <label>Môn học</label>
              <select value={subject} onChange={(e) => setSubject(e.target.value)}>
                <option value="">Chọn môn học</option>
                <option value="Trí tuệ nhân tạo">Trí tuệ nhân tạo</option>
                <option value="Toán rời rạc">Toán rời rạc</option>
                <option value="Lập trình web">Lập trình web</option>
              </select>
            </div>
            
            <div className="form-group">
              <label>Ngôn ngữ</label>
              <select value={language} onChange={(e) => setLanguage(e.target.value)}>
                <option value="vi">Tiếng Việt</option>
                <option value="en">Tiếng Anh</option>
              </select>
            </div>
          </div>

          <button 
            className="btn-primary form-submit"
            onClick={handleSubmit}
            disabled={disabled || !selectedFile}
          >
            Phân tích file
          </button>
        </div>
      </div>
    </div>
  )
}
