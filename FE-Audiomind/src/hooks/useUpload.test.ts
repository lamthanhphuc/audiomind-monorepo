import { describe, expect, it } from 'vitest'
import { validateUploadFile } from '../hooks/useUpload'
import { getBundledUploadConfig } from '../services/configService'

describe('useUpload preflight', () => {
  const config = getBundledUploadConfig()

  it('rejects unsupported extension', () => {
    const file = new File([new Uint8Array([1, 2, 3])], 'demo.ogg', { type: 'audio/ogg' })
    const result = validateUploadFile(file, config)
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.errorCode).toBe('UPLOAD_UNSUPPORTED_FORMAT')
    }
  })

  it('rejects oversized file', () => {
    const file = new File([new Uint8Array(config.maxUploadBytes + 1)], 'demo.mp3', { type: 'audio/mpeg' })
    const result = validateUploadFile(file, config)
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.errorCode).toBe('UPLOAD_TOO_LARGE')
    }
  })
})
