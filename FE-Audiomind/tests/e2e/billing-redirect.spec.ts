import { expect, test } from '@playwright/test'
import { loginWithCredentials, requireRealBackendEnv } from './helpers/auth'

const payosEnabled = process.env.SMOKE_PAYOS_ENABLED === '1'

test.describe('Billing PayOS redirect', () => {
  test.skip(!payosEnabled, 'PayOS billing UI is disabled in CI smoke stack')

  test('billing success route polls activation and shows notice', async ({ page }) => {
    const { username, password } = requireRealBackendEnv()

    await loginWithCredentials(page, username, password)

    await page.route('**/billing/orders/**', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          orderCode: 9001,
          status: 'PAID',
          amount: 99000,
          plan: 'PRO',
        }),
      })
    })

    await page.route('**/billing/overview**', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          plan: 'PRO',
          quota: {
            sttSecondsUsed: 0,
            sttSecondsLimit: 3600,
            geminiInputCharsUsed: 0,
            geminiInputCharsLimit: 500000,
          },
          invoices: [],
        }),
      })
    })

    await page.goto('/billing/success?orderCode=9001', { waitUntil: 'domcontentloaded' })

    await expect(page.locator('[data-testid="billing-scene"]')).toBeVisible({ timeout: 30_000 })
    await expect(page.locator('[data-testid="billing-notice"]')).toContainText(/thành công|Pro/i, {
      timeout: 30_000,
    })
  })

  test('billing nav opens scene and upgrade calls checkout when PayOS enabled', async ({ page }) => {
    const { username, password } = requireRealBackendEnv()

    let checkoutRequested = false
    await page.route('**/billing/checkout**', async (route) => {
      checkoutRequested = true
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          checkoutUrl: 'https://pay.payos.vn/web/test-checkout',
          orderCode: 8001,
        }),
      })
    })

    await page.route('**/billing/overview**', async (route) => {
      if (route.request().method() !== 'GET') {
        await route.continue()
        return
      }
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          plan: 'FREE',
          quota: {
            sttSecondsUsed: 100,
            sttSecondsLimit: 3600,
            geminiInputCharsUsed: 1000,
            geminiInputCharsLimit: 500000,
          },
          invoices: [],
        }),
      })
    })

    await loginWithCredentials(page, username, password)
    await page.locator('[data-testid="dashboard-nav-billing"]').click()
    await expect(page.locator('[data-testid="billing-scene"]')).toBeVisible({ timeout: 30_000 })

    const upgradeButton = page.getByRole('button', { name: /nâng cấp|upgrade|pro/i })
    if (await upgradeButton.isVisible()) {
      await upgradeButton.click()
      await expect.poll(() => checkoutRequested, { timeout: 15_000 }).toBe(true)
    }
  })
})
