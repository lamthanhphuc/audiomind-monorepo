import { useCallback, useEffect, useMemo, useState } from 'react'
import { BarChart3, RefreshCw } from 'lucide-react'
import { formatCharsShort, formatDurationShort, formatQuotaPercent } from '../../services/billing'
import { getUsageDetail, type UsageDetail } from '../../services/usage'
import { LoadingState } from '../ui/LoadingState'
import { cssVars } from '../../utils/cssVars'
import './account-scenes.css'

export default function UsageScene() {
  const [detail, setDetail] = useState<UsageDetail | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')

  const load = useCallback(async () => {
    setLoading(true)
    setError('')
    try {
      setDetail(await getUsageDetail(30))
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Không tải được chi tiết sử dụng')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  const quota = detail?.snapshot
  const sttPercent = formatQuotaPercent(quota?.sttSecondsUsed ?? 0, quota?.sttSecondsLimit ?? 0)
  const geminiPercent = formatQuotaPercent(quota?.geminiInputCharsUsed ?? 0, quota?.geminiInputCharsLimit ?? 0)
  const blockReasons = useMemo(() => {
    const reasons: string[] = []
    if (quota && quota.sttSecondsLimit > 0 && quota.sttSecondsUsed >= quota.sttSecondsLimit) {
      reasons.push('STT đã chạm giới hạn tháng hiện tại.')
    }
    if (quota && quota.geminiInputCharsLimit > 0 && quota.geminiInputCharsUsed >= quota.geminiInputCharsLimit) {
      reasons.push('Ký tự phân tích AI đã chạm giới hạn tháng hiện tại.')
    }
    return reasons
  }, [quota])

  return (
    <section className="feature-scene account-scene" data-testid="usage-scene">
      <header className="account-scene__hero">
        <div>
          <p className="account-scene__eyebrow">Usage / Quota</p>
          <h1>Chi tiết sử dụng</h1>
          <p className="account-scene__subtitle">Số liệu STT, Gemini và lịch sử theo ngày từ quota ledger.</p>
        </div>
        <button type="button" className="btn btn--secondary" onClick={() => void load()} disabled={loading}>
          <RefreshCw size={16} aria-hidden /> Làm mới
        </button>
      </header>

      {error && <div className="account-error" role="alert">{error}</div>}

      {loading ? (
        <LoadingState message="Đang tải chi tiết sử dụng..." />
      ) : (
        <div className="account-grid">
          <article className="account-card">
            <h2><BarChart3 size={18} aria-hidden /> STT</h2>
            <div className="account-meter">
              <div className="account-meter__bar" style={cssVars({ '--meter-fill': `${sttPercent}%` })} />
            </div>
            <p>{formatDurationShort(quota?.sttSecondsUsed ?? 0)} / {formatDurationShort(quota?.sttSecondsLimit ?? 0)} ({sttPercent}%)</p>
            <p className="account-muted">Kỳ quota: {quota?.periodYyyymm || 'Chưa có dữ liệu'}</p>
          </article>

          <article className="account-card">
            <h2>Ký tự Gemini input</h2>
            <div className="account-meter">
              <div className="account-meter__bar" style={cssVars({ '--meter-fill': `${geminiPercent}%` })} />
            </div>
            <p>{formatCharsShort(quota?.geminiInputCharsUsed ?? 0)} / {formatCharsShort(quota?.geminiInputCharsLimit ?? 0)} ký tự ({geminiPercent}%)</p>
            <p className="account-muted">Plan hiện tại: {quota?.plan || 'FREE'}</p>
          </article>

          <article className="account-card">
            <h2>Lý do bị chặn quota</h2>
            {blockReasons.length > 0 ? (
              <ul className="account-list">{blockReasons.map((reason) => <li key={reason}>{reason}</li>)}</ul>
            ) : (
              <p className="account-muted">Chưa có quota nào bị vượt giới hạn.</p>
            )}
          </article>

          <article className="account-card account-card--wide">
            <h2>Sử dụng theo ngày</h2>
            <ul className="account-list">
              {(detail?.daily ?? []).map((day) => (
                <li key={day.day}>
                  <strong>{day.day}</strong>
                  <div>STT {formatDurationShort(day.sttSeconds)} - Gemini {formatCharsShort(day.geminiChars)} ký tự - Bị chặn {day.deniedCount}</div>
                </li>
              ))}
              {(detail?.daily ?? []).length === 0 && <li className="account-empty">Chưa có consumption event trong 30 ngày.</li>}
            </ul>
          </article>

          <article className="account-card account-card--wide">
            <h2>Lịch sử consumption</h2>
            <div className="account-table-wrap">
              <table className="account-table">
                <thead><tr><th>Thời gian</th><th>Loại</th><th>Trạng thái</th><th>STT</th><th>Gemini</th></tr></thead>
                <tbody>
                  {(detail?.events ?? []).map((event) => (
                    <tr key={event.id}>
                      <td>{new Date(event.createdAt).toLocaleString('vi-VN')}</td>
                      <td>{event.quotaType}</td>
                      <td>{event.status}</td>
                      <td>{formatDurationShort(event.sttSecondsDelta)}</td>
                      <td>{formatCharsShort(event.geminiCharsDelta)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </article>
        </div>
      )}
    </section>
  )
}
