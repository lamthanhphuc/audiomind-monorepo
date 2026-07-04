import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  formatCharsShort,
  formatDurationShort,
  formatQuotaPercent,
  getBillingOrderStatus,
  pollBillingActivation,
} from './billing'

describe('billing service formatters', () => {
  beforeEach(() => {
    localStorage.clear()
    localStorage.setItem('audiomind.access_token', 'test-jwt')
    vi.restoreAllMocks()
  })

  it('formatQuotaPercent clamps to 100', () => {
    expect(formatQuotaPercent(90, 100)).toBe(90)
    expect(formatQuotaPercent(150, 100)).toBe(100)
    expect(formatQuotaPercent(0, 0)).toBe(0)
  })

  it('formatDurationShort renders hours and minutes', () => {
    expect(formatDurationShort(0)).toBe('0 phút')
    expect(formatDurationShort(125)).toBe('2 phút')
    expect(formatDurationShort(3660)).toBe('1g 1p')
  })

  it('formatCharsShort renders K/M suffixes', () => {
    expect(formatCharsShort(900)).toBe('900')
    expect(formatCharsShort(1500)).toBe('1.5K')
    expect(formatCharsShort(2_500_000)).toBe('2.5M')
  })

  it('pollBillingActivation syncs then polls until invoice is PAID', async () => {
    vi.useFakeTimers()
    const fetchMock = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response(JSON.stringify({
        orderCode: 9001,
        status: 'PAID',
        amountVnd: 79000,
      }), { status: 200, headers: { 'Content-Type': 'application/json' } }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        orderCode: 9001,
        status: 'PAID',
        amountVnd: 79000,
      }), { status: 200, headers: { 'Content-Type': 'application/json' } }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        userId: 1,
        plan: 'PRO',
        quota: {
          plan: 'PRO',
          periodYyyymm: '202606',
          sttSecondsUsed: 0,
          geminiInputCharsUsed: 0,
          sttSecondsLimit: 36000,
          geminiInputCharsLimit: 5000000,
        },
        invoices: [],
      }), { status: 200, headers: { 'Content-Type': 'application/json' } }))

    const pollPromise = pollBillingActivation(9001, { maxAttempts: 1 })
    await vi.advanceTimersByTimeAsync(0)
    const result = await pollPromise

    expect(result.invoice.status).toBe('PAID')
    expect(fetchMock.mock.calls.some(([url, init]) => String(url).includes('/api/billing/orders/9001/sync') && init?.method === 'POST')).toBe(true)
    vi.useRealTimers()
  })

  it('getBillingOrderStatus fetches order by code', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(new Response(JSON.stringify({
      orderCode: 42,
      status: 'PENDING',
      amountVnd: 79000,
    }), { status: 200, headers: { 'Content-Type': 'application/json' } }))

    const invoice = await getBillingOrderStatus(42)
    expect(invoice.orderCode).toBe(42)
    expect(invoice.status).toBe('PENDING')
  })
})
