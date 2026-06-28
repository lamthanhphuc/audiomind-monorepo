import { expect, type Page } from '@playwright/test'

export function requireRealBackendEnv(): { username: string; password: string } {
  if (process.env.PLAYWRIGHT_REAL_BACKEND !== '1') {
    throw new Error('PLAYWRIGHT_REAL_BACKEND=1 is required. Mock mode is disabled by policy.')
  }
  const username = process.env.E2E_USERNAME
  const password = process.env.E2E_PASSWORD
  if (!username || !password) {
    throw new Error('ENVIRONMENT_BLOCKED: E2E_USERNAME and E2E_PASSWORD are required.')
  }
  return { username, password }
}

export async function gotoInviteRegister(page: Page, meetingId: number): Promise<void> {
  await page.goto(`/register?openMeeting=${meetingId}`, { waitUntil: 'domcontentloaded' })
}

export async function loginWithCredentials(page: Page, username: string, password: string): Promise<void> {
  await page.goto('/', { waitUntil: 'domcontentloaded' })
  await page.locator('[data-testid="e2e-login-username"]').fill(username)
  await page.locator('[data-testid="e2e-login-password"]').fill(password)
  await page.locator('[data-testid="e2e-login-submit"]').click()
  await expect(page.locator('[data-testid="e2e-upload-input"]')).toBeVisible({ timeout: 30_000 })
}

export async function openMeetingHistory(page: Page): Promise<void> {
  await page.locator('[data-testid="dashboard-nav-history"]').click()
  await expect(page.locator('[data-testid="meeting-list"]')).toBeVisible({ timeout: 30_000 })
}

export async function openNotificationCenter(page: Page): Promise<void> {
  await page.locator('[data-testid="notification-center-trigger"]').click()
  await expect(page.locator('.notification-center__panel')).toBeVisible()
}
