import { getAccessToken } from './auth'
import { USER_API_BASE } from './config'

export type UsageEvent = {
  id: number
  quotaType: string
  status: string
  periodYyyymm: string
  sttSecondsDelta: number
  geminiCharsDelta: number
  createdAt: string
}

export type UsageDay = {
  day: string
  sttSeconds: number
  geminiChars: number
  deniedCount: number
}

export type UsageDetail = {
  snapshot: {
    plan: string
    periodYyyymm: string
    sttSecondsUsed: number
    geminiInputCharsUsed: number
    sttSecondsLimit: number
    geminiInputCharsLimit: number
  }
  daily: UsageDay[]
  events: UsageEvent[]
}

export const getUsageDetail = async (days = 30): Promise<UsageDetail> => {
  const token = getAccessToken()
  if (!token) throw new Error('Phiên đăng nhập đã hết hạn')
  const response = await fetch(`${USER_API_BASE}/api/users/me/usage?days=${days}&limit=200`, {
    headers: { Authorization: `Bearer ${token}` },
  })
  if (!response.ok) throw new Error('Không tải được lịch sử sử dụng')
  return response.json() as Promise<UsageDetail>
}
