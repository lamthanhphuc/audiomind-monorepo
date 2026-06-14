import { describe, expect, it } from 'vitest'
import {
  formatGroupedActionPlanForCopy,
  isRetryableAnalysisFailure,
  normalizeAnalysisDisplayStatus,
  normalizeAnalysisResponse,
  normalizeGroupedActionPlan,
} from './index'

describe('grouped action plan normalization', () => {
  it('preserves section order, Vietnamese text, proper nouns, and subtasks in copy output', () => {
    const plan = normalizeGroupedActionPlan({
      version: 'grouped-action-plan-v1',
      language: 'vi',
      intro: 'Dựa trên nội dung cuộc thảo luận trong file audio, dưới đây là danh sách các công việc cần thực hiện, được phân chia theo các nhóm chức năng chính:',
      sections: [
        {
          id: 'sec-2',
          order: 2,
          title: 'Thanh toán FPT',
          items: [
            {
              id: 'item-2',
              title: 'Kiểm tra cổng thanh toán MoMo',
              description: 'Đối soát giao dịch bị treo.',
              confidence: 'INFERRED',
              evidenceKeywords: ['MoMo', 'FPT'],
              subtasks: [{ text: 'Gửi log lỗi cho FPT Pay.', confidence: 'NEEDS_REVIEW' }],
            },
          ],
        },
        {
          id: 'sec-1',
          order: 1,
          title: 'Đăng nhập',
          items: [
            {
              id: 'item-1',
              title: 'Thêm đăng nhập bằng Gmail',
              description: 'Ưu tiên luồng sinh viên.',
              confidence: 'SUPPORTED',
              evidenceKeywords: ['Gmail'],
              subtasks: ['Cập nhật màn hình mobile.'],
            },
          ],
        },
      ],
    })

    const copy = formatGroupedActionPlanForCopy(plan)

    expect(copy.indexOf('### 1. Đăng nhập')).toBeLessThan(copy.indexOf('### 2. Thanh toán FPT'))
    expect(copy).toContain('* **Thêm đăng nhập bằng Gmail:** Ưu tiên luồng sinh viên.')
    expect(copy).toContain('  * Cập nhật màn hình mobile.')
    expect(copy).toContain('* **Kiểm tra cổng thanh toán MoMo:** Đối soát giao dịch bị treo. (Suy luận)')
    expect(copy).toContain('  * Gửi log lỗi cho FPT Pay. (Cần xác minh)')
    expect(copy).not.toContain('evidence')
    expect(copy).not.toContain('MoMo, FPT')
  })

  it('uses a deterministic Công việc chung fallback for old flat saved analysis', () => {
    const plan = normalizeGroupedActionPlan(undefined, [
      { task: 'Scale API workers', owner: 'Nam', status: 'open' },
    ])

    expect(plan?.sections[0]?.title).toBe('Công việc chung')
    expect(plan?.sections[0]?.items[0]?.title).toBe('Scale API workers')
    expect(plan?.sections[0]?.items[0]?.confidence).toBe('NEEDS_REVIEW')
    expect(formatGroupedActionPlanForCopy(plan)).toContain('### 1. Công việc chung')
  })

  it('does not mark missing or invalid confidence as supported', () => {
    const plan = normalizeGroupedActionPlan({
      version: 'grouped-action-plan-v1',
      language: 'vi',
      intro: 'Intro',
      sections: [
        {
          id: 'sec',
          order: 1,
          title: 'Ops',
          items: [
            {
              id: 'invalid',
              title: 'Confirm rollout',
              confidence: 'green',
              subtasks: ['Ping QA'],
            },
            {
              id: 'missing',
              title: 'Assign owner',
            },
          ],
        },
      ],
      notes: ['Needs owner confirmation'],
    })

    expect(plan?.sections[0]?.items[0]?.confidence).toBe('NEEDS_REVIEW')
    expect(plan?.sections[0]?.items[0]?.subtasks[0]?.confidence).toBe('NEEDS_REVIEW')
    expect(plan?.sections[0]?.items[1]?.confidence).toBe('NEEDS_REVIEW')
    expect(plan?.notes[0]?.confidence).toBe('NEEDS_REVIEW')
  })

  it('only marks flat fallback items as supported when evidence exists', () => {
    const plan = normalizeGroupedActionPlan(undefined, [
      { task: 'No evidence task' },
      { task: 'Evidence-backed task', evidence: 'Customer asked for export' },
    ])

    expect(plan?.sections[0]?.items[0]?.confidence).toBe('NEEDS_REVIEW')
    expect(plan?.sections[0]?.items[1]?.confidence).toBe('SUPPORTED')
    expect(plan?.sections[0]?.items[1]?.evidenceKeywords).toEqual(['Customer asked for export'])
  })

  it('prefers groupedActionPlan over grouped_action_plan on saved analysis responses', () => {
    const analysis = normalizeAnalysisResponse({
      summary: 'Done',
      keywords: [],
      technicalTerms: [],
      painPoints: [],
      actionItems: ['Legacy task'],
      businessActionItems: [{ task: 'Legacy task' }],
      domainMode: 'it',
      groupedActionPlan: {
        version: 'grouped-action-plan-v1',
        language: 'vi',
        intro: 'Camel intro',
        sections: [{ id: 'camel', order: 1, title: 'Camel', items: [{ id: 'a', title: 'Camel task' }] }],
      },
      grouped_action_plan: {
        version: 'grouped-action-plan-v1',
        language: 'vi',
        intro: 'Snake intro',
        sections: [{ id: 'snake', order: 1, title: 'Snake', items: [{ id: 'b', title: 'Snake task' }] }],
      },
    })

    expect(analysis.groupedActionPlan?.intro).toBe('Camel intro')
    expect(analysis.groupedActionPlan?.sections[0]?.title).toBe('Camel')
  })

  it('normalizes retryable analysis failure metadata', () => {
    const analysis = normalizeAnalysisResponse({
      analysisStatus: 'ANALYSIS_FAILED_RETRYABLE',
      errorCode: 'CIRCUIT_OPEN',
      retryable: true,
      transcriptSaved: true,
      retryAfterSeconds: 10,
      attemptCount: 1,
      summary: '',
      keywords: [],
      technicalTerms: [],
      painPoints: [],
      actionItems: [],
      domainMode: 'it',
    })

    expect(analysis.analysisStatus).toBe('ANALYSIS_FAILED_RETRYABLE')
    expect(analysis.errorCode).toBe('CIRCUIT_OPEN')
    expect(analysis.retryable).toBe(true)
    expect(analysis.transcriptSaved).toBe(true)
    expect(analysis.retryAfterSeconds).toBe(10)
    expect(analysis.attemptCount).toBe(1)
    expect(isRetryableAnalysisFailure(analysis)).toBe(true)
    expect(normalizeAnalysisDisplayStatus(analysis)).toBe('failed_retryable')
  })
})
