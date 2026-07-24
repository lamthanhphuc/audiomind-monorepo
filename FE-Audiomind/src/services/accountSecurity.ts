import { getAccessToken, setAccessToken } from './auth'
import { USER_API_BASE } from './config'

export type AccountSecurityOverview = {
  localPasswordEnabled: boolean
  tokensValidAfter?: string
  currentSession?: {
    issuedAt?: string
    expiresAt?: string
  }
  supportsLogoutAll: boolean
}

const authHeaders = (): HeadersInit => {
  const token = getAccessToken()
  if (!token) throw new Error('Phiên đăng nhập đã hết hạn')
  return {
    Authorization: `Bearer ${token}`,
    'Content-Type': 'application/json',
  }
}

const readMessage = async (response: Response, fallback: string): Promise<string> => {
  const body = await response.json().catch(() => null) as { message?: string; error?: string } | null
  return body?.message || body?.error || fallback
}

export const getAccountSecurityOverview = async (): Promise<AccountSecurityOverview> => {
  const response = await fetch(`${USER_API_BASE}/api/users/me/security`, { headers: authHeaders() })
  if (!response.ok) throw new Error(await readMessage(response, 'Không tải được trạng thái bảo mật'))
  return response.json() as Promise<AccountSecurityOverview>
}

export const changeAccountPassword = async (currentPassword: string, newPassword: string): Promise<void> => {
  const response = await fetch(`${USER_API_BASE}/api/users/me/security/password`, {
    method: 'PATCH',
    headers: authHeaders(),
    body: JSON.stringify({ currentPassword, newPassword }),
  })
  if (!response.ok) throw new Error(await readMessage(response, 'Không đổi được mật khẩu'))
  const body = await response.json().catch(() => null) as { accessToken?: string; expiresInSeconds?: number } | null
  if (body?.accessToken) setAccessToken(body.accessToken, body.expiresInSeconds)
}

export const logoutAllDevices = async (): Promise<void> => {
  const response = await fetch(`${USER_API_BASE}/api/users/me/security/logout-all`, {
    method: 'POST',
    headers: authHeaders(),
  })
  if (!response.ok) throw new Error(await readMessage(response, 'Không đăng xuất được mọi thiết bị'))
  const body = await response.json().catch(() => null) as { accessToken?: string; expiresInSeconds?: number } | null
  if (body?.accessToken) setAccessToken(body.accessToken, body.expiresInSeconds)
}
