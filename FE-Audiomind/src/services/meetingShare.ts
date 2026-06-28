import { getAccessToken } from './auth'
import { MEETING_API_BASE, PUBLIC_FRONTEND_ORIGIN } from './config'
import { buildInviteRegisterUrl } from '../utils/inviteAuth'

export type MeetingShareStatus = 'ACTIVE' | 'PENDING'

export type ShareEmailChannel = 'GMAIL' | 'SMTP' | 'NONE'

export type MeetingShare = {
  id: number
  meetingId: number
  role: string
  invitedByUserId: number
  createdAt?: string
  status?: MeetingShareStatus
  sharedWithUserId?: number
  email?: string
  username?: string
  emailSent?: boolean
  emailChannel?: ShareEmailChannel
  requiresGmailScope?: boolean
  emailFrom?: string
}

export const formatShareLabel = (share: MeetingShare): string => {
  const email = share.email?.trim()
  if (email) {
    return email
  }
  const username = share.username?.trim()
  if (username) {
    return username
  }
  return 'Người được chia sẻ'
}

const authHeaders = (): HeadersInit => {
  const token = getAccessToken()
  if (!token) throw new Error('Phiên đăng nhập đã hết hạn')
  return {
    Authorization: `Bearer ${token}`,
    'Content-Type': 'application/json',
  }
}

export const listMeetingShares = async (meetingId: number): Promise<MeetingShare[]> => {
  const response = await fetch(`${MEETING_API_BASE}/meetings/${meetingId}/shares`, {
    headers: authHeaders(),
  })
  if (!response.ok) {
    const payload = await response.json().catch(() => null) as { message?: string } | null
    throw new Error(payload?.message || `Không tải được danh sách chia sẻ (${response.status})`)
  }
  return response.json() as Promise<MeetingShare[]>
}

export const inviteMeetingShare = async (
  meetingId: number,
  email: string,
  role: string = 'VIEWER',
): Promise<MeetingShare> => {
  const response = await fetch(`${MEETING_API_BASE}/meetings/${meetingId}/shares`, {
    method: 'POST',
    headers: authHeaders(),
    body: JSON.stringify({ email, role }),
  })
  if (!response.ok) {
    const payload = await response.json().catch(() => null) as { message?: string } | null
    throw new Error(payload?.message || `Không mời được người dùng (${response.status})`)
  }
  const share = await response.json() as MeetingShare
  return share
}

export const revokeMeetingShare = async (meetingId: number, sharedWithUserId: number): Promise<void> => {
  const response = await fetch(`${MEETING_API_BASE}/meetings/${meetingId}/shares/${sharedWithUserId}`, {
    method: 'DELETE',
    headers: authHeaders(),
  })
  if (!response.ok) {
    const payload = await response.json().catch(() => null) as { message?: string } | null
    throw new Error(payload?.message || `Không thu hồi được quyền (${response.status})`)
  }
}

export const revokePendingMeetingShare = async (meetingId: number, email: string): Promise<void> => {
  const response = await fetch(
    `${MEETING_API_BASE}/meetings/${meetingId}/shares/pending?email=${encodeURIComponent(email)}`,
    {
      method: 'DELETE',
      headers: authHeaders(),
    },
  )
  if (!response.ok) {
    const payload = await response.json().catch(() => null) as { message?: string } | null
    throw new Error(payload?.message || `Không thu hồi được lời mời (${response.status})`)
  }
}

export const isPendingMeetingShare = (share: MeetingShare): boolean => share.status === 'PENDING'

export const pendingShareInviteCopyText = (
  share: MeetingShare,
  meetingTitle?: string | null,
  frontendOrigin?: string | null,
): string => {
  const email = share.email?.trim() || 'email được mời'
  const title = meetingTitle?.trim() || 'cuộc họp AudioMind'
  const base = frontendOrigin?.trim() || PUBLIC_FRONTEND_ORIGIN.trim() || 'http://localhost:8080'
  const meetingId = share.meetingId
  if (!Number.isFinite(meetingId) || meetingId <= 0) {
    throw new Error('Pending share invite requires a valid meeting id')
  }
  const registerUrl = buildInviteRegisterUrl(base, meetingId)
  return [
    `Bạn được mời xem cuộc họp «${title}» trên AudioMind.`,
    '',
    `Đăng ký bằng đúng email: ${email}`,
    `Link đăng ký: ${registerUrl}`,
    'Sau khi đăng ký, quyền truy cập sẽ được kích hoạt tự động.',
  ].join('\n')
}

export const pendingShareInviteNotice = (
  share: MeetingShare,
  options?: { resent?: boolean; senderGoogleEmail?: string | null },
): string => {
  const sender = (share.emailFrom ?? options?.senderGoogleEmail)?.trim()
  if (options?.resent && share.emailSent) {
    return sender
      ? `Đã gửi lại email mời từ ${sender}. Kiểm tra mục Đã gửi trong Gmail đó và hộp thư đến/Spam của người nhận.`
      : 'Đã gửi lại email mời.'
  }
  if (share.emailChannel === 'GMAIL' && share.emailSent) {
    return sender
      ? `Đã gửi từ ${sender} (xem mục Đã gửi). Người nhận: tìm "AudioMind" hoặc tên bạn trong Tất cả thư — kể cả Quảng cáo/Spam. Dùng nút Sao chép lời mời nếu họ không thấy mail.`
      : 'Đã gửi lời mời từ Gmail — tìm "AudioMind" trong Đã gửi; người nhận kiểm tra Tất cả thư / Quảng cáo / Spam.'
  }
  if (share.emailChannel === 'SMTP' && share.emailSent) {
    return 'Đã gửi từ hệ thống — Reply-To là email của bạn. Quyền truy cập sẽ được kích hoạt khi họ đăng ký bằng cùng email.'
  }
  if (share.requiresGmailScope) {
    return 'Đã lưu lời mời. Cấp quyền Gmail để gửi mail tự động.'
  }
  return 'Đã lưu lời mời pending. Email chưa gửi được (cấu hình SMTP/Gmail trên server). Người nhận vẫn nhận quyền khi đăng ký bằng cùng email.'
}

export const shareListKey = (share: MeetingShare): string => {
  if (isPendingMeetingShare(share)) {
    return `pending:${share.email ?? share.id}`
  }
  return `active:${share.sharedWithUserId ?? share.id}`
}
