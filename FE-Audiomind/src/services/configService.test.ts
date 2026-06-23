import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
import {
  getTranscriptQualityPolicy,
  getUploadConfig,
  resetTranscriptQualityPolicyCacheForTests,
} from './configService'
import { FALLBACK_POLICY } from '../config/fallback-policy'

vi.mock('./config', () => ({
  MEETING_API_BASE: 'http://meeting.test',
  PROCESSING_API_BASE: 'http://processing.test',
}))

describe('configService', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn())
    resetTranscriptQualityPolicyCacheForTests()
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    resetTranscriptQualityPolicyCacheForTests()
  })

  it('falls back to bundled contract when upload endpoint fails', async () => {
    vi.mocked(fetch).mockRejectedValueOnce(new Error('network down'))

    const config = await getUploadConfig()

    expect(config.maxUploadBytes).toBe(104_857_600)
    expect(config.allowedExtensions).toEqual(['.mp3', '.wav', '.m4a'])
  })

  it('loads transcript quality policy from processing-service and caches result', async () => {
    vi.mocked(fetch).mockResolvedValueOnce(
      new Response(JSON.stringify({ evidence: { minScore: 0.5 } }), { status: 200 }),
    )

    const policy = await getTranscriptQualityPolicy()

    expect(fetch).toHaveBeenCalledWith('http://processing.test/api/config/transcript-quality')
    expect(policy.evidence.minScore).toBe(0.5)
    expect(policy.transcript.canonicalVersion).toBe('canonical-transcript-v2')

    vi.mocked(fetch).mockClear()
    const cached = await getTranscriptQualityPolicy()
    expect(fetch).not.toHaveBeenCalled()
    expect(cached.evidence.minScore).toBe(0.5)
  })

  it('falls back to bundled policy when transcript quality endpoint fails', async () => {
    vi.mocked(fetch).mockRejectedValueOnce(new Error('network down'))

    const policy = await getTranscriptQualityPolicy()

    expect(policy.evidence.minScore).toBe(FALLBACK_POLICY.evidence.minScore)
    expect(policy.evidence.speakerBoost).toBe(1.1)
    expect(policy.transcript.canonicalVersion).toBe('canonical-transcript-v2')
  })
})
