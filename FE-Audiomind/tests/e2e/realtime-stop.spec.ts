import { expect, test } from '@playwright/test'
import { loginWithCredentials, openMeetingHistory, requireRealBackendEnv } from './helpers/auth'

test.describe('Realtime stop flow', () => {
  test.use({
    permissions: ['microphone'],
    launchOptions: {
      args: [
        '--use-fake-ui-for-media-stream',
        '--use-fake-device-for-media-stream',
      ],
    },
  })

  test('start realtime session, stop, and surface terminal status', async ({ page }) => {
    const { username, password } = requireRealBackendEnv()
    await loginWithCredentials(page, username, password)

    await page.locator('[data-testid="dashboard-nav-realtime"]').click()
    const recordToggle = page.locator('[data-testid="e2e-realtime-record-toggle"]')
    await expect(recordToggle).toBeVisible({ timeout: 30_000 })

    await recordToggle.click()
    await page.waitForTimeout(4_000)

    await recordToggle.click()

    const status = page.locator('[data-testid="e2e-realtime-status"]')
    await expect(status).toContainText(
      /đã lưu|chưa có transcript|dừng|hoàn tất|không phát hiện|lỗi/i,
      { timeout: 3 * 60 * 1000 },
    )

    await openMeetingHistory(page)
    await expect(page.locator('[data-testid="meeting-list"] button').first()).toBeVisible({
      timeout: 60_000,
    })
  })
})
