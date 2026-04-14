import { afterEach, describe, expect, it, vi } from 'vitest'

import { clearAccessToken, getAccessToken, login, setAccessToken } from './auth'

const originalFetch = global.fetch

afterEach(() => {
  localStorage.clear()
  if (originalFetch) {
    global.fetch = originalFetch
  }
  vi.restoreAllMocks()
})

describe('auth service', () => {
  it('stores and clears access token in localStorage', () => {
    setAccessToken('token-abc')
    expect(getAccessToken()).toBe('token-abc')

    clearAccessToken()
    expect(getAccessToken()).toBeNull()
  })

  it('returns null and clears token when token is expired', () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z'))

    setAccessToken('token-expired', 1)
    vi.advanceTimersByTime(1_500)

    expect(getAccessToken()).toBeNull()
    expect(localStorage.getItem('audiomind.access_token')).toBeNull()

    vi.useRealTimers()
  })

  it('keeps token while expiry is still in the future (refresh flow absent)', () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z'))

    setAccessToken('token-valid', 120)
    vi.advanceTimersByTime(1_000)

    expect(getAccessToken()).toBe('token-valid')

    vi.useRealTimers()
  })

  it('returns auth response on successful login', async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        userId: 1,
        accessToken: 'access-1',
        expiresInSeconds: 120,
      }),
    })

    const result = await login({ username: 'demo', password: 'secret' })

    expect(result.userId).toBe(1)
    expect(result.accessToken).toBe('access-1')
    expect(result.expiresInSeconds).toBe(120)
  })

  it('throws when login response misses access token', async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ userId: 1, expiresInSeconds: 120 }),
    })

    await expect(login({ username: 'demo', password: 'secret' })).rejects.toThrow(
      'Login response did not contain accessToken',
    )
  })
})
