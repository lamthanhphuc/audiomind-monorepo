import { useState } from 'react'
import { Bug, RotateCcw, Save } from 'lucide-react'
import { DOMAIN_MODE_OPTIONS, type DomainMode } from '../../constants/domainMode'
import { normalizeRealtimeLanguage, normalizeRealtimeSpeakerMode, type RealtimeLanguage, type RealtimeSpeakerMode } from '../../hooks/useRealtimeMeetingStream'
import { normalizeMicSensitivityMode, type MicSensitivityMode } from '../../hooks/useVoiceActivityDetection'
import { resetOnboarding } from '../../utils/userPreferences'
import type { ThemeMode } from '../../utils/themeMode'
import './account-scenes.css'

type UploadLanguage = 'vi' | 'en' | 'multi'

type Props = {
  theme: ThemeMode
  role?: string
  uploadLanguage: UploadLanguage
  realtimeLanguage: RealtimeLanguage
  domainMode: DomainMode
  realtimeSpeakerMode: RealtimeSpeakerMode
  micSensitivity: MicSensitivityMode
  noiseSuppressionEnabled: boolean
  noiseSuppressionSupported: boolean
  onToggleTheme: () => void
  onUploadLanguageChange: (language: UploadLanguage) => void
  onRealtimeLanguageChange: (language: RealtimeLanguage) => void
  onDomainModeChange: (mode: DomainMode) => void
  onRealtimeSpeakerModeChange: (mode: RealtimeSpeakerMode) => void
  onMicSensitivityChange: (mode: MicSensitivityMode) => void
  onNoiseSuppressionChange: (enabled: boolean) => void
  onResetOnboarding: () => void
}

const languageLabel: Record<string, string> = {
  vi: 'Tiếng Việt',
  en: 'Tiếng Anh',
  multi: 'Tự nhận diện',
}

export default function SettingsScene({
  theme,
  role = 'USER',
  uploadLanguage,
  realtimeLanguage,
  domainMode,
  realtimeSpeakerMode,
  micSensitivity,
  noiseSuppressionEnabled,
  noiseSuppressionSupported,
  onToggleTheme,
  onUploadLanguageChange,
  onRealtimeLanguageChange,
  onDomainModeChange,
  onRealtimeSpeakerModeChange,
  onMicSensitivityChange,
  onNoiseSuppressionChange,
  onResetOnboarding,
}: Props) {
  const [notice, setNotice] = useState('')
  const isAdmin = role.toUpperCase() === 'ADMIN'
  const debugEnabled = localStorage.getItem('audiomind.debug_ui') === '1'

  const updateDebug = (enabled: boolean) => {
    localStorage.setItem('audiomind.debug_ui', enabled ? '1' : '0')
    setNotice(enabled ? 'Đã bật debug UI cục bộ.' : 'Đã tắt debug UI cục bộ.')
  }

  const handleResetOnboarding = () => {
    resetOnboarding()
    onResetOnboarding()
    setNotice('Đã đặt lại onboarding. Màn hướng dẫn sẽ hiện ở lần vào Upload tiếp theo.')
  }

  return (
    <section className="feature-scene account-scene" data-testid="settings-scene">
      <header className="account-scene__hero">
        <div>
          <p className="account-scene__eyebrow">Cài đặt</p>
          <h1>Tùy chọn trải nghiệm</h1>
          <p className="account-scene__subtitle">Gom các preference đang rải rác thành một nơi để cấu hình nhanh.</p>
        </div>
        <span className="account-badge"><Save size={14} aria-hidden /> Tự lưu</span>
      </header>

      {notice && <div className="account-notice" role="status">{notice}</div>}

      <div className="account-grid">
        <article className="account-card">
          <h2>Giao diện</h2>
          <div className="account-setting">
            <div>
              <div className="account-value">Chế độ màu</div>
              <div className="account-label">{theme === 'night' ? 'Đang dùng chế độ tối' : 'Đang dùng chế độ sáng'}</div>
            </div>
            <button type="button" className="btn btn--secondary" onClick={onToggleTheme}>
              {theme === 'night' ? 'Chế độ sáng' : 'Chế độ tối'}
            </button>
          </div>
        </article>

        <article className="account-card">
          <h2>Ngôn ngữ mặc định</h2>
          <label className="account-setting">
            <span>Upload</span>
            <select
              className="account-select"
              value={uploadLanguage}
              onChange={(event) => onUploadLanguageChange(event.target.value as UploadLanguage)}
            >
              <option value="vi">{languageLabel.vi}</option>
              <option value="en">{languageLabel.en}</option>
              <option value="multi">{languageLabel.multi}</option>
            </select>
          </label>
          <label className="account-setting">
            <span>Realtime</span>
            <select
              className="account-select"
              value={realtimeLanguage}
              onChange={(event) => onRealtimeLanguageChange(normalizeRealtimeLanguage(event.target.value))}
            >
              <option value="vi">{languageLabel.vi}</option>
              <option value="en">{languageLabel.en}</option>
              <option value="multi">{languageLabel.multi}</option>
            </select>
          </label>
        </article>

        <article className="account-card">
          <h2>Domain mặc định</h2>
          <label className="account-setting">
            <span>Ngữ cảnh phân tích</span>
            <select
              className="account-select"
              value={domainMode}
              onChange={(event) => onDomainModeChange(event.target.value as DomainMode)}
            >
              {DOMAIN_MODE_OPTIONS.map((option) => (
                <option key={option.value} value={option.value}>{option.label}</option>
              ))}
            </select>
          </label>
          <p className="account-muted">
            Domain này được dùng cho upload, realtime và phân tích lại khi người dùng không chọn riêng.
          </p>
        </article>

        <article className="account-card">
          <h2>Realtime defaults</h2>
          <label className="account-setting">
            <span>Speaker mode</span>
            <select
              className="account-select"
              value={realtimeSpeakerMode}
              onChange={(event) => onRealtimeSpeakerModeChange(normalizeRealtimeSpeakerMode(event.target.value))}
            >
              <option value="single">Một người nói</option>
              <option value="multiple">Nhiều người nói</option>
            </select>
          </label>
          <label className="account-setting">
            <span>Mic sensitivity</span>
            <select
              className="account-select"
              value={micSensitivity}
              onChange={(event) => onMicSensitivityChange(normalizeMicSensitivityMode(event.target.value))}
            >
              <option value="high">Nhạy hơn</option>
              <option value="normal">Cân bằng</option>
              <option value="low">Giảm nhiễu mạnh</option>
            </select>
          </label>
          <label className="account-setting">
            <span>Noise suppression</span>
            <input
              type="checkbox"
              checked={noiseSuppressionEnabled}
              disabled={!noiseSuppressionSupported}
              onChange={(event) => onNoiseSuppressionChange(event.target.checked)}
            />
          </label>
        </article>

        <article className="account-card">
          <h2>Onboarding</h2>
          <div className="account-setting">
            <span>Hiện lại hướng dẫn upload</span>
            <button type="button" className="btn btn--secondary" onClick={handleResetOnboarding}>
              <RotateCcw size={16} aria-hidden /> Reset
            </button>
          </div>
        </article>

        {(isAdmin || import.meta.env.DEV) && (
          <article className="account-card">
            <h2><Bug size={18} aria-hidden /> Debug flags</h2>
            <label className="account-setting">
              <span>Debug UI cục bộ</span>
              <input
                type="checkbox"
                checked={debugEnabled}
                onChange={(event) => updateDebug(event.target.checked)}
              />
            </label>
          </article>
        )}
      </div>
    </section>
  )
}
