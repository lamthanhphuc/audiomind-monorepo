import {
  TAB_CAPTURE_GUIDE_STEPS,
  TAB_WITH_MIC_HEADPHONE_NOTE,
  TAB_WITH_MIC_QUOTA_NOTE,
  RECORDING_SOURCE_DESCRIPTIONS,
  RECORDING_SOURCE_ICONS,
  RECORDING_SOURCE_LABELS,
  RECORDING_SOURCES,
  type RecordingSource,
  isBrowserTabRecordingSource,
} from '../../constants/recordingSource'
import './RecordingSourceSelector.css'

type RecordingSourceSelectorProps = {
  value: RecordingSource
  disabled?: boolean
  onChange: (source: RecordingSource) => void
  showDualStreamQuotaNote?: boolean
}

export function RecordingSourceSelector({
  value,
  disabled = false,
  onChange,
  showDualStreamQuotaNote = false,
}: RecordingSourceSelectorProps) {
  const showTabGuide = isBrowserTabRecordingSource(value)
  const showHeadphoneNote = value === 'browser_tab_with_mic'
  const showQuotaNote = showDualStreamQuotaNote && value === 'browser_tab_with_mic'

  return (
    <div className="recording-source-selector" data-testid="recording-source-selector">
      <p className="recording-source-selector__label" id="recording-source-label">
        Nguồn ghi âm
      </p>

      <div
        className="recording-source-selector__options"
        role="radiogroup"
        aria-labelledby="recording-source-label"
      >
        {RECORDING_SOURCES.map((source) => {
          const selected = value === source
          return (
            <button
              key={source}
              type="button"
              role="radio"
              aria-checked={selected}
              disabled={disabled}
              className={`recording-source-card ${selected ? 'recording-source-card--selected' : ''}`}
              data-testid={`recording-source-option-${source}`}
              onClick={() => {
                if (!disabled && source !== value) {
                  onChange(source)
                }
              }}
            >
              <span className="recording-source-card__check" aria-hidden="true">
                ✓
              </span>
              <span className="recording-source-card__header">
                <span className="recording-source-card__icon" aria-hidden="true">
                  {RECORDING_SOURCE_ICONS[source]}
                </span>
                <span className="recording-source-card__text">
                  <span className="recording-source-card__title">
                    {RECORDING_SOURCE_LABELS[source]}
                  </span>
                  <span className="recording-source-card__description">
                    {RECORDING_SOURCE_DESCRIPTIONS[source]}
                  </span>
                </span>
              </span>
            </button>
          )
        })}
      </div>

      {showTabGuide && (
        <div className="recording-source-guide" role="note" data-testid="recording-source-tab-guide">
          <p className="recording-source-guide__title">Hướng dẫn ghi âm tab trình duyệt</p>
          <ol className="recording-source-guide__list">
            {TAB_CAPTURE_GUIDE_STEPS.map((step) => (
              <li key={step}>{step}</li>
            ))}
          </ol>
          <p className="recording-source-guide__note">
            Hãy chọn tab đang phát âm thanh (Meet, Teams, YouTube, v.v.), bật &quot;Chia sẻ âm thanh tab&quot;,
            và có thể tắt loa/mute mic — âm thanh tab vẫn được ghi trực tiếp.
          </p>
          {showHeadphoneNote && (
            <p className="recording-source-guide__note">{TAB_WITH_MIC_HEADPHONE_NOTE}</p>
          )}
          {showQuotaNote && (
            <p className="recording-source-guide__quota" data-testid="recording-source-quota-note">
              {TAB_WITH_MIC_QUOTA_NOTE}
            </p>
          )}
        </div>
      )}
    </div>
  )
}
