import { useState } from 'react'

type Message = {
  role: 'assistant' | 'user'
  text: string
}

type AiAssistantProps = {
  busy?: boolean
  meetingId?: number | null
  onAsk: (message: string) => Promise<string>
}

const initialMessages: Message[] = [
  {
    role: 'user',
    text: 'Bạn có thể tóm tắt cho tôi không?'
  },
  {
    role: 'assistant',
    text: 'Dưới đây là một số ý chính được tóm tắt từ bài giảng:\n- Khái niệm: Xử lý Ngôn ngữ Tự nhiên (NLP).\n- Ứng dụng: Dịch văn bản tự động, chatbot...\nNếu cần, tôi có thể tạo mindmap hoặc câu hỏi trắc nghiệm.',
  },
]

export default function AiAssistant({ busy, meetingId: _meetingId, onAsk }: AiAssistantProps) {
  const [messages, setMessages] = useState<Message[]>(initialMessages)
  const [input, setInput] = useState('')
  const [sending, setSending] = useState(false)

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
        next[next.length - 1] = { role: 'assistant', text: response }
        return next
      })
    } catch (error) {
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
    <>
      <div className="assistant-header">✨ AI Assistant</div>

      <div className="assistant-body">
        {messages.map((msg, index) => (
          <div
            key={`${msg.role}-${index}`}
            className={`msg-wrapper ${msg.role}`}
          >
            {msg.role === 'assistant' && (
              <div className="msg-avatar ai">✨</div>
            )}
            <div className="msg-bubble" style={{ whiteSpace: 'pre-wrap' }}>
              {msg.text}
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
          />
          <button type="button">🎙</button>
          <button type="button">📎</button>
          <button
            type="button"
            className="btn-send"
            onClick={handleSend}
            disabled={busy || sending}
          >
            ➤
          </button>
        </div>
      </div>
    </>
  )
}
