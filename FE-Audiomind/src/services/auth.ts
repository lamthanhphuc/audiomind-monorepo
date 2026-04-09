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

export const getAccessToken = (): string | null => {
  return localStorage.getItem(TOKEN_STORAGE_KEY)
}

export const setAccessToken = (token: string): void => {
  localStorage.setItem(TOKEN_STORAGE_KEY, token)
}

export const clearAccessToken = (): void => {
  localStorage.removeItem(TOKEN_STORAGE_KEY)
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
