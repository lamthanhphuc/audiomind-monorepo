import { afterEach, describe, expect, it, vi } from 'vitest'
import { changeAccountPassword, getAccountSecurityOverview, logoutAllDevices } from './accountSecurity'
import {
  createUserApiKey,
  listAdminTransactions,
  listAuditEvents,
  listUserApiKeys,
  revokeUserApiKey,
} from './admin'
import { clearAccessToken, getAccessToken, setAccessToken } from './auth'
import { getUsageDetail } from './usage'
import { getWorkspaceSummary } from './workspace'

const originalFetch = globalThis.fetch

afterEach(() => {
  clearAccessToken()
  if (originalFetch) {
    globalThis.fetch = originalFetch
  }
  vi.restoreAllMocks()
})

describe('account security service', () => {
  it('loads security overview with bearer auth', async () => {
    setAccessToken('token-1')
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ localPasswordEnabled: true, supportsLogoutAll: true }),
    })

    const result = await getAccountSecurityOverview()

    expect(result.localPasswordEnabled).toBe(true)
    expect(globalThis.fetch).toHaveBeenCalledWith(
      expect.stringContaining('/api/users/me/security'),
      expect.objectContaining({
        headers: expect.objectContaining({ Authorization: 'Bearer token-1' }),
      }),
    )
  })

  it('changes password and stores refreshed access token', async () => {
    setAccessToken('old-token')
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ accessToken: 'new-token', expiresInSeconds: 120 }),
    })

    await changeAccountPassword('old-pass', 'new-password')

    expect(getAccessToken()).toBe('new-token')
    expect(globalThis.fetch).toHaveBeenCalledWith(
      expect.stringContaining('/api/users/me/security/password'),
      expect.objectContaining({
        method: 'PATCH',
        body: JSON.stringify({ currentPassword: 'old-pass', newPassword: 'new-password' }),
      }),
    )
  })

  it('logs out all devices and keeps the refreshed current session token', async () => {
    setAccessToken('old-token')
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ accessToken: 'fresh-token' }),
    })

    await logoutAllDevices()

    expect(getAccessToken()).toBe('fresh-token')
    expect(globalThis.fetch).toHaveBeenCalledWith(
      expect.stringContaining('/api/users/me/security/logout-all'),
      expect.objectContaining({ method: 'POST' }),
    )
  })
})

describe('usage service', () => {
  it('loads usage detail with the requested day window', async () => {
    setAccessToken('usage-token')
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ snapshot: { plan: 'FREE' }, daily: [], events: [] }),
    })

    const result = await getUsageDetail(14)

    expect(result.daily).toEqual([])
    expect(globalThis.fetch).toHaveBeenCalledWith(
      expect.stringContaining('/api/users/me/usage?days=14&limit=200'),
      expect.objectContaining({
        headers: expect.objectContaining({ Authorization: 'Bearer usage-token' }),
      }),
    )
  })
})

describe('workspace service', () => {
  it('loads the current workspace summary', async () => {
    setAccessToken('workspace-token')
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ ownedMeetingCount: 2, members: [], pendingInvites: [], sharedMeetings: [] }),
    })

    const result = await getWorkspaceSummary()

    expect(result.ownedMeetingCount).toBe(2)
    expect(globalThis.fetch).toHaveBeenCalledWith(
      expect.stringContaining('/api/workspaces/me'),
      expect.objectContaining({
        headers: expect.objectContaining({ Authorization: 'Bearer workspace-token' }),
      }),
    )
  })
})

describe('admin audit service', () => {
  it('passes audit filters as query parameters', async () => {
    setAccessToken('admin-token')
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ items: [{ id: 1, eventType: 'ADMIN_ROLE_CHANGED', summary: 'Role changed' }] }),
    })

    const result = await listAuditEvents({
      actorUserId: 7,
      eventType: 'admin_role_changed',
      from: '2026-07-01T00:00:00.000Z',
      to: '2026-07-23T23:59:59.999Z',
      limit: 50,
    })

    const calledUrl = String(vi.mocked(globalThis.fetch).mock.calls[0][0])
    expect(result).toHaveLength(1)
    expect(calledUrl).toContain('/api/admin/audit-events?')
    expect(calledUrl).toContain('actorUserId=7')
    expect(calledUrl).toContain('eventType=ADMIN_ROLE_CHANGED')
    expect(calledUrl).toContain('limit=50')
  })
})

describe('admin API key service', () => {
  it('lists, creates and revokes user API keys', async () => {
    setAccessToken('admin-token')
    globalThis.fetch = vi.fn()
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ items: [{ id: 1, name: 'Automation', suffix: 'abc123' }] }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ id: 2, name: 'New key', apiKey: 'am_secret' }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ id: 2, name: 'New key', revokedAt: '2026-07-23T00:00:00Z' }),
      })

    const keys = await listUserApiKeys(42)
    const created = await createUserApiKey(42, { name: 'New key', scopes: 'read,write' })
    const revoked = await revokeUserApiKey(42, 2)

    expect(keys[0].name).toBe('Automation')
    expect(created.apiKey).toBe('am_secret')
    expect(revoked.revokedAt).toBeTruthy()
    expect(globalThis.fetch).toHaveBeenNthCalledWith(2,
      expect.stringContaining('/api/admin/users/42/api-keys'),
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ name: 'New key', scopes: 'read,write' }),
      }),
    )
    expect(globalThis.fetch).toHaveBeenNthCalledWith(3,
      expect.stringContaining('/api/admin/users/42/api-keys/2'),
      expect.objectContaining({ method: 'DELETE' }),
    )
  })
})

describe('admin transaction service', () => {
  it('passes transaction filters as query parameters', async () => {
    setAccessToken('admin-token')
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        items: [{
          id: 1,
          userId: 42,
          username: 'alice',
          email: 'alice@example.com',
          orderCode: 9001,
          status: 'PAID',
        }],
      }),
    })

    const result = await listAdminTransactions({ userId: 42, status: 'paid', limit: 25 })

    const calledUrl = String(vi.mocked(globalThis.fetch).mock.calls[0][0])
    expect(result[0].orderCode).toBe(9001)
    expect(result[0].username).toBe('alice')
    expect(result[0].email).toBe('alice@example.com')
    expect(calledUrl).toContain('/api/admin/billing/transactions?')
    expect(calledUrl).toContain('userId=42')
    expect(calledUrl).toContain('status=PAID')
    expect(calledUrl).toContain('limit=25')
  })
})
