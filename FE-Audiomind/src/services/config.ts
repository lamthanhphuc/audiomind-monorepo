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
