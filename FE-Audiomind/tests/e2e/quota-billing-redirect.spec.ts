import { expect, test } from '@playwright/test'
import { loginWithCredentials, requireRealBackendEnv } from './helpers/auth'

test.describe('Quota UX billing redirect', () => {
  test('high quota usage shows warning banner on upload', async ({ page }) => {
    const { username, password } = requireRealBackendEnv()

    await page.route('**/billing/me**', async (route) => {
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
            sttSecondsUsed: 570,
            sttSecondsLimit: 600,
            geminiInputCharsUsed: 1000,
            geminiInputCharsLimit: 50000,
          },
          invoices: [],
        }),
      })
    })

    await loginWithCredentials(page, username, password)
    await page.locator('[data-testid="dashboard-nav-history"]').waitFor({ state: 'visible', timeout: 30_000 })
    await page.goto('/upload', { waitUntil: 'domcontentloaded' })
    await expect(page.locator('[data-testid="quota-warning-banner"]')).toBeVisible({ timeout: 30_000 })
    await expect(page.locator('[data-testid="quota-warning-banner"]')).toContainText(/STT gần hết quota/i)
  })

  test('upload quota error redirects to billing with notice', async ({ page }) => {
    const { username, password } = requireRealBackendEnv()

    await page.route('**/processing/upload**', async (route) => {
      await route.fulfill({
        status: 402,
        contentType: 'application/json',
        body: JSON.stringify({
          errorCode: 'QUOTA_EXCEEDED',
          message: 'Bạn đã vượt quota sử dụng tháng này. Nâng cấp Pro để tiếp tục.',
          status: 402,
        }),
      })
    })

    await loginWithCredentials(page, username, password)
    await page.goto('/upload', { waitUntil: 'domcontentloaded' })

    const fileInput = page.locator('input[type="file"]')
    await fileInput.setInputFiles({
      name: 'quota-test.wav',
      mimeType: 'audio/wav',
      buffer: Buffer.from('RIFF....WAVEfmt '),
    })
    await page.locator('[data-testid="e2e-process-submit"]').click()

    await expect(page.locator('[data-testid="billing-scene"]')).toBeVisible({ timeout: 30_000 })
    await expect(page.locator('[data-testid="billing-notice"]')).toContainText(/quota/i, { timeout: 30_000 })
  })
})
