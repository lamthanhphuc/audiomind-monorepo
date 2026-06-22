import { describe, expect, it } from 'vitest'
import { ERROR_CATALOG, resolveErrorPresentation } from './errorCatalog'

describe('errorCatalog', () => {
  it('contains all P0 error codes', () => {
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
      'UNAUTHORIZED',
      'FORBIDDEN',
    ]
    for (const code of expected) {
      expect(ERROR_CATALOG[code]).toBeDefined()
    }
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
})
