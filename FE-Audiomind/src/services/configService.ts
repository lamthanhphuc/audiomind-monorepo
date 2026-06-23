import uploadPolicy from '../../../packages/contracts/upload-validation-policy.json'
import transcriptQualityDefaults from '../config/transcriptQualityDefaults.json'
import { FALLBACK_POLICY } from '../config/fallback-policy'
import { AI_INTERNAL_BASE, MEETING_API_BASE, PROCESSING_API_BASE } from './config'

export type UploadConfig = {
  maxUploadBytes: number
  allowedExtensions: string[]
  allowedMimeTypes?: string[]
}

export type TranscriptQualityPolicy = typeof transcriptQualityDefaults

const bundledConfig: UploadConfig = {
  maxUploadBytes: uploadPolicy.maxUploadBytes,
  allowedExtensions: [...uploadPolicy.allowedExtensions],
  allowedMimeTypes: [...uploadPolicy.allowedMimeTypes],
}

let cachedConfig: UploadConfig | null = null
let cachedTranscriptQualityPolicy: TranscriptQualityPolicy | null = null
const lexiconCache = new Map<string, unknown>()

export type DomainLexicon = {
  domain: string
  versionHash: string
  terms: Array<{ term?: string; normalized?: string; category?: string; source?: string }>
  normalizationMap: Record<string, string>
}

export const getBundledUploadConfig = (): UploadConfig => ({
  maxUploadBytes: bundledConfig.maxUploadBytes,
  allowedExtensions: [...bundledConfig.allowedExtensions],
  allowedMimeTypes: bundledConfig.allowedMimeTypes ? [...bundledConfig.allowedMimeTypes] : undefined,
})

export const getBundledTranscriptQualityPolicy = (): TranscriptQualityPolicy => ({
  ...transcriptQualityDefaults,
})

const resolveStaticTranscriptQualityFallback = (): TranscriptQualityPolicy => {
  try {
    return getBundledTranscriptQualityPolicy()
  } catch {
    return JSON.parse(JSON.stringify(FALLBACK_POLICY)) as TranscriptQualityPolicy
  }
}

export const resetTranscriptQualityPolicyCacheForTests = (): void => {
  cachedTranscriptQualityPolicy = null
  lexiconCache.clear()
}

export const getLexicon = async (domain: string): Promise<DomainLexicon> => {
  const normalizedDomain = String(domain || 'general').trim().toLowerCase() || 'general'
  const cacheKey = `domainPack-${normalizedDomain}`
  const cached = lexiconCache.get(cacheKey)
  if (cached) {
    return cached as DomainLexicon
  }

  try {
    const response = await fetch(`${AI_INTERNAL_BASE}/api/config/lexicon?domain=${encodeURIComponent(normalizedDomain)}`)
    if (!response.ok) {
      throw new Error(`lexicon status ${response.status}`)
    }
    const payload = (await response.json()) as DomainLexicon
    lexiconCache.set(cacheKey, payload)
    return payload
  } catch {
    const fallback: DomainLexicon = {
      domain: normalizedDomain,
      versionHash: 'fallback',
      terms: [],
      normalizationMap: {},
    }
    lexiconCache.set(cacheKey, fallback)
    return fallback
  }
}

export const getUploadConfig = async (): Promise<UploadConfig> => {
  if (cachedConfig) {
    return cachedConfig
  }

  try {
    const response = await fetch(`${MEETING_API_BASE}/api/config/upload`)
    if (!response.ok) {
      throw new Error(`upload config status ${response.status}`)
    }
    const payload = await response.json() as Partial<UploadConfig>
    cachedConfig = {
      maxUploadBytes: Number(payload.maxUploadBytes ?? bundledConfig.maxUploadBytes),
      allowedExtensions: Array.isArray(payload.allowedExtensions)
        ? payload.allowedExtensions.map((item) => String(item))
        : [...bundledConfig.allowedExtensions],
      allowedMimeTypes: Array.isArray(payload.allowedMimeTypes)
        ? payload.allowedMimeTypes.map((item) => String(item))
        : bundledConfig.allowedMimeTypes,
    }
    return cachedConfig
  } catch {
    cachedConfig = getBundledUploadConfig()
    return cachedConfig
  }
}

export const getTranscriptQualityPolicy = async (): Promise<TranscriptQualityPolicy> => {
  if (cachedTranscriptQualityPolicy) {
    return cachedTranscriptQualityPolicy
  }

  try {
    const response = await fetch(`${PROCESSING_API_BASE}/api/config/transcript-quality`)
    if (!response.ok) {
      throw new Error(`transcript-quality policy status ${response.status}`)
    }
    const payload = (await response.json()) as Partial<TranscriptQualityPolicy>
    cachedTranscriptQualityPolicy = {
      ...getBundledTranscriptQualityPolicy(),
      ...payload,
    }
    return cachedTranscriptQualityPolicy
  } catch {
    cachedTranscriptQualityPolicy = resolveStaticTranscriptQualityFallback()
    return cachedTranscriptQualityPolicy
  }
}

export const formatSupportedExtensionsLabel = (extensions: string[]): string => {
  const normalized = extensions
    .map((item) => item.trim().toLowerCase())
    .filter(Boolean)
    .join(', ')
  return `Định dạng hỗ trợ: ${normalized}`
}
