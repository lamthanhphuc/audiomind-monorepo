import { expect, test } from '@playwright/test'
import { gotoInviteRegister, loginWithCredentials, openMeetingHistory, requireRealBackendEnv } from './helpers/auth'

/**
 * Env for invite deep-link E2E (credential flow):
 * - PLAYWRIGHT_REAL_BACKEND=1
 * - E2E_INVITE_MEETING_ID
 * - E2E_INVITEE_EMAIL or E2E_USERNAME_2 + E2E_INVITEE_PASSWORD or E2E_PASSWORD_2
 */

test.describe('Meeting share invite', () => {
  test('invite banner on register deep link', async ({ page }) => {
    await gotoInviteRegister(page, 15)
    await expect(page.getByTestId('invite-meeting-banner')).toBeVisible()
    await expect(page.getByTestId('invite-meeting-banner')).toContainText(/đúng email/i)
  })

  test('invitee credential flow opens analysis from register deep link', async ({ page }) => {
    const meetingId = Number(process.env.E2E_INVITE_MEETING_ID)
    const inviteeUsername = process.env.E2E_USERNAME_2
    const inviteePassword = process.env.E2E_PASSWORD_2

    test.skip(
      process.env.PLAYWRIGHT_REAL_BACKEND !== '1'
        || !Number.isFinite(meetingId)
        || meetingId <= 0
        || !inviteeUsername
        || !inviteePassword,
      'Set PLAYWRIGHT_REAL_BACKEND=1, E2E_INVITE_MEETING_ID, E2E_USERNAME_2, E2E_PASSWORD_2',
    )

    await gotoInviteRegister(page, meetingId)
    await page.getByTestId('e2e-auth-switch-login').click()
    await page.getByTestId('e2e-login-username').fill(inviteeUsername!)
    await page.getByTestId('e2e-login-password').fill(inviteePassword!)
    await page.getByTestId('e2e-login-submit').click()

    await expect(page).toHaveURL(new RegExp(`/studio/analysis\\?meetingId=${meetingId}`), { timeout: 60_000 })
  })

  test('owner can open share panel and submit invite', async ({ page }) => {
    const { username, password } = requireRealBackendEnv()
    const inviteeEmail = process.env.E2E_INVITEE_EMAIL || process.env.E2E_USERNAME_2

    test.skip(!inviteeEmail, 'Set E2E_INVITEE_EMAIL or E2E_USERNAME_2 for share E2E')

    await loginWithCredentials(page, username, password)
    await openMeetingHistory(page)

    const firstMeeting = page.locator('[data-testid="meeting-list"] button').first()
    await expect(firstMeeting).toBeVisible({ timeout: 60_000 })
    await firstMeeting.click()

    await page.locator('[data-testid="meeting-share-link"]').click()
    await expect(page.locator('[data-testid="meeting-share-panel"]')).toBeVisible()

    const inviteResponsePromise = page.waitForResponse(
      (response) => response.url().includes('/shares') && response.request().method() === 'POST',
      { timeout: 60_000 },
    )

    await page.locator('[data-testid="meeting-share-email"]').fill(inviteeEmail!)
    await page.locator('[data-testid="meeting-share-invite"]').click()

    const inviteResponse = await inviteResponsePromise
    expect(inviteResponse.ok()).toBeTruthy()

    await expect(page.locator('[data-testid="meeting-share-notice"]')).toContainText(
      /đã mời|đã chia sẻ|thành công/i,
      { timeout: 30_000 },
    )
  })

  test('invitee sees shared badge on meeting history', async ({ page }) => {
    const inviteeUsername = process.env.E2E_USERNAME_2
    const inviteePassword = process.env.E2E_PASSWORD_2

    test.skip(!inviteeUsername || !inviteePassword, 'Set E2E_USERNAME_2 and E2E_PASSWORD_2 for invitee share badge E2E')

    await loginWithCredentials(page, inviteeUsername!, inviteePassword!)
    await openMeetingHistory(page)

    const sharedBadge = page.locator('[data-testid="meeting-shared-badge"]').first()
    await expect(sharedBadge).toBeVisible({ timeout: 60_000 })
    await expect(sharedBadge).toHaveText('Chia sẻ')
  })
})
