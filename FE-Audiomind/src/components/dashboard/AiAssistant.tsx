import { useEffect, useState } from 'react'
import { SendHorizontal, Sparkles } from 'lucide-react'

import { formatTranscriptTimestamp } from '../../utils/transcript'
import type { MeetingChatCitation } from '../../utils/meetingChatbot'

type Message = {
  role: 'assistant' | 'user'
  text: string
  citations?: MeetingChatCitation[]
}

type AiAssistantProps = {
  busy?: boolean
  meetingId?: number | null
  onAsk: (message: string) => Promise<{ text: string; citations?: MeetingChatCitation[] }>
  onCitationClick?: (citation: MeetingChatCitation) => void
}

const demoMessages: Message[] = [
  {
    role: 'user',
    text: 'Bạn có thể tóm tắt cho tôi không?',
  },
  {
    role: 'assistant',
    text: 'Dưới đây là một số ý chính được tóm tắt từ bài giảng:\n- Khái niệm: Xử lý Ngôn ngữ Tự nhiên (NLP).\n- Ứng dụng: Dịch văn bản tự động, chatbot...\nNếu cần, tôi có thể tạo mindmap hoặc câu hỏi trắc nghiệm.',
  },
]

const meetingWelcome: Message = {
  role: 'assistant',
  text: 'Hỏi về tóm tắt, việc cần làm, thuật ngữ, rủi ro — hoặc tìm đoạn cụ thể trong transcript.',
}

export default function AiAssistant({ busy, meetingId, onAsk, onCitationClick }: AiAssistantProps) {
  const [messages, setMessages] = useState<Message[]>(meetingId ? [meetingWelcome] : demoMessages)
  const [input, setInput] = useState('')
  const [sending, setSending] = useState(false)

  useEffect(() => {
    setMessages(meetingId ? [meetingWelcome] : demoMessages)
    setInput('')
  }, [meetingId])

  const handleSend = async () => {
    const message = input.trim()
    if (!message || sending) return

    setInput('')
    setSending(true)

    setMessages((prev) => [
      ...prev,
      { role: 'user', text: message },
      { role: 'assistant', text: 'Đang xử lý...' },
    ])

    try {
      const response = await onAsk(message)
      setMessages((prev) => {
        const next = [...prev]
        next[next.length - 1] = {
          role: 'assistant',
          text: response.text,
          citations: response.citations,
        }
        return next
      })
    } catch {
      setMessages((prev) => {
        const next = [...prev]
        next[next.length - 1] = {
          role: 'assistant',
          text: 'Xin lỗi, tôi chưa thể xử lý yêu cầu này.',
        }
        return next
      })
    } finally {
      setSending(false)
    }
  }

  return (
    <div className="ai-assistant" data-testid="ai-assistant">
      <div className="assistant-header"><Sparkles size={16} aria-hidden="true" /> Trợ lý AI</div>

      <div className="assistant-body">
        {messages.map((msg, index) => (
          <div
            key={`${msg.role}-${index}`}
            className={`msg-wrapper ${msg.role}`}
          >
            {msg.role === 'assistant' && (
              <div className="msg-avatar ai"><Sparkles size={14} aria-hidden="true" /></div>
            )}
            <div className="msg-bubble msg-bubble--pre-wrap">
              {msg.text}
              {msg.citations && msg.citations.length > 0 && (
                <ul className="assistant-citations" data-testid="assistant-citations">
                  {msg.citations.map((citation, citationIndex) => (
                    <li key={`${citation.evidenceId ?? citation.segmentId ?? citationIndex}`}>
                      <button
                        type="button"
                        className="assistant-citation-link"
                        onClick={() => onCitationClick?.(citation)}
                      >
                        {citation.speaker} — nguồn {formatTranscriptTimestamp(citation.startTime)}
                      </button>
                      <span className="assistant-citation-quote">{citation.quote}</span>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </div>
        ))}
      </div>

      <div className="assistant-input-area">
        <div className="input-box">
          <input
            type="text"
            placeholder="Đặt câu hỏi về nội dung..."
            value={input}
            onChange={(event) => setInput(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter') handleSend()
            }}
            disabled={busy || sending}
          />
          <button
            type="button"
            className="btn-send"
            onClick={handleSend}
            disabled={busy || sending || !input.trim()}
            aria-label="Gửi câu hỏi"
          >
            <SendHorizontal size={16} aria-hidden="true" />
          </button>
        </div>
      </div>
    </div>
  )
}
