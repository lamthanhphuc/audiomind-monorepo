import { askMeetingChat, searchMeetingTranscriptEvidence, type TranscriptEvidenceMatch } from '../services/api'
import { ApiError } from '../services/api'
import type { AiAnalysis } from '../types'

export type MeetingChatProvider = 'gemini' | 'fallback' | 'evidence'

export type MeetingChatCitation = {
  speaker: string
  startTime: number
  endTime?: number
  quote: string
  segmentId?: string
  evidenceId?: string
}

export type MeetingChatAnswer = {
  answer: string
  provider: MeetingChatProvider
  sourceSegments?: MeetingChatCitation[]
}

const normalize = (value: string): string => value.trim().toLowerCase()

const citationsFromEvidence = (matches: TranscriptEvidenceMatch[]): MeetingChatCitation[] =>
  matches.slice(0, 3).map((match) => ({
    speaker: match.speaker || 'Speaker',
    startTime: match.startTime,
    endTime: match.endTime,
    quote: match.text,
    segmentId: match.segmentId,
    evidenceId: match.evidenceId,
  }))

const formatEvidenceAnswer = (matches: Awaited<ReturnType<typeof searchMeetingTranscriptEvidence>>['matches']): string => {
  if (!matches.length) {
    return 'Không tìm thấy đoạn transcript phù hợp. Hãy thử từ khóa ngắn hơn hoặc cụ thể hơn.'
  }
  const lines = matches.slice(0, 3).map((match, index) => {
    const time = `${Math.floor(match.startTime)}s`
    const speaker = match.speaker ? `${match.speaker}: ` : ''
    const snippet = match.text.length > 220 ? `${match.text.slice(0, 220)}…` : match.text
    return `${index + 1}. [${time}] ${speaker}${snippet}`
  })
  return `Mình tìm thấy ${matches.length} đoạn liên quan:\n${lines.join('\n')}`
}

const fallbackAnswer = (
  normalizedQuestion: string,
  analysis: AiAnalysis | null,
  meetingId: number | null | undefined,
): Promise<MeetingChatAnswer> => {
  const q = normalize(normalizedQuestion)

  if (q.includes('tóm tắt') || q.includes('summary') || q.includes('nội dung chính')) {
    if (analysis?.summary?.trim()) {
      return Promise.resolve({
        provider: 'fallback',
        answer: `Tóm tắt cuộc họp:\n${analysis.summary.trim()}`,
      })
    }
    return Promise.resolve({
      provider: 'fallback',
      answer: 'Chưa có bản tóm tắt. Hãy chờ phân tích hoàn tất hoặc chạy phân tích lại.',
    })
  }

  if (q.includes('việc cần làm') || q.includes('action') || q.includes('công việc') || q.includes('task')) {
    const items = analysis?.actionItems?.filter((item) => item.trim()) ?? []
    if (!items.length) {
      return Promise.resolve({ provider: 'fallback', answer: 'Chưa có action item rõ ràng trong phân tích.' })
    }
    return Promise.resolve({
      provider: 'fallback',
      answer: `Các việc cần làm:\n${items.slice(0, 8).map((item, index) => `${index + 1}. ${item}`).join('\n')}`,
    })
  }

  if (q.includes('từ khóa') || q.includes('keyword')) {
    const keywords = analysis?.keywords?.filter((item) => item.trim()) ?? []
    if (!keywords.length) {
      return Promise.resolve({ provider: 'fallback', answer: 'Chưa có từ khóa nào được trích xuất.' })
    }
    return Promise.resolve({
      provider: 'fallback',
      answer: `Từ khóa chính: ${keywords.slice(0, 12).join(', ')}`,
    })
  }

  if (q.includes('thuật ngữ') || q.includes('glossary') || q.includes('technical')) {
    const terms = analysis?.technicalTerms ?? []
    if (!terms.length) {
      return Promise.resolve({ provider: 'fallback', answer: 'Chưa có thuật ngữ kỹ thuật trong phân tích.' })
    }
    return Promise.resolve({
      provider: 'fallback',
      answer: terms.slice(0, 8).map((term) => {
        const meaning = term.meaning?.trim()
        return meaning ? `• ${term.term}: ${meaning}` : `• ${term.term}`
      }).join('\n'),
    })
  }

  if (q.includes('rủi ro') || q.includes('risk') || q.includes('blocker') || q.includes('vấn đề')) {
    const risks = analysis?.risks ?? []
    const blockers = analysis?.blockers ?? []
    const painPoints = analysis?.painPoints ?? []
    const lines: string[] = []
    if (risks.length) lines.push(`Rủi ro: ${risks.slice(0, 5).join('; ')}`)
    if (blockers.length) lines.push(`Điểm nghẽn: ${blockers.slice(0, 5).join('; ')}`)
    if (painPoints.length) {
      lines.push(`Vấn đề: ${painPoints.slice(0, 5).map((item) => item.title).join('; ')}`)
    }
    if (!lines.length) {
      return Promise.resolve({ provider: 'fallback', answer: 'Chưa ghi nhận rủi ro hoặc blocker rõ ràng trong phân tích.' })
    }
    return Promise.resolve({ provider: 'fallback', answer: lines.join('\n') })
  }

  if (!meetingId) {
    return Promise.resolve({
      provider: 'fallback',
      answer: analysis?.summary
        ? `Dựa trên phân tích hiện có: ${analysis.summary}`
        : 'Chưa có meeting để tìm evidence trong transcript.',
    })
  }

  return searchMeetingTranscriptEvidence(meetingId, normalizedQuestion, {
    limit: 5,
    context: 1,
  })
    .then((response) => {
      if (response.matches.length > 0) {
        return {
          provider: 'evidence' as const,
          answer: formatEvidenceAnswer(response.matches),
          sourceSegments: citationsFromEvidence(response.matches),
        }
      }
      if (analysis?.summary?.trim()) {
        return {
          provider: 'fallback' as const,
          answer: `Không tìm thấy evidence cụ thể trong transcript. Tóm tắt liên quan:\n${analysis.summary.trim()}`,
        }
      }
      return {
        provider: 'fallback' as const,
        answer: 'Chưa đủ dữ liệu để trả lời. Hãy đợi transcript/phân tích sẵn sàng rồi thử lại.',
      }
    })
    .catch(() => ({
      provider: 'fallback' as const,
      answer: analysis?.summary?.trim()
        ? `Không thể tìm trong transcript lúc này. Tóm tắt liên quan:\n${analysis.summary.trim()}`
        : 'Không thể tìm trong transcript lúc này. Hãy thử lại sau.',
    }))
}

export const answerMeetingQuestion = async (
  meetingId: number | null | undefined,
  question: string,
  analysis: AiAnalysis | null,
): Promise<MeetingChatAnswer> => {
  const normalizedQuestion = question.trim()
  if (!normalizedQuestion) {
    return { provider: 'fallback', answer: 'Hãy nhập câu hỏi về nội dung cuộc họp.' }
  }

  if (meetingId) {
    try {
      const gemini = await askMeetingChat(meetingId, normalizedQuestion)
      if (gemini.answer?.trim()) {
        const provider = gemini.provider === 'fallback' ? 'fallback' : 'gemini'
        return {
          provider,
          answer: gemini.answer.trim(),
          sourceSegments: gemini.sourceSegments,
        }
      }
    } catch (error) {
      if (error instanceof ApiError && error.status === 402) {
        return {
          provider: 'fallback',
          answer: 'Đã hết quota Gemini tháng này. Vào Gói & thanh toán để nâng cấp hoặc thử lại sau.',
        }
      }
    }
  }

  return fallbackAnswer(normalizedQuestion, analysis, meetingId)
}
