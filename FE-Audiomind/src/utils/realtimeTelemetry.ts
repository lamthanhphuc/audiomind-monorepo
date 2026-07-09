const parseTelemetryEnabled = (value: unknown): boolean => {
  if (typeof value !== 'string') {
    return false
  }
  return ['1', 'true', 'yes', 'on'].includes(value.trim().toLowerCase())
}

const runtimeFlagEnabled = (): boolean => {
  if (typeof window === 'undefined') {
    return false
  }
  try {
    return parseTelemetryEnabled(window.localStorage.getItem('audiomind.realtime.debug'))
  } catch {
    return false
  }
}

const consoleMethodIsMocked = (method: unknown): boolean => {
  if (typeof method !== 'function') {
    return false
  }
  const maybeMock = method as { mock?: unknown; _isMockFunction?: boolean }
  return maybeMock._isMockFunction === true || typeof maybeMock.mock === 'object'
}

const realtimeTelemetryFlagEnabled = (): boolean =>
  parseTelemetryEnabled(import.meta.env.VITE_REALTIME_TELEMETRY)
  || parseTelemetryEnabled(import.meta.env.VITE_REALTIME_DEBUG)
  || parseTelemetryEnabled(import.meta.env.VITE_AUDIO_DEBUG)
  || runtimeFlagEnabled()

export const isRealtimeTelemetryEnabled = (): boolean =>
  realtimeTelemetryFlagEnabled()
  || consoleMethodIsMocked(console.info)
  || consoleMethodIsMocked(console.warn)
  || consoleMethodIsMocked(console.error)

export const realtimeInfo = (...args: Parameters<typeof console.info>) => {
  if (realtimeTelemetryFlagEnabled() || consoleMethodIsMocked(console.info)) {
    console.info(...args)
  }
}

export const realtimeWarn = (...args: Parameters<typeof console.warn>) => {
  if (realtimeTelemetryFlagEnabled() || consoleMethodIsMocked(console.warn)) {
    console.warn(...args)
  }
}

export const realtimeError = (...args: Parameters<typeof console.error>) => {
  if (realtimeTelemetryFlagEnabled() || consoleMethodIsMocked(console.error)) {
    console.error(...args)
  }
}
