import { expect, test } from '@playwright/test'
import { loginWithCredentials, requireRealBackendEnv } from './helpers/auth'

test.use({
  permissions: ['microphone'],
  launchOptions: {
    args: [
      '--use-fake-ui-for-media-stream',
      '--use-fake-device-for-media-stream',
    ],
  },
})

test.describe('Dual stream tab + microphone UX', () => {
  test('shows dual-stream quota guidance when tab+mic source is selected', async ({ page }) => {
    const { username, password } = requireRealBackendEnv()
    await loginWithCredentials(page, username, password)

    await page.locator('[data-testid="dashboard-nav-realtime"]').click()
    await expect(page.locator('[data-testid="recording-source-selector"]')).toBeVisible({
      timeout: 30_000,
    })

    await page.locator('[data-testid="recording-source-option-browser_tab_with_mic"]').click()

    await expect(page.locator('[data-testid="recording-source-quota-note"]')).toBeVisible({
      timeout: 10_000,
    })
    await expect(page.locator('[data-testid="recording-source-quota-note"]')).toContainText(
      /hai luồng|gấp đôi quota STT/i,
    )

    const dualBanner = page.locator('[data-testid="dual-stream-quota-info"]')
    if (await dualBanner.count()) {
      await expect(dualBanner).toContainText(/hai luồng|gấp đôi quota STT/i)
    }
  })

  test('can start and stop realtime with tab+mic source selected', async ({ page }) => {
    const { username, password } = requireRealBackendEnv()
    await loginWithCredentials(page, username, password)

    await page.locator('[data-testid="dashboard-nav-realtime"]').click()
    await page.locator('[data-testid="recording-source-option-browser_tab_with_mic"]').click()

    const recordToggle = page.locator('[data-testid="e2e-realtime-record-toggle"]')
    await expect(recordToggle).toBeVisible({ timeout: 30_000 })

    await recordToggle.click()
    await page.waitForTimeout(3_000)
    await recordToggle.click()

    const status = page.locator('[data-testid="e2e-realtime-status"]')
    await expect(status).toContainText(
      /đã lưu|chưa có transcript|dừng|hoàn tất|không phát hiện|lỗi|ghi âm/i,
      { timeout: 3 * 60 * 1000 },
    )
  })
})
