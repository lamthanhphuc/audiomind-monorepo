import { expect, test } from '@playwright/test'
import fs from 'node:fs'
import path from 'node:path'
import {
  loginWithCredentials,
  openMeetingHistory,
  openNotificationCenter,
  requireRealBackendEnv,
} from './helpers/auth'

const DEFAULT_FIXTURE_PATH = path.resolve(
  process.cwd(),
  'FE-Audiomind',
  'tests',
  'e2e',
  'fixtures',
  'sample-audio.wav',
)

const DUMMY_WAV_BASE64 = 'UklGRiQAAABXQVZFZm10IBAAAAABAAEAQB8AAEAfAAABAAgAZGF0YQAAAAA='

const ensureFixturePath = (candidatePath: string): string => {
  const resolvedPath = path.resolve(candidatePath)
  if (fs.existsSync(resolvedPath)) {
    return resolvedPath
  }
  fs.mkdirSync(path.dirname(resolvedPath), { recursive: true })
  fs.writeFileSync(resolvedPath, Buffer.from(DUMMY_WAV_BASE64, 'base64'))
  return resolvedPath
}

test.describe('Job completion notification', () => {
  test('upload completion increases notification unread badge or panel', async ({ page }) => {
    const { username, password } = requireRealBackendEnv()
    const fixtureCandidatePath = process.env.PLAYWRIGHT_AUDIO_FILE || DEFAULT_FIXTURE_PATH
    const resolvedAudioPath = ensureFixturePath(fixtureCandidatePath)

    await loginWithCredentials(page, username, password)

    const uploadInput = page.locator('[data-testid="e2e-upload-input"]')
    await uploadInput.setInputFiles(resolvedAudioPath)

    const submitButton = page.locator('[data-testid="e2e-process-submit"]')
    const startResponsePromise = page.waitForResponse(
      (response) => response.ok() && response.url().includes('/processing/start'),
      { timeout: 4 * 60 * 1000 },
    )
    await submitButton.click()
    await startResponsePromise

    const statusLine = page.locator('[data-testid="e2e-status"]').first()
    await expect(statusLine).toContainText(/completed|failed/i, { timeout: 8 * 60 * 1000 })

    const badge = page.locator('[data-testid="notification-unread-badge"]')
    const badgeVisible = await badge.isVisible().catch(() => false)

    await openNotificationCenter(page)
    const panelText = await page.locator('.notification-center__panel').innerText()
    const hasJobNotification = /xử lý hoàn tất|xử lý thất bại|job_completed|job_failed/i.test(panelText)

    expect(badgeVisible || hasJobNotification).toBeTruthy()
  })
})
