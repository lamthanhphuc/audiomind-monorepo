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

const USER_API_BASE = resolveUserApiBase()
const TOKEN_STORAGE_KEY = 'audiomind.access_token'
const TOKEN_EXPIRY_STORAGE_KEY = 'audiomind.access_token_expiry'

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
