import uploadPolicy from '../../../packages/contracts/upload-validation-policy.json'
import { MEETING_API_BASE } from './config'

export type UploadConfig = {
  maxUploadBytes: number
  allowedExtensions: string[]
  allowedMimeTypes?: string[]
}

const bundledConfig: UploadConfig = {
  maxUploadBytes: uploadPolicy.maxUploadBytes,
  allowedExtensions: [...uploadPolicy.allowedExtensions],
  allowedMimeTypes: [...uploadPolicy.allowedMimeTypes],
}

let cachedConfig: UploadConfig | null = null

export const getBundledUploadConfig = (): UploadConfig => ({
  maxUploadBytes: bundledConfig.maxUploadBytes,
  allowedExtensions: [...bundledConfig.allowedExtensions],
  allowedMimeTypes: bundledConfig.allowedMimeTypes ? [...bundledConfig.allowedMimeTypes] : undefined,
})

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

export const formatSupportedExtensionsLabel = (extensions: string[]): string => {
  const normalized = extensions
    .map((item) => item.trim().toLowerCase())
    .filter(Boolean)
    .join(', ')
  return `Định dạng hỗ trợ: ${normalized}`
}
