import { describe, expect, it } from 'vitest'

import {
  appendOpenMeetingQuery,
  buildInviteGoogleRedirectAfter,
  buildInviteRegisterUrl,
  buildExistingUserMeetingUrl,
  readOpenMeetingId,
  resolvePostAuthDestination,
  resolveDestinationFromRedirectAfter,
} from './inviteAuth'

describe('inviteAuth', () => {
  it('readOpenMeetingId parses valid id', () => {
    expect(readOpenMeetingId('?openMeeting=15')).toBe(15)
  })

  it('readOpenMeetingId returns null for invalid id', () => {
    expect(readOpenMeetingId('?openMeeting=abc')).toBeNull()
    expect(readOpenMeetingId('')).toBeNull()
  })

  it('buildInviteRegisterUrl includes openMeeting', () => {
    expect(buildInviteRegisterUrl('http://localhost:8080/', 52))
      .toBe('http://localhost:8080/register?openMeeting=52')
  })

  it('buildExistingUserMeetingUrl uses root openMeeting deep link', () => {
    expect(buildExistingUserMeetingUrl('http://localhost:8080/', 7))
      .toBe('http://localhost:8080/?openMeeting=7')
  })

  it('buildInviteGoogleRedirectAfter uses analysis path when invited', () => {
    expect(buildInviteGoogleRedirectAfter('?openMeeting=15'))
      .toBe('/studio/analysis?meetingId=15')
  })

  it('buildInviteGoogleRedirectAfter defaults to root without invite', () => {
    expect(buildInviteGoogleRedirectAfter('')).toBe('/')
  })

  it('appendOpenMeetingQuery preserves only openMeeting', () => {
    expect(appendOpenMeetingQuery('/register', '?openMeeting=15&ticket=abc'))
      .toBe('/register?openMeeting=15')
    expect(appendOpenMeetingQuery('/login', '')).toBe('/login')
  })

  it('resolvePostAuthDestination defaults to upload', () => {
    expect(resolvePostAuthDestination('')).toEqual({ scene: 'upload', meetingId: null })
  })

  it('resolvePostAuthDestination opens analysis for invite', () => {
    expect(resolvePostAuthDestination('?openMeeting=9')).toEqual({ scene: 'analysis', meetingId: 9 })
  })

  it('resolveDestinationFromRedirectAfter parses analysis meetingId', () => {
    expect(resolveDestinationFromRedirectAfter('/studio/analysis?meetingId=15')).toEqual({
      scene: 'analysis',
      meetingId: 15,
    })
  })

  it('resolveDestinationFromRedirectAfter parses openMeeting on redirect', () => {
    expect(resolveDestinationFromRedirectAfter('/?openMeeting=9')).toEqual({
      scene: 'analysis',
      meetingId: 9,
    })
  })

  it('resolveDestinationFromRedirectAfter defaults to upload', () => {
    expect(resolveDestinationFromRedirectAfter('/')).toEqual({ scene: 'upload', meetingId: null })
    expect(resolveDestinationFromRedirectAfter(null)).toEqual({ scene: 'upload', meetingId: null })
    expect(resolveDestinationFromRedirectAfter('//evil.com')).toEqual({ scene: 'upload', meetingId: null })
  })
})
