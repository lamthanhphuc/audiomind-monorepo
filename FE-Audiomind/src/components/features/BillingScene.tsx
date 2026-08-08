import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  checkoutSubscriptionPlan,
  formatCharsShort,
  formatDurationShort,
  formatQuotaPercent,
  getBillingOverview,
  pollBillingActivation,
  type BillingOverview,
  type SubscriptionPlan,
} from '../../services/billing'
import { getJwtPlan, getJwtRole } from '../../services/auth'
import { normalizePlanCode } from '../../utils/planCapabilities'
import { LoadingState } from '../ui/LoadingState'
import { formatInvoiceStatus } from '../../utils/uiLabels'
import { cssVars } from '../../utils/cssVars'
import './billing-scene.css'

type Props = {
  paymentNotice?: string | null
  activationOrderCode?: number | null
  onActivationHandled?: () => void
  onRefreshTokenHint?: () => void
  payosEnabled?: boolean
  onCheckoutRedirect?: (checkoutUrl: string) => void
}

const planLabel = (plan: string): string => {
  const normalized = normalizePlanCode(plan)
  if (normalized === 'STANDARD') return 'Standard'
  if (normalized === 'PREMIUM') return 'Premium'
  if (normalized === 'FREE') return 'Free'
  return normalized
}

const formatPlanPrice = (plan: SubscriptionPlan): string => (
  plan.priceVnd <= 0
    ? '0đ/tháng'
    : `${plan.priceVnd.toLocaleString('vi-VN')}đ/${plan.billingPeriod === 'YEARLY' ? 'năm' : 'tháng'}`
)

const fallbackPlansFromOverview = (overview: BillingOverview | null): SubscriptionPlan[] => {
  if (!overview) return []
  const currentPlan = normalizePlanCode(overview.plan)
  const sttMinutes = Math.round((overview.quota?.sttSecondsLimit ?? 0) / 60)
  const aiLimit = overview.quota?.geminiInputCharsLimit ?? 0
  const freePlan: SubscriptionPlan = {
    id: 0,
    code: 'FREE',
    name: 'Free',
    description: null,
    priceVnd: 0,
    currency: 'VND',
    billingPeriod: 'MONTHLY',
    advertisementEnabled: true,
    recordingMinutesLimit: currentPlan === 'FREE' ? sttMinutes : 0,
    aiAnalysisLimit: currentPlan === 'FREE' ? aiLimit : 0,
    uploadLimit: 0,
    flashcardLimit: 0,
    quizLimit: 0,
    mindmapLimit: 0,
    exportLimit: 0,
    featuresJson: null,
    active: true,
    sortOrder: 10,
  }
  const plans: SubscriptionPlan[] = [freePlan]
  if ((overview.standardPriceVnd ?? overview.proPriceVnd ?? 0) > 0) {
    plans.push({
      ...freePlan,
      id: 1,
      code: 'STANDARD',
      name: 'Standard',
      priceVnd: overview.standardPriceVnd ?? overview.proPriceVnd ?? 0,
      advertisementEnabled: false,
      recordingMinutesLimit: currentPlan === 'STANDARD' ? sttMinutes : 0,
      aiAnalysisLimit: currentPlan === 'STANDARD' ? aiLimit : 0,
      sortOrder: 20,
    })
  }
  if ((overview.premiumPriceVnd ?? 0) > 0) {
    plans.push({
      ...freePlan,
      id: 2,
      code: 'PREMIUM',
      name: 'Premium',
      priceVnd: overview.premiumPriceVnd ?? 0,
      advertisementEnabled: false,
      recordingMinutesLimit: currentPlan === 'PREMIUM' ? sttMinutes : 0,
      aiAnalysisLimit: currentPlan === 'PREMIUM' ? aiLimit : 0,
      sortOrder: 30,
    })
  }
  return plans
}

export default function BillingScene({
  paymentNotice,
  activationOrderCode = null,
  onActivationHandled,
  onRefreshTokenHint,
  payosEnabled = true,
  onCheckoutRedirect = (checkoutUrl) => window.location.assign(checkoutUrl),
}: Props) {
  const [overview, setOverview] = useState<BillingOverview | null>(null)
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState(paymentNotice || '')

  const jwtPlan = getJwtPlan()
  const role = getJwtRole()

  const load = useCallback(async () => {
    setLoading(true)
    setError('')
    try {
      setOverview(await getBillingOverview())
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Không tải được thông tin gói')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  useEffect(() => {
    if (paymentNotice) setNotice(paymentNotice)
  }, [paymentNotice])

  useEffect(() => {
    if (!activationOrderCode || activationOrderCode <= 0) {
      return undefined
    }

    let active = true
    void pollBillingActivation(activationOrderCode)
      .then(({ invoice, overview }) => {
        if (!active) return
        if (invoice.status === 'PAID') {
          setNotice(`Thanh toán PayOS thành công. Gói ${planLabel(overview.plan)} đã được kích hoạt.`)
          return
        }
        setNotice('Thanh toán đã ghi nhận nhưng gói chưa đồng bộ. Bấm "Đồng bộ JWT" hoặc chờ vài giây rồi tải lại trang.')
      })
      .catch(() => {
        if (!active) return
        setNotice('Thanh toán thành công. Gói đã cập nhật trên server — bấm "Đồng bộ JWT" nếu badge vẫn hiện Free.')
      })
      .finally(() => {
        if (active) {
          onActivationHandled?.()
        }
      })

    return () => {
      active = false
    }
  }, [activationOrderCode, onActivationHandled])

  const quota = overview?.quota
  const sttPercent = formatQuotaPercent(quota?.sttSecondsUsed ?? 0, quota?.sttSecondsLimit ?? 0)
  const geminiPercent = formatQuotaPercent(quota?.geminiInputCharsUsed ?? 0, quota?.geminiInputCharsLimit ?? 0)
  const currentPlanCode = normalizePlanCode(overview?.plan || jwtPlan || 'FREE')
  const isPremium = currentPlanCode === 'PREMIUM'
  const trialActive = overview?.trialActive === true
  const advertisementEnabled = overview?.advertisementEnabled ?? currentPlanCode === 'FREE'
  const payosCheckoutEnabled = payosEnabled && (overview?.payosEnabled ?? true)
  const plans = (overview?.plans?.length ?? 0) > 0 ? overview?.plans ?? [] : fallbackPlansFromOverview(overview)
  const standardPlan = plans.find((plan) => normalizePlanCode(plan.code) === 'STANDARD')
  const premiumPlan = plans.find((plan) => normalizePlanCode(plan.code) === 'PREMIUM')
  const primaryUpgradePlan = currentPlanCode === 'FREE'
    ? standardPlan
    : currentPlanCode === 'STANDARD'
      ? (trialActive ? standardPlan : premiumPlan)
      : undefined

  const quotaWarnings = useMemo(() => {
    const warnings: string[] = []
    if (sttPercent >= 90) warnings.push('STT gần hết quota tháng này.')
    if (geminiPercent >= 90) warnings.push('Phân tích AI gần hết quota tháng này.')
    return warnings
  }, [sttPercent, geminiPercent])

  const handleCheckout = async (planCode: string) => {
    setBusy(true)
    setError('')
    setNotice('')
    try {
      const checkout = await checkoutSubscriptionPlan(normalizePlanCode(planCode))
      if (!checkout.checkoutUrl) {
        throw new Error('PayOS chưa trả về link thanh toán')
      }
      onCheckoutRedirect(checkout.checkoutUrl)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Không tạo được link thanh toán')
    } finally {
      setBusy(false)
    }
  }

  return (
    <section className="feature-scene billing-scene" data-testid="billing-scene">
      <header className="billing-scene__hero">
        <div>
          <p className="billing-scene__eyebrow">Gói & thanh toán</p>
          <h1>Gói {planLabel(overview?.plan || jwtPlan || 'FREE')}{trialActive ? ' (dùng thử)' : ''}</h1>
          <p className="billing-scene__subtitle">
              {trialActive
              ? 'Bạn đang dùng thử gói Standard miễn phí. Sau khi hết hạn, tài khoản sẽ chuyển về Free nếu chưa thanh toán.'
              : 'Theo dõi quota ghi âm, phân tích AI, quảng cáo và nâng cấp gói qua PayOS khi cần.'}
          </p>
        </div>
        <div className="billing-scene__hero-actions">
          <button type="button" className="btn btn--secondary" onClick={() => void load()} disabled={loading || busy}>
            Làm mới
          </button>
          {!isPremium && primaryUpgradePlan && (
            <button
              type="button"
              className="btn btn--primary"
              onClick={() => void handleCheckout(primaryUpgradePlan.code)}
              disabled={busy || !payosCheckoutEnabled}
              title={!payosCheckoutEnabled ? 'Thanh toán PayOS chưa bật trên môi trường này' : undefined}
            >
              {busy ? 'Đang tạo link PayOS…' : `${trialActive ? 'Duy trì' : 'Nâng cấp'} ${primaryUpgradePlan.name} (${formatPlanPrice(primaryUpgradePlan)})`}
            </button>
          )}
        </div>
      </header>

      {!payosCheckoutEnabled && (
        <div className="billing-scene__notice billing-scene__notice--muted" data-testid="billing-payos-disabled">
          Thanh toán PayOS chưa bật trên môi trường này. Liên hệ admin để nâng cấp thủ công hoặc bật PAYOS_ENABLED trên server.
        </div>
      )}

      {trialActive && overview?.planExpiresAt && (
        <div className="billing-scene__notice" data-testid="billing-trial-notice">
          Gói Standard dùng thử đến {new Date(overview.planExpiresAt).toLocaleString('vi-VN')}.
        </div>
      )}
      {notice && <div className="billing-scene__notice" data-testid="billing-notice">{notice}</div>}
      {error && <div className="billing-scene__error" role="alert">{error}</div>}
      {quotaWarnings.map((warning) => (
        <div key={warning} className="billing-scene__warning">{warning}</div>
      ))}

      {loading ? (
        <LoadingState message="Đang tải quota và lịch sử thanh toán…" />
      ) : (
        <div className="billing-scene__grid">
          <article className="billing-card">
            <h2>Quota STT (tháng {quota?.periodYyyymm || '—'})</h2>
            <div className="billing-meter">
              <div
                className="billing-meter__bar"
                style={cssVars({ '--meter-fill': `${sttPercent}%` })}
                data-risk={sttPercent >= 90 ? 'high' : 'ok'}
              />
            </div>
            <p>
              Đã dùng {formatDurationShort(quota?.sttSecondsUsed ?? 0)}
              {' / '}
              {formatDurationShort(quota?.sttSecondsLimit ?? 0)}
              {' '}({sttPercent}%)
            </p>
          </article>

          <article className="billing-card">
            <h2>Quota phân tích AI</h2>
            <div className="billing-meter">
              <div
                className="billing-meter__bar"
                style={cssVars({ '--meter-fill': `${geminiPercent}%` })}
                data-risk={geminiPercent >= 90 ? 'high' : 'ok'}
              />
            </div>
            <p>
              Đã dùng {formatCharsShort(quota?.geminiInputCharsUsed ?? 0)} ký tự
              {' / '}
              {formatCharsShort(quota?.geminiInputCharsLimit ?? 0)}
              {' '}({geminiPercent}%)
            </p>
          </article>

          <article className="billing-card billing-card--wide">
            <h2>So sánh gói</h2>
            <p className="billing-plan-current">
              Plan hiện tại: <strong>{planLabel(overview?.plan || jwtPlan || 'FREE')}</strong>
              {' - '}
              {advertisementEnabled ? 'Ads enabled' : 'Ad-free'}
            </p>
            <div className="billing-plans">
              {plans.map((plan) => {
                const active = currentPlanCode === normalizePlanCode(plan.code)
                return (
                  <div className={`billing-plan ${active ? 'billing-plan--active' : ''}`} key={plan.id || plan.code}>
                    <strong>{plan.name}</strong>
                    <span>{formatPlanPrice(plan)}</span>
                    <span>{formatDurationShort(plan.recordingMinutesLimit * 60)} STT/tháng</span>
                    <span>{formatCharsShort(plan.aiAnalysisLimit)} ký tự phân tích/tháng</span>
                    <span>{plan.advertisementEnabled ? 'Có quảng cáo' : 'Không quảng cáo'}</span>
                    {plan.uploadLimit > 0 && <span>{plan.uploadLimit} lượt upload</span>}
                    {plan.flashcardLimit > 0 && <span>{plan.flashcardLimit} flashcard</span>}
                    {plan.quizLimit > 0 && <span>{plan.quizLimit} quiz</span>}
                    {plan.mindmapLimit > 0 && <span>{plan.mindmapLimit} mindmap</span>}
                    {plan.exportLimit > 0 && <span>{plan.exportLimit} lượt export</span>}
                    {!active && plan.priceVnd > 0 && (
                      <button
                        type="button"
                        className="btn btn--secondary btn--block"
                        onClick={() => void handleCheckout(plan.code)}
                        disabled={busy || !payosCheckoutEnabled}
                      >
                        {busy ? 'Đang tạo link PayOS…' : `Chọn ${plan.name}`}
                      </button>
                    )}
                  </div>
                )
              })}
            </div>
            {jwtPlan !== (overview?.plan || 'FREE').toUpperCase() && onRefreshTokenHint && (
              <p className="billing-scene__hint">
                JWT vẫn hiển thị {planLabel(jwtPlan)} trong khi server đã là {planLabel(overview?.plan || 'FREE')}.
                <button type="button" className="linkish" onClick={onRefreshTokenHint}>Đồng bộ JWT</button>
              </p>
            )}
          </article>

          <article className="billing-card billing-card--wide">
            <h2>Lịch sử thanh toán</h2>
            {!overview?.invoices?.length ? (
              <p className="billing-scene__empty">Chưa có hóa đơn.</p>
            ) : (
              <ul className="billing-invoice-list">
                {overview.invoices.map((invoice) => (
                  <li key={invoice.orderCode}>
                    <div>
                      <strong>#{invoice.orderCode}</strong>
                      <span>{invoice.description || `AudioMind ${planLabel(invoice.planCode || '')}`}</span>
                    </div>
                    <div className="billing-invoice-list__meta">
                      <span className={`billing-status billing-status--${invoice.status.toLowerCase()}`}>
                        {formatInvoiceStatus(invoice.status)}
                      </span>
                      <span>{invoice.amountVnd.toLocaleString('vi-VN')}đ</span>
                      {invoice.status === 'PENDING' && invoice.checkoutUrl && (
                        <a href={invoice.checkoutUrl} target="_blank" rel="noreferrer">Tiếp tục thanh toán</a>
                      )}
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </article>

          {role === 'ADMIN' && (
            <article className="billing-card billing-card--wide billing-card--admin">
              <h2>Công cụ quản trị</h2>
              <p>
                Dùng API admin để đổi plan/role hoặc mark paid thủ công:
                {' '}
                <code>POST /api/admin/billing/manual-paid</code>
              </p>
            </article>
          )}
        </div>
      )}
    </section>
  )
}
