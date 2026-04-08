export const PROCESSING_API_BASE = import.meta.env.VITE_PROCESSING_API_BASE_URL || 'http://localhost:8082'
export const AI_INTERNAL_BASE = import.meta.env.VITE_API_CPU_BASE || 'http://localhost:8000'
export const AI_GPU_BASE = import.meta.env.VITE_API_GPU_BASE || 'http://localhost:8001'

export const API_BASE = import.meta.env.VITE_API_BASE || PROCESSING_API_BASE
