import { useCallback, useEffect, useState } from 'react'
import { resolveErrorPresentation } from '../constants/errorCatalog'
import { ERROR_UX_ENABLED } from '../services/config'
import {
  formatSupportedExtensionsLabel,
  getBundledUploadConfig,
  getUploadConfig,
  type UploadConfig,
} from '../services/configService'

export type UploadPreflightResult =
  | { ok: true }
  | { ok: false; message: string; errorCode: string }

const normalizeExtension = (filename: string): string => {
  const dotIndex = filename.lastIndexOf('.')
  if (dotIndex < 0) {
    return ''
  }
  return filename.slice(dotIndex).toLowerCase()
}

export const validateUploadFile = (
  file: File,
  config: UploadConfig,
): UploadPreflightResult => {
  if (!file || file.size <= 0) {
    const presentation = resolveErrorPresentation('UPLOAD_EMPTY_FILE', 'File trống.', ERROR_UX_ENABLED)
    return { ok: false, message: presentation.message, errorCode: 'UPLOAD_EMPTY_FILE' }
  }

  if (file.size > config.maxUploadBytes) {
    const presentation = resolveErrorPresentation('UPLOAD_TOO_LARGE', 'File quá lớn.', ERROR_UX_ENABLED)
    return { ok: false, message: presentation.message, errorCode: 'UPLOAD_TOO_LARGE' }
  }

  const extension = normalizeExtension(file.name)
  if (!config.allowedExtensions.map((item) => item.toLowerCase()).includes(extension)) {
    const presentation = resolveErrorPresentation(
      'UPLOAD_UNSUPPORTED_FORMAT',
      'Định dạng không hỗ trợ.',
      ERROR_UX_ENABLED,
    )
    return { ok: false, message: presentation.message, errorCode: 'UPLOAD_UNSUPPORTED_FORMAT' }
  }

  return { ok: true }
}

export const useUpload = () => {
  const [config, setConfig] = useState<UploadConfig>(getBundledUploadConfig())
  const [supportedFormatsLabel, setSupportedFormatsLabel] = useState(
    formatSupportedExtensionsLabel(config.allowedExtensions),
  )

  useEffect(() => {
    let active = true
    void getUploadConfig().then((loaded) => {
      if (!active) {
        return
      }
      setConfig(loaded)
      setSupportedFormatsLabel(formatSupportedExtensionsLabel(loaded.allowedExtensions))
    })
    return () => {
      active = false
    }
  }, [])

  const preflightValidate = useCallback(
    (file: File) => validateUploadFile(file, config),
    [config],
  )

  return {
    config,
    supportedFormatsLabel,
    preflightValidate,
  }
}
