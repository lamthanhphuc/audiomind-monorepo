const resolveEnv = (keys: string[], fallback: string): string => {
	const value = keys
		.map((key) => (import.meta.env as Record<string, string | undefined>)[key])
		.find((candidate) => typeof candidate === 'string' && candidate.trim().length > 0)

	if (value) {
		return value
	}

	if (import.meta.env.PROD) {
		throw new Error(`Missing required environment variable. Expected one of: ${keys.join(', ')}`)
	}

	return fallback
}

const resolveOptionalEnv = (keys: string[], fallback: string): string => {
	const value = keys
		.map((key) => (import.meta.env as Record<string, string | undefined>)[key])
		.find((candidate) => typeof candidate === 'string' && candidate.trim().length > 0)

	return value || fallback
}

const resolveBooleanEnv = (keys: string[], fallback: boolean): boolean => {
	const value = keys
		.map((key) => (import.meta.env as Record<string, string | undefined>)[key])
		.find((candidate) => typeof candidate === 'string' && candidate.trim().length > 0)

	if (value) {
		return value.trim().toLowerCase() === 'true'
	}

	return fallback
}

const resolveNumberEnv = (keys: string[], fallback: number, options: { min?: number; max?: number } = {}): number => {
	const value = keys
		.map((key) => (import.meta.env as Record<string, string | undefined>)[key])
		.find((candidate) => typeof candidate === 'string' && candidate.trim().length > 0)

	const parsed = value ? Number(value) : fallback
	const finiteValue = Number.isFinite(parsed) ? parsed : fallback
	const minValue = typeof options.min === 'number' ? Math.max(options.min, finiteValue) : finiteValue
	return typeof options.max === 'number' ? Math.min(options.max, minValue) : minValue
}

export const PROCESSING_API_BASE = resolveEnv(['VITE_PROCESSING_API_BASE_URL', 'VITE_PROCESSING_SERVICE_URL'], 'http://localhost:8082')
export const MEETING_API_BASE = resolveEnv(['VITE_MEETING_API_BASE_URL', 'VITE_MEETING_SERVICE_URL'], 'http://localhost:8081')
export const AI_INTERNAL_BASE = resolveEnv(['VITE_API_CPU_BASE', 'VITE_AI_SERVICE_URL'], 'http://localhost:8000')
export const AI_GPU_BASE = resolveEnv(['VITE_API_GPU_BASE'], 'http://localhost:8001')
export const API_BASE = resolveEnv(['VITE_API_BASE'], PROCESSING_API_BASE)
export const REALTIME_WS_BASE_URL = resolveOptionalEnv(
	['VITE_REALTIME_WS_BASE_URL', 'REACT_APP_WS_URL'],
	'ws://localhost:8082/ws/meetings',
)
export const REALTIME_WS_ENABLED = resolveBooleanEnv(
	['VITE_REALTIME_WS_ENABLED', 'REACT_APP_REALTIME_WS_ENABLED'],
	import.meta.env.MODE === 'staging',
)
export const AUDIO_DEBUG_ENABLED = resolveBooleanEnv(
	['VITE_AUDIO_DEBUG', 'REACT_APP_AUDIO_DEBUG'],
	false,
)

export const REALTIME_PREROLL_ENABLED = resolveBooleanEnv(['VITE_REALTIME_PREROLL_ENABLED'], true)
export const REALTIME_START_PREROLL_MS = resolveNumberEnv(['VITE_REALTIME_START_PREROLL_MS'], 1200, { min: 0, max: 10_000 })
export const REALTIME_RESUME_PREROLL_MS = resolveNumberEnv(['VITE_REALTIME_RESUME_PREROLL_MS'], 1200, { min: 0, max: 10_000 })
export const REALTIME_RECORDER_TIMESLICE_MS = resolveNumberEnv(['VITE_REALTIME_RECORDER_TIMESLICE_MS'], 200, { min: 100, max: 1000 })
export const REALTIME_VAD_DYNAMIC_ENABLED = resolveBooleanEnv(['VITE_REALTIME_VAD_DYNAMIC_ENABLED'], true)
export const REALTIME_MIC_SENSITIVITY = resolveOptionalEnv(['VITE_REALTIME_MIC_SENSITIVITY'], 'normal')
export const REALTIME_NOISE_SUPPRESSION_DEFAULT = resolveBooleanEnv(['VITE_REALTIME_NOISE_SUPPRESSION_DEFAULT'], true)
export const REALTIME_NOISE_SUPPRESSION_TOGGLE_ENABLED = resolveBooleanEnv(['VITE_REALTIME_NOISE_SUPPRESSION_TOGGLE_ENABLED'], true)
export const REALTIME_KEEPALIVE_ENABLED = resolveBooleanEnv(['VITE_REALTIME_KEEPALIVE_ENABLED'], false)
export const REALTIME_TINY_CHUNK_MAX_BYTES = resolveNumberEnv(['VITE_REALTIME_TINY_CHUNK_MAX_BYTES'], 128, { min: 1, max: 4096 })
export const REALTIME_TINY_CHUNK_STREAK_THRESHOLD = resolveNumberEnv(['VITE_REALTIME_TINY_CHUNK_STREAK_THRESHOLD'], 10, { min: 3, max: 50 })
export const REALTIME_TINY_CHUNK_MIN_RECORDING_SEC = resolveNumberEnv(['VITE_REALTIME_TINY_CHUNK_MIN_RECORDING_SEC'], 5, { min: 1, max: 120 })
export const REALTIME_TINY_CHUNK_MAX_RMS = resolveNumberEnv(['VITE_REALTIME_TINY_CHUNK_MAX_RMS'], 0.01, { min: 0, max: 1 })
export const REALTIME_MIN_FALLBACK_AUDIO_BYTES = resolveNumberEnv(['VITE_REALTIME_MIN_FALLBACK_AUDIO_BYTES'], 1024, { min: 128, max: 1_048_576 })

export const ERROR_UX_ENABLED = resolveBooleanEnv(
	['VITE_ERROR_UX_ENABLED', 'REACT_APP_ERROR_UX_ENABLED'],
	true,
)
