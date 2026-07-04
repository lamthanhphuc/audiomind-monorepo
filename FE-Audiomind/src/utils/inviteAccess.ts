import { ApiError, getMeetingDetail } from '../services/api'

export type InvitedMeetingAccess = 'ok' | 'forbidden' | 'unknown'

export const INVITE_ACCESS_NOTICE =
  'Không mở được cuộc họp được mời. Hãy đăng nhập bằng đúng email trong lời mời, hoặc liên hệ người gửi lời mời.'

export async function probeInvitedMeetingAccess(
  meetingId: number,
  options?: { signal?: AbortSignal },
): Promise<InvitedMeetingAccess> {
  try {
    await getMeetingDetail(meetingId, { signal: options?.signal })
    return 'ok'
  } catch (error) {
    if (error instanceof ApiError && error.status === 403) {
      return 'forbidden'
    }
    return 'unknown'
  }
}
