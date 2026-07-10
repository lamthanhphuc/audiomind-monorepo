import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  checkoutProPlan,
  formatCharsShort,
  formatDurationShort,
  formatQuotaPercent,
  getBillingOverview,
  pollBillingActivation,
  type BillingOverview,
} from '../../services/billing'
import { getJwtPlan, getJwtRole } from '../../services/auth'
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

const planLabel = (plan: string): string => (plan.toUpperCase() === 'PRO' ? 'Pro' : 'Free')

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
        if (invoice.status === 'PAID' || overview.plan.toUpperCase() === 'PRO') {
          setNotice('Thanh toán PayOS thành công. Gói Pro đã được kích hoạt.')
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
  const isPro = (overview?.plan || jwtPlan || 'FREE').toUpperCase() === 'PRO'
  const trialActive = overview?.trialActive === true
  const proPriceVnd = overview?.proPriceVnd ?? 79_000
  const payosCheckoutEnabled = payosEnabled && (overview?.payosEnabled ?? true)

  const quotaWarnings = useMemo(() => {
    const warnings: string[] = []
    if (sttPercent >= 90) warnings.push('STT gần hết quota tháng này.')
    if (geminiPercent >= 90) warnings.push('Phân tích AI gần hết quota tháng này.')
    return warnings
  }, [sttPercent, geminiPercent])

  const handleUpgrade = async () => {
    setBusy(true)
    setError('')
    setNotice('')
    try {
      const checkout = await checkoutProPlan()
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
              ? 'Bạn đang dùng thử gói Pro miễn phí. Sau khi hết hạn, tài khoản sẽ chuyển về Free trừ khi bạn nâng cấp qua PayOS.'
              : 'Theo dõi quota ghi âm và phân tích AI, nâng cấp Pro qua PayOS, hoặc liên hệ quản trị viên để thanh toán thủ công.'}
          </p>
        </div>
        <div className="billing-scene__hero-actions">
          <button type="button" className="btn btn--secondary" onClick={() => void load()} disabled={loading || busy}>
            Làm mới
          </button>
          {(!isPro || trialActive) && payosCheckoutEnabled && (
            <button
              type="button"
              className="btn btn--primary"
              onClick={() => void handleUpgrade()}
              disabled={busy || !payosCheckoutEnabled}
              title={!payosCheckoutEnabled ? 'Thanh toán PayOS chưa bật trên môi trường này' : undefined}
            >
              {busy ? 'Đang tạo link PayOS…' : `Nâng cấp Pro (${proPriceVnd.toLocaleString('vi-VN')}đ)`}
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
          Gói Pro dùng thử đến {new Date(overview.planExpiresAt).toLocaleString('vi-VN')}.
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
            <div className="billing-plans">
              <div className={`billing-plan ${!isPro ? 'billing-plan--active' : ''}`}>
                <strong>Free</strong>
                <span>~10 phút STT/tháng</span>
                <span>~50K ký tự phân tích/tháng</span>
              </div>
              <div className={`billing-plan ${isPro ? 'billing-plan--active' : ''}`}>
                <strong>Pro</strong>
                <span>~10 giờ STT/tháng</span>
                <span>~2M ký tự phân tích/tháng</span>
                <span>{proPriceVnd.toLocaleString('vi-VN')}đ/tháng qua PayOS</span>
              </div>
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
                      <span>{invoice.description || 'Audiomind PRO'}</span>
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
