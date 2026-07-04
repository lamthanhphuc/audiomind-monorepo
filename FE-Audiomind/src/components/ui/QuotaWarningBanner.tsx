import { resolveErrorPresentation } from '../../constants/errorCatalog'
import { ERROR_UX_ENABLED } from '../../services/config'

type QuotaWarningBannerProps = {
  sttPercent: number
  geminiPercent: number
  onNavigateBilling: () => void
}

export function QuotaWarningBanner({
  sttPercent,
  geminiPercent,
  onNavigateBilling,
}: QuotaWarningBannerProps) {
  const warnings: string[] = []
  if (sttPercent >= 90) {
    warnings.push('STT gần hết quota tháng này.')
  }
  if (geminiPercent >= 90) {
    warnings.push('Gemini analysis gần hết quota tháng này.')
  }
  if (warnings.length === 0) {
    return null
  }

  const ctaLabel = resolveErrorPresentation('QUOTA_EXCEEDED', '', ERROR_UX_ENABLED).ctaLabel
    || 'Xem gói & thanh toán'

  return (
    <div className="quota-warning-banner" data-testid="quota-warning-banner" role="status">
      <p>{warnings.join(' ')}</p>
      <button type="button" className="btn-secondary" onClick={onNavigateBilling}>
        {ctaLabel}
      </button>
    </div>
  )
}
