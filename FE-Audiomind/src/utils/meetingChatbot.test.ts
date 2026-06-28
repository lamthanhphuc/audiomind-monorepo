import { describe, expect, it, vi } from 'vitest'
import { answerMeetingQuestion } from './meetingChatbot'
import * as api from '../services/api'

describe('meetingChatbot', () => {
  it('returns fallback summary when no meeting id', async () => {
    const result = await answerMeetingQuestion(null, 'tóm tắt', {
      summary: 'Cuộc họp sprint',
    } as any)

    expect(result.provider).toBe('fallback')
    expect(result.answer).toContain('Cuộc họp sprint')
  })

  it('uses gemini answer when available', async () => {
    vi.spyOn(api, 'askMeetingChat').mockResolvedValueOnce({
      answer: 'Gemini trả lời',
      provider: 'gemini',
    })

    const result = await answerMeetingQuestion(7, 'hỏi gì đó', null)

    expect(result.provider).toBe('gemini')
    expect(result.answer).toBe('Gemini trả lời')
  })

  it('returns quota message on 402', async () => {
    vi.spyOn(api, 'askMeetingChat').mockRejectedValueOnce(new api.ApiError('QUOTA_EXCEEDED', 402))

    const result = await answerMeetingQuestion(7, 'hỏi gì đó', { summary: 'x' } as any)

    expect(result.provider).toBe('fallback')
    expect(result.answer).toContain('quota Gemini')
  })

  it('falls back to action items keywords', async () => {
    vi.spyOn(api, 'askMeetingChat').mockRejectedValueOnce(new Error('network'))

    const result = await answerMeetingQuestion(7, 'việc cần làm', {
      actionItems: ['Gửi báo cáo', 'Review PR'],
    } as any)

    expect(result.provider).toBe('fallback')
    expect(result.answer).toContain('Gửi báo cáo')
  })
})
