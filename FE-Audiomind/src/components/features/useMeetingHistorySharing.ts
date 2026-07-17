import { useEffect, useMemo, useState } from 'react'

import type { Meeting } from '../../types'
import { getUserProfile } from '../../services/api'
import {
  getGoogleStatus,
  GOOGLE_GMAIL_SEND_SCOPE,
  hasGoogleGmailSendScope,
  missingGoogleLinkScopes,
  startGoogleLink,
  type GoogleStatus,
} from '../../services/googleIntegration'
import {
  inviteMeetingShare,
  isPendingMeetingShare,
  listMeetingShares,
  pendingShareInviteCopyText,
  pendingShareInviteNotice,
  revokeMeetingShare,
  revokePendingMeetingShare,
  shareListKey,
  type MeetingShare,
} from '../../services/meetingShare'
import { buildExistingUserMeetingUrl } from '../../utils/inviteAuth'
import { buildStudioPath } from '../../utils/studioRouting'
import {
  closeOAuthTab,
  completeOAuthNavigation,
  prepareOAuthTab,
} from '../../utils/openOAuthWindow'

const copyTextToClipboard = async (text: string): Promise<void> => {
  if (navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(text)
    return
  }

  const textarea = document.createElement('textarea')
  textarea.value = text
  textarea.setAttribute('readonly', 'true')
  textarea.style.position = 'fixed'
  textarea.style.top = '-9999px'
  document.body.appendChild(textarea)
  textarea.select()
  document.execCommand('copy')
  textarea.remove()
}

type UseMeetingHistorySharingOptions = {
  selectedMeetingSummary: Meeting | null | undefined
  oauthRefreshTick?: number
}

export function useMeetingHistorySharing({
  selectedMeetingSummary,
  oauthRefreshTick = 0,
}: UseMeetingHistorySharingOptions) {
  const selectedMeetingId = selectedMeetingSummary?.id ?? null
  const [shareNotice, setShareNotice] = useState<string | null>(null)
  const [shareInviteEmail, setShareInviteEmail] = useState('')
  const [shareInviteBusy, setShareInviteBusy] = useState(false)
  const [shareInviteError, setShareInviteError] = useState<string | null>(null)
  const [meetingShares, setMeetingShares] = useState<MeetingShare[]>([])
  const [shareGoogleStatus, setShareGoogleStatus] = useState<GoogleStatus | null>(null)
  const [shareUserEmail, setShareUserEmail] = useState<string | null>(null)
  const [gmailLinkBusy, setGmailLinkBusy] = useState(false)

  useEffect(() => {
    if (!selectedMeetingId) {
      setMeetingShares([])
      return
    }
    void listMeetingShares(selectedMeetingId)
      .then((items) => setMeetingShares(items))
      .catch(() => setMeetingShares([]))
  }, [selectedMeetingId])

  useEffect(() => {
    if (!selectedMeetingId) {
      setShareGoogleStatus(null)
      setShareUserEmail(null)
      return
    }
    let cancelled = false
    void getGoogleStatus()
      .then((status) => {
        if (!cancelled) setShareGoogleStatus(status)
      })
      .catch(() => {
        if (!cancelled) setShareGoogleStatus(null)
      })
    void getUserProfile()
      .then((profile) => {
        if (!cancelled) setShareUserEmail(profile.email || null)
      })
      .catch(() => {
        if (!cancelled) setShareUserEmail(null)
      })
    return () => {
      cancelled = true
    }
  }, [selectedMeetingId])

  useEffect(() => {
    if (!oauthRefreshTick || !selectedMeetingId) {
      return
    }
    void getGoogleStatus()
      .then((status) => setShareGoogleStatus(status))
      .catch(() => setShareGoogleStatus(null))
    setGmailLinkBusy(false)
    setShareNotice('Đã cập nhật quyền Gmail - bạn có thể gửi lời mời qua email.')
  }, [oauthRefreshTick, selectedMeetingId])

  const shareGmailEmailMismatch = useMemo(() => {
    if (!shareGoogleStatus?.googleEmail || !shareUserEmail) return false
    return shareGoogleStatus.googleEmail.trim().toLowerCase() !== shareUserEmail.trim().toLowerCase()
  }, [shareGoogleStatus, shareUserEmail])

  const shareMissingGmailScope = useMemo(() => {
    if (!shareGoogleStatus) return false
    return !hasGoogleGmailSendScope(shareGoogleStatus)
  }, [shareGoogleStatus])

  const handleShareMeetingLink = async () => {
    if (!selectedMeetingSummary) return
    const shareUrl = buildExistingUserMeetingUrl(window.location.origin, selectedMeetingSummary.id)
    try {
      await copyTextToClipboard(shareUrl)
      setShareNotice('Đã copy link chia sẻ workspace (mở meeting khi đăng nhập).')
    } catch {
      setShareNotice(shareUrl)
    }
    window.setTimeout(() => setShareNotice(null), 4000)
  }

  const handleCopyPendingInvite = async (share: MeetingShare) => {
    try {
      await copyTextToClipboard(
        pendingShareInviteCopyText(share, selectedMeetingSummary?.title, window.location.origin),
      )
      setShareNotice('Đã sao chép lời mời - gửi qua Zalo/Telegram nếu người nhận không thấy email.')
    } catch {
      setShareNotice('Không sao chép được - hãy copy thủ công.')
    }
  }

  const handleInviteShare = async () => {
    if (!selectedMeetingSummary) return
    const normalizedInviteEmail = shareInviteEmail.trim().toLowerCase()
    const wasPendingResend = meetingShares.some(
      (share) => isPendingMeetingShare(share)
        && share.email?.trim().toLowerCase() === normalizedInviteEmail,
    )
    setShareInviteBusy(true)
    setShareInviteError(null)
    try {
      const created = await inviteMeetingShare(selectedMeetingSummary.id, shareInviteEmail)
      const notice = isPendingMeetingShare(created)
        ? pendingShareInviteNotice(created, {
            resent: wasPendingResend,
            senderGoogleEmail: shareGoogleStatus?.googleEmail ?? null,
          })
        : 'Đã gửi lời mời - người nhận sẽ thấy thông báo trong app và email nếu đã cấu hình.'
      setShareInviteEmail('')
      setShareNotice(notice)
      setMeetingShares((current) => [
        ...current.filter((item) => shareListKey(item) !== shareListKey(created)),
        created,
      ])
      window.setTimeout(() => setShareInviteBusy(false), 2000)
      return
    } catch (error) {
      setShareInviteError(error instanceof Error ? error.message : 'Không mời được người dùng')
      setShareInviteBusy(false)
    }
  }

  const handleGrantGmailSendScope = () => {
    setGmailLinkBusy(true)
    const oauthTab = prepareOAuthTab()
    void (async () => {
      try {
        const fresh = await getGoogleStatus().catch(() => null)
        if (fresh && hasGoogleGmailSendScope(fresh)) {
          closeOAuthTab(oauthTab)
          setShareGoogleStatus(fresh)
          setShareNotice('Đã có quyền gửi email qua Gmail.')
          setGmailLinkBusy(false)
          return
        }
        const redirectAfter = buildStudioPath('files')
        const scopesToRequest = fresh ? missingGoogleLinkScopes(fresh) : [GOOGLE_GMAIL_SEND_SCOPE]
        const authorizationUrl = await startGoogleLink(
          scopesToRequest.length > 0 ? scopesToRequest : [GOOGLE_GMAIL_SEND_SCOPE],
          redirectAfter,
        )
        if (completeOAuthNavigation(oauthTab, authorizationUrl) === 'new_tab') {
          setShareNotice('Tab Google đã mở - hoàn tất cấp quyền ở tab đó, sau đó quay lại tab này.')
        } else {
          setShareNotice('Trình duyệt chặn tab mới - đang chuyển hướng trong tab hiện tại.')
        }
      } catch (error) {
        closeOAuthTab(oauthTab)
        setShareInviteError(error instanceof Error ? error.message : 'Không mở được liên kết Google')
        setGmailLinkBusy(false)
      }
    })()
  }

  const handleRevokeShare = async (share: MeetingShare) => {
    if (!selectedMeetingSummary) return
    try {
      if (isPendingMeetingShare(share)) {
        if (!share.email) {
          throw new Error('Không xác định được email lời mời')
        }
        await revokePendingMeetingShare(selectedMeetingSummary.id, share.email)
      } else if (share.sharedWithUserId != null) {
        await revokeMeetingShare(selectedMeetingSummary.id, share.sharedWithUserId)
      } else {
        throw new Error('Không xác định được người được chia sẻ')
      }
      setShareNotice('Đã thu hồi quyền truy cập.')
      setMeetingShares((current) => current.filter((item) => shareListKey(item) !== shareListKey(share)))
    } catch (error) {
      setShareInviteError(error instanceof Error ? error.message : 'Không thu hồi được quyền')
    }
  }

  return {
    shareNotice,
    shareInviteEmail,
    setShareInviteEmail,
    shareInviteBusy,
    shareInviteError,
    meetingShares,
    shareGoogleStatus,
    shareUserEmail,
    gmailLinkBusy,
    shareGmailEmailMismatch,
    shareMissingGmailScope,
    handleShareMeetingLink,
    handleCopyPendingInvite,
    handleInviteShare,
    handleGrantGmailSendScope,
    handleRevokeShare,
  }
}
