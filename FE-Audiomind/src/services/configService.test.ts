import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
import { getUploadConfig } from './configService'

describe('configService', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn())
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('falls back to bundled contract when endpoint fails', async () => {
    vi.mocked(fetch).mockRejectedValueOnce(new Error('network down'))

    const config = await getUploadConfig()

    expect(config.maxUploadBytes).toBe(104_857_600)
    expect(config.allowedExtensions).toEqual(['.mp3', '.wav', '.m4a'])
  })
})
