const resolveUserApiBase = (): string => {
  const fromPrimary = import.meta.env.VITE_USER_API_BASE_URL
  const fromLegacy = import.meta.env.VITE_USER_SERVICE_URL
  const fromUmbrella = import.meta.env.VITE_API_BASE

  return fromPrimary || fromLegacy || fromUmbrella || 'http://localhost:8083'
}

export type LoginRequest = {
  username: string
  password: string
}

export type AuthResponse = {
  userId: number
  accessToken: string
  expiresInSeconds: number
}

export type RegisterRequest = {
  username: string
  email: string
  password: string
}

export type RegisterResponse = {
  userId: number
}

export type GoogleTicketExchangeResponse = {
  token: string
  expiresInSeconds: number
  user: {
    id: number
    email: string
    name: string
  }
  redirectAfter?: string | null
}

const USER_API_BASE = resolveUserApiBase()
const TOKEN_STORAGE_KEY = 'audiomind.access_token'
const TOKEN_EXPIRY_STORAGE_KEY = 'audiomind.access_token_expiry'

const decodeBase64Url = (value: string): string | null => {
  try {
    const normalized = value.replace(/-/g, '+').replace(/_/g, '/')
    const padding = normalized.length % 4 === 0 ? '' : '='.repeat(4 - (normalized.length % 4))
    return atob(`${normalized}${padding}`)
  } catch {
    return null
  }
}

export const parseJwt = (token: string): Record<string, any> | null => {
  if (!token || typeof token !== 'string') {
    return null
  }

  const parts = token.split('.')
  if (parts.length < 2) {
    return null
  }

  const payload = decodeBase64Url(parts[1])
  if (!payload) {
    return null
  }

  try {
    return JSON.parse(payload) as Record<string, any>
  } catch {
    return null
  }
}

const getExpiryTimestamp = (): number | null => {
  const raw = localStorage.getItem(TOKEN_EXPIRY_STORAGE_KEY)
  if (!raw) {
    return null
  }
  const parsed = Number(raw)
  return Number.isFinite(parsed) ? parsed : null
}

export const getAccessToken = (): string | null => {
  const token = localStorage.getItem(TOKEN_STORAGE_KEY)
  if (!token) {
    return null
  }

  const expiry = getExpiryTimestamp()
  if (expiry !== null && Date.now() >= expiry) {
    clearAccessToken()
    return null
  }

  return token
}

export const getCurrentUserId = (): string | null => {
  const token = getAccessToken()
  if (!token) {
    return null
  }

  const payload = parseJwt(token)
  if (!payload) {
    return null
  }

  const candidate = payload.userId ?? payload.user_id ?? payload.sub
  if (candidate === null || candidate === undefined) {
    return null
  }

  const normalized = String(candidate).trim()
  return normalized.length > 0 ? normalized : null
}

export const getJwtPlan = (): string => {
  const token = getAccessToken()
  if (!token) return 'FREE'
  const payload = parseJwt(token)
  const plan = payload?.plan
  return typeof plan === 'string' && plan.trim() ? plan.trim().toUpperCase() : 'FREE'
}

export const getJwtRole = (): string => {
  const token = getAccessToken()
  if (!token) return 'USER'
  const payload = parseJwt(token)
  const role = payload?.role
  return typeof role === 'string' && role.trim() ? role.trim().toUpperCase() : 'USER'
}

export const setAccessToken = (token: string, expiresInSeconds?: number): void => {
  localStorage.setItem(TOKEN_STORAGE_KEY, token)
  if (typeof expiresInSeconds === 'number' && Number.isFinite(expiresInSeconds) && expiresInSeconds > 0) {
    const expiry = Date.now() + Math.floor(expiresInSeconds * 1000)
    localStorage.setItem(TOKEN_EXPIRY_STORAGE_KEY, String(expiry))
  } else {
    localStorage.removeItem(TOKEN_EXPIRY_STORAGE_KEY)
  }
}

export const clearAccessToken = (): void => {
  localStorage.removeItem(TOKEN_STORAGE_KEY)
  localStorage.removeItem(TOKEN_EXPIRY_STORAGE_KEY)
}

export const login = async (payload: LoginRequest): Promise<AuthResponse> => {
  const response = await fetch(`${USER_API_BASE}/api/users/login`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(payload),
  })

  if (!response.ok) {
    throw new Error(`Login failed: ${response.status}`)
  }

  const data = (await response.json()) as AuthResponse
  if (!data.accessToken) {
    throw new Error('Login response did not contain accessToken')
  }

  return data
}

export const getGoogleLoginUrl = (redirectAfter = '/'): string => {
  const url = new URL(`${USER_API_BASE}/auth/google/start`)
  url.searchParams.set('redirect_after', redirectAfter)
  return url.toString()
}

export const exchangeGoogleLoginTicket = async (ticket: string): Promise<GoogleTicketExchangeResponse> => {
  const response = await fetch(`${USER_API_BASE}/auth/google/exchange-ticket`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ ticket }),
  })

  if (!response.ok) {
    const payload = await response.json().catch(() => null) as { message?: string } | null
    throw new Error(payload?.message || `Google login failed: ${response.status}`)
  }

  const data = await response.json() as GoogleTicketExchangeResponse
  if (!data.token) {
    throw new Error('Google login response did not contain an access token')
  }
  return data
}

export const register = async (payload: RegisterRequest): Promise<RegisterResponse> => {
  const response = await fetch(`${USER_API_BASE}/api/users/register`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(payload),
  })

  if (!response.ok) {
    throw new Error(`Register failed: ${response.status}`)
  }

  return response.json() as Promise<RegisterResponse>
}

export const refreshAccessToken = async (): Promise<AuthResponse> => {
  const token = getAccessToken()
  if (!token) {
    throw new Error('Missing access token')
  }

  const response = await fetch(`${USER_API_BASE}/api/users/refresh-token`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
    },
  })

  if (!response.ok) {
    throw new Error(`Refresh token failed: ${response.status}`)
  }

  const data = (await response.json()) as AuthResponse
  if (!data.accessToken) {
    throw new Error('Refresh response did not contain accessToken')
  }

  setAccessToken(data.accessToken, data.expiresInSeconds)
  return data
}

export const logout = async (): Promise<void> => {
  const token = getAccessToken()
  if (!token) {
    return
  }

  const response = await fetch(`${USER_API_BASE}/api/users/logout`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
    },
  })

  if (!response.ok) {
    throw new Error(`Logout failed: ${response.status}`)
  }
}
