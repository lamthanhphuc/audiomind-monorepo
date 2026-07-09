import { resolveErrorPresentation } from '../../constants/errorCatalog'
import {
  TAB_WITH_MIC_QUOTA_NOTE,
  TAB_WITH_MIC_QUOTA_RECORDING_BADGE,
} from '../../constants/recordingSource'
import { ERROR_UX_ENABLED } from '../../services/config'
import './DualStreamQuotaInfoBanner.css'

type DualStreamQuotaInfoBannerProps = {
  visible: boolean
  isRecording?: boolean
  sttPercent?: number
  onNavigateBilling?: () => void
}

export function DualStreamQuotaInfoBanner({
  visible,
  isRecording = false,
  sttPercent,
  onNavigateBilling,
}: DualStreamQuotaInfoBannerProps) {
  if (!visible) {
    return null
  }

  const ctaLabel = resolveErrorPresentation('QUOTA_EXCEEDED', '', ERROR_UX_ENABLED).ctaLabel
    || 'Xem gói & hạn mức'

  return (
    <div
      className="dual-stream-quota-info"
      data-testid="dual-stream-quota-info"
      role="note"
    >
      <p className="dual-stream-quota-info__text">
        {isRecording ? TAB_WITH_MIC_QUOTA_RECORDING_BADGE : TAB_WITH_MIC_QUOTA_NOTE}
      </p>
      {typeof sttPercent === 'number' && sttPercent >= 70 && (
        <p className="dual-stream-quota-info__usage">
          Bạn đã dùng {Math.round(sttPercent)}% quota STT tháng này.
        </p>
      )}
      {onNavigateBilling && (
        <button type="button" className="btn btn--secondary btn--block" onClick={onNavigateBilling}>
          {ctaLabel}
        </button>
      )}
    </div>
  )
}
