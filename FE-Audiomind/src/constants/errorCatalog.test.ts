import { describe, expect, it } from 'vitest'
import { ERROR_CATALOG, ERROR_CODE_ALIASES, resolveBatchPipelineErrorCode, resolveErrorPresentation } from './errorCatalog'

describe('errorCatalog', () => {
  it('contains Gate-A P0 error codes', () => {
    const expected = [
      'UPLOAD_EMPTY_FILE',
      'UPLOAD_TOO_LARGE',
      'UPLOAD_UNSUPPORTED_FORMAT',
      'UPLOAD_INVALID_FILENAME',
      'UPLOAD_MIME_MISMATCH',
      'UPLOAD_SECURITY_SCAN_FAILED',
      'REALTIME_CHUNK_TOO_LARGE',
      'REALTIME_UNSUPPORTED_ENCODING',
      'REALTIME_INVALID_PAYLOAD',
      'MIC_PERMISSION_DENIED',
      'INVALID_AUDIO_CAPTURE',
      'ANALYSIS_BUSY',
      'EXPORT_ANALYSIS_REQUIRED',
      'GROUPED_ACTION_PLAN_UNAVAILABLE',
      'GROUPED_ACTION_PLAN_INVALID',
      'GROUPED_ACTION_PLAN_EXPORT_FAILED',
      'QUERY_TOO_SHORT',
      'NO_TRANSCRIPT_AFTER_FINALIZE',
      'UNAUTHORIZED',
      'FORBIDDEN',
      'QUOTA_EXCEEDED',
      'RATE_LIMITED',
    ]
    for (const code of expected) {
      expect(ERROR_CATALOG[code]).toBeDefined()
    }
  })

  it('maps legacy Gate-A aliases to catalog entries', () => {
    expect(ERROR_CODE_ALIASES.EMPTY_FILE).toBe('UPLOAD_EMPTY_FILE')
    expect(ERROR_CODE_ALIASES.UNSUPPORTED_AUDIO_TYPE).toBe('UPLOAD_UNSUPPORTED_FORMAT')
    expect(ERROR_CODE_ALIASES.OWNER_FORBIDDEN).toBe('FORBIDDEN')
    expect(resolveErrorPresentation('EMPTY_FILE', 'raw', true).message)
      .toBe(ERROR_CATALOG.UPLOAD_EMPTY_FILE.message)
    expect(resolveErrorPresentation('ANALYSIS_BUSY', 'busy', true).message)
      .toBe('AI đang bận, vui lòng thử lại sau.')
  })

  it('maps upload too large to Vietnamese message and CTA', () => {
    expect(ERROR_CATALOG.UPLOAD_TOO_LARGE).toEqual({
      message: 'File vượt quá dung lượng cho phép (tối đa 100MB).',
      ctaId: 'reduce_file_size',
      ctaLabel: 'Giảm dung lượng file',
    })
  })

  it('resolveErrorPresentation returns CTA when UX enabled', () => {
    const result = resolveErrorPresentation('UNAUTHORIZED', 'Unauthorized', true)
    expect(result.message).toBe('Phiên đăng nhập đã hết hạn.')
    expect(result.ctaId).toBe('relogin')
    expect(result.ctaLabel).toBe('Đăng nhập lại')
  })

  it('resolveErrorPresentation falls back when UX disabled', () => {
    const result = resolveErrorPresentation('UNAUTHORIZED', 'Unauthorized', false)
    expect(result.message).toBe('Unauthorized')
    expect(result.ctaId).toBeUndefined()
  })

  it('resolveBatchPipelineErrorCode maps Gemini quota failures', () => {
    expect(resolveBatchPipelineErrorCode(
      'BATCH_PIPELINE_FAILED errorType=GeminiQuotaExceededError stage=analysis',
    )).toBe('QUOTA_EXCEEDED')
    expect(resolveBatchPipelineErrorCode(
      'BATCH_PIPELINE_FAILED errorType=GeminiQuotaExceededError errorCode=GEMINI_QUOTA_EXHAUSTED stage=analysis',
    )).toBe('QUOTA_EXCEEDED')
  })

  it('resolveBatchPipelineErrorCode maps analysis parse failures', () => {
    expect(resolveBatchPipelineErrorCode(
      'BATCH_PIPELINE_FAILED errorType=AnalysisParseError stage=analysis',
    )).toBe('ANALYSIS_BUSY')
  })
})
