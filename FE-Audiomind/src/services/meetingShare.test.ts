import { describe, expect, it } from 'vitest'

import {
  formatShareLabel,
  pendingShareInviteCopyText,
  pendingShareInviteNotice,
} from './meetingShare'

describe('formatShareLabel', () => {
  it('prefers email over username', () => {
    expect(formatShareLabel({
      id: 1,
      meetingId: 10,
      role: 'VIEWER',
      invitedByUserId: 2,
      email: 'alice@example.com',
      username: 'alice',
    })).toBe('alice@example.com')
  })

  it('falls back to username when email is missing', () => {
    expect(formatShareLabel({
      id: 1,
      meetingId: 10,
      role: 'VIEWER',
      invitedByUserId: 2,
      username: 'bob',
      sharedWithUserId: 3,
    })).toBe('bob')
  })

  it('never exposes user id in the label', () => {
    expect(formatShareLabel({
      id: 1,
      meetingId: 10,
      role: 'VIEWER',
      invitedByUserId: 2,
      sharedWithUserId: 3,
    })).toBe('Người được chia sẻ')
  })
})

describe('pendingShareInviteNotice', () => {
  const basePending = {
    id: 1,
    meetingId: 52,
    role: 'VIEWER',
    invitedByUserId: 1,
    email: 'guest@example.com',
    status: 'PENDING' as const,
  }

  it('shows gmail channel message with sender email', () => {
    expect(pendingShareInviteNotice({
      ...basePending,
      emailSent: true,
      emailChannel: 'GMAIL',
    }, { senderGoogleEmail: 'owner@gmail.com' })).toContain('owner@gmail.com')
  })

  it('prefers emailFrom from API over google status', () => {
    expect(pendingShareInviteNotice({
      ...basePending,
      emailSent: true,
      emailChannel: 'GMAIL',
      emailFrom: 'linked@gmail.com',
    }, { senderGoogleEmail: 'other@gmail.com' })).toContain('linked@gmail.com')
  })

  it('shows gmail channel fallback without sender email', () => {
    expect(pendingShareInviteNotice({
      ...basePending,
      emailSent: true,
      emailChannel: 'GMAIL',
    })).toContain('Quảng cáo')
  })

  it('shows smtp fallback message', () => {
    expect(pendingShareInviteNotice({
      ...basePending,
      emailSent: true,
      emailChannel: 'SMTP',
    })).toContain('Reply-To')
  })

  it('shows gmail scope cta message', () => {
    expect(pendingShareInviteNotice({
      ...basePending,
      emailSent: false,
      requiresGmailScope: true,
    })).toContain('Cấp quyền Gmail')
  })

  it('shows resend message', () => {
    expect(pendingShareInviteNotice({
      ...basePending,
      emailSent: true,
      emailChannel: 'GMAIL',
    }, { resent: true, senderGoogleEmail: 'owner@gmail.com' })).toContain('Đã gửi lại email mời')
  })

  it('explains when email could not be sent', () => {
    expect(pendingShareInviteNotice({
      ...basePending,
      emailSent: false,
    })).toContain('Email chưa gửi được')
  })
})

describe('pendingShareInviteCopyText', () => {
  const pendingShare = {
    id: 1,
    meetingId: 52,
    role: 'VIEWER',
    invitedByUserId: 1,
    email: 'guest@example.com',
    status: 'PENDING' as const,
  }

  it('includes register link from frontend origin', () => {
    const text = pendingShareInviteCopyText(pendingShare, 'Họp tuần', 'http://localhost:8080')
    expect(text).toContain('http://localhost:8080/register?openMeeting=52')
    expect(text).toContain('guest@example.com')
    expect(text).toContain('Họp tuần')
  })
})
