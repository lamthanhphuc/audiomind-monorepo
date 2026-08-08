import { createRoot } from 'react-dom/client'
import { act } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import BillingScene from './BillingScene'
import * as billing from '../../services/billing'
import * as auth from '../../services/auth'

vi.mock('../../services/billing')
vi.mock('../../services/auth')

const overviewFixture: billing.BillingOverview = {
  userId: 1,
  plan: 'FREE',
  standardPriceVnd: 79000,
  premiumPriceVnd: 168000,
  payosEnabled: true,
  quota: {
    plan: 'FREE',
    periodYyyymm: '202606',
    sttSecondsUsed: 120,
    geminiInputCharsUsed: 5000,
    sttSecondsLimit: 600,
    geminiInputCharsLimit: 50000,
  },
  invoices: [
    {
      orderCode: 1001,
      status: 'PENDING',
      amountVnd: 79000,
      description: 'AudioMind Standard',
      checkoutUrl: 'https://pay.payos.vn/web/1001',
    },
  ],
}

describe('BillingScene', () => {
  let container: HTMLDivElement
  let root: ReturnType<typeof createRoot>

  beforeEach(() => {
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
    vi.mocked(auth.getJwtPlan).mockReturnValue('FREE')
    vi.mocked(auth.getJwtRole).mockReturnValue('USER')
    vi.mocked(billing.getBillingOverview).mockResolvedValue(overviewFixture)
    vi.mocked(billing.checkoutSubscriptionPlan).mockResolvedValue({
      orderCode: 2002,
      checkoutUrl: 'https://pay.payos.vn/web/2002',
      status: 'PENDING',
      amountVnd: 79000,
    })
  })

  afterEach(() => {
    act(() => {
      root.unmount()
    })
    container.remove()
    vi.clearAllMocks()
  })

  it('renders quota meters and invoice list after load', async () => {
    await act(async () => {
      root.render(<BillingScene onCheckoutRedirect={vi.fn()} />)
    })

    await act(async () => {
      await Promise.resolve()
    })

    expect(container.querySelector('[data-testid="billing-scene"]')).toBeTruthy()
    expect(container.textContent).toContain('Quota STT')
    expect(container.textContent).toContain('Standard')
    expect(container.textContent).toContain('Premium')
    expect(container.textContent).toContain('#1001')
    expect(container.textContent).toContain('79.000')
  })

  it('starts PayOS checkout when upgrade clicked', async () => {
    await act(async () => {
      root.render(<BillingScene onCheckoutRedirect={vi.fn()} />)
    })

    await act(async () => {
      await Promise.resolve()
    })

    const upgradeButton = container.querySelector('.btn--primary') as HTMLButtonElement
    expect(upgradeButton).toBeTruthy()

    await act(async () => {
      upgradeButton.click()
      await Promise.resolve()
    })

    expect(billing.checkoutSubscriptionPlan).toHaveBeenCalledWith('STANDARD')
  })

  it('disables PayOS upgrade and shows notice when payosEnabled is false', async () => {
    await act(async () => {
      root.render(<BillingScene payosEnabled={false} />)
    })

    await act(async () => {
      await Promise.resolve()
    })

    expect(container.querySelector('[data-testid="billing-payos-disabled"]')).toBeTruthy()
    expect(container.textContent).toContain('Thanh toán PayOS chưa bật trên môi trường này')

    const upgradeButton = container.querySelector('.btn--primary') as HTMLButtonElement
    expect(upgradeButton).toBeTruthy()
    expect(upgradeButton.disabled).toBe(true)
    expect(upgradeButton.title).toContain('PayOS chưa bật')

    await act(async () => {
      upgradeButton.click()
      await Promise.resolve()
    })

    expect(billing.checkoutSubscriptionPlan).not.toHaveBeenCalled()
  })
})

