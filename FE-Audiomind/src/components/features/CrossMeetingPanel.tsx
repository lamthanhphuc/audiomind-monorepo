import { useState } from 'react'
import { askCrossMeeting, type CrossMeetingAskResult } from '../../services/api'
import { LoadingState } from '../ui/LoadingState'
import { ErrorState } from '../ui/ErrorState'
import { EmptyState } from '../ui/EmptyState'

const EXAMPLE_QUESTIONS = [
  'Các quyết định về API trong 3 tháng qua?',
  'Ai phụ trách deadline gần nhất?',
  'Rủi ro nào lặp lại nhiều meeting?',
]

type CrossMeetingPanelProps = {
  onOpenMeeting?: (meetingId: number) => void
}

export default function CrossMeetingPanel({ onOpenMeeting }: CrossMeetingPanelProps) {
  const [question, setQuestion] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [result, setResult] = useState<CrossMeetingAskResult | null>(null)

  const handleAsk = async (value?: string) => {
    const trimmed = (value ?? question).trim()
    if (!trimmed || busy) return
    setQuestion(trimmed)
    setBusy(true)
    setError(null)
    try {
      setResult(await askCrossMeeting(trimmed, 5))
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Không thể hỏi cross-meeting lúc này.')
      setResult(null)
    } finally {
      setBusy(false)
    }
  }

  const hasAnswer = Boolean(result?.answer?.trim())
  const hasMeetings = Boolean(result?.meetings?.length)

  return (
    <section className="studio-card cross-meeting-panel" data-testid="cross-meeting-panel">
      <h2 className="studio-page-head">Hỏi qua nhiều meeting</h2>
      <p className="studio-muted-text cross-meeting-panel__intro">
        Tìm kiếm semantic và tổng hợp insight từ các meeting gần đây của bạn.
      </p>

      <div className="cross-meeting-panel__examples">
        {EXAMPLE_QUESTIONS.map((example) => (
          <button
            key={example}
            type="button"
            className="cross-meeting-panel__example"
            disabled={busy}
            onClick={() => void handleAsk(example)}
          >
            {example}
          </button>
        ))}
      </div>

      <div className="studio-form-row">
        <input
          type="text"
          className="studio-input"
          placeholder="Nhập câu hỏi của bạn…"
          value={question}
          onChange={(event) => setQuestion(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter') void handleAsk()
          }}
          data-testid="cross-meeting-question"
        />
        <button
          type="button"
          className="studio-btn studio-btn--primary"
          disabled={busy || !question.trim()}
          onClick={() => void handleAsk()}
        >
          Hỏi
        </button>
      </div>

      {busy && <LoadingState message="Đang tìm meeting liên quan…" />}
      {error && <ErrorState title="Hỏi nhiều meeting" message={error} />}

      {result && !busy && !hasAnswer && !hasMeetings && (
        <EmptyState message="Không tìm thấy meeting liên quan. Hãy thử câu hỏi cụ thể hơn hoặc upload thêm meeting." />
      )}

      {result && !busy && (hasAnswer || hasMeetings) && (
        <div className="studio-stack">
          {hasAnswer && (
            <article className="cross-meeting-panel__answer">
              <p>{result.answer}</p>
              {result.provider && (
                <p className="studio-muted-text cross-meeting-panel__provider">
                  Nguồn: {result.provider === 'embedding' ? 'embedding vector' : result.provider}
                </p>
              )}
            </article>
          )}
          {hasMeetings && (
            <div>
              <h3 className="studio-page-head cross-meeting-panel__subhead">Meeting liên quan</h3>
              <ul className="integration-recording-list">
                {result.meetings.map((meeting) => (
                  <li key={meeting.meetingId} className="integration-recording-list__item">
                    <button
                      type="button"
                      className="studio-link-btn"
                      onClick={() => onOpenMeeting?.(meeting.meetingId)}
                    >
                      {meeting.title || meeting.originalFileName || 'Meeting liên quan'}
                    </button>
                    {meeting.reason && <span className="studio-muted-text">— {meeting.reason}</span>}
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
      )}
    </section>
  )
}
