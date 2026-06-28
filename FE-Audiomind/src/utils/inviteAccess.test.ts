import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../services/api', async () => {
  const actual = await vi.importActual<typeof import('../services/api')>('../services/api')
  return {
    ...actual,
    getMeetingDetail: vi.fn(),
  }
})

import { ApiError, getMeetingDetail } from '../services/api'
import { probeInvitedMeetingAccess } from './inviteAccess'

describe('probeInvitedMeetingAccess', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
  })

  it('returns ok when meeting detail loads', async () => {
    vi.mocked(getMeetingDetail).mockResolvedValue({ id: 15 } as Awaited<ReturnType<typeof getMeetingDetail>>)

    await expect(probeInvitedMeetingAccess(15)).resolves.toBe('ok')
  })

  it('returns forbidden on 403', async () => {
    vi.mocked(getMeetingDetail).mockRejectedValue(new ApiError('Forbidden', 403))

    await expect(probeInvitedMeetingAccess(15)).resolves.toBe('forbidden')
  })

  it('returns unknown on other errors', async () => {
    vi.mocked(getMeetingDetail).mockRejectedValue(new Error('network'))

    await expect(probeInvitedMeetingAccess(15)).resolves.toBe('unknown')
  })
})
