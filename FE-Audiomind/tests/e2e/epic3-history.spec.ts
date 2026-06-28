import { expect, test, type Page } from '@playwright/test'
import { loginWithCredentials, openMeetingHistory, requireRealBackendEnv } from './helpers/auth'

async function mockGoogleStatusLinked(page: Page): Promise<void> {
  await page.route('**/users/me/google/status', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        linked: true,
        googleEmail: 'e2e-linked@example.com',
        grantedScopes: ['https://www.googleapis.com/auth/calendar.events'],
        missingScopes: [],
      }),
    })
  })
}

async function mockMeetingTranscriptApis(page: Page): Promise<void> {
  await page.route('**/processing/*/transcript**', async (route) => {
    const url = route.request().url()
    if (url.includes('/transcript/search')) {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          query: 'api',
          matches: [
            {
              evidenceId: 'ev-1',
              rank: 1,
              speaker: 'Host',
              text: 'api gateway overview',
              startTime: 0,
              endTime: 1,
              contextBefore: [],
              contextAfter: [],
            },
          ],
        }),
      })
      return
    }

    if (route.request().method() === 'GET') {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          transcripts: [
            {
              segmentId: 'seg-1',
              speaker: 'Host',
              text: 'api gateway overview',
              startTime: 0,
              endTime: 1,
            },
          ],
        }),
      })
      return
    }

    await route.continue()
  })

  await page.route('**/processing/*/analysis/saved**', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        summary: 'Smoke meeting summary',
        status: 'COMPLETED',
      }),
    })
  })

  await page.route('**/processing/*/action-plan/export**', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/octet-stream',
      body: Buffer.from('mock-action-plan-export'),
    })
  })
}

test.describe('Google integration', () => {
  test('google settings scene loads linked status from API', async ({ page }) => {
    const { username, password } = requireRealBackendEnv()

    await mockGoogleStatusLinked(page)

    await loginWithCredentials(page, username, password)
    await page.locator('[data-testid="dashboard-nav-integrations"]').click()

    await expect(page.getByTestId('feature-integrations')).toBeVisible({ timeout: 30_000 })
    await expect(page.getByText('e2e-linked@example.com')).toBeVisible({ timeout: 30_000 })
  })

  test('google link success redirect shows integration notice', async ({ page }) => {
    const { username, password } = requireRealBackendEnv()

    await mockGoogleStatusLinked(page)

    await loginWithCredentials(page, username, password)
    await page.goto('/settings/integrations/google/success', { waitUntil: 'domcontentloaded' })

    await expect(page.getByText(/đã kết nối google/i)).toBeVisible({ timeout: 30_000 })
  })
})

test.describe('Epic3 meeting history', () => {
  test('search and action-plan export from meeting detail', async ({ page }) => {
    const { username, password } = requireRealBackendEnv()

    await mockMeetingTranscriptApis(page)

    await loginWithCredentials(page, username, password)
    await openMeetingHistory(page)

    const firstMeeting = page.locator('[data-testid="meeting-list"] button').first()
    await expect(firstMeeting).toBeVisible({ timeout: 120_000 })
    await firstMeeting.click()

    const searchInput = page.locator('[data-testid="transcript-evidence-search-input"]')
    await searchInput.scrollIntoViewIfNeeded()
    await expect(searchInput).toBeVisible({ timeout: 120_000 })

    const searchResponsePromise = page.waitForResponse(
      (response) => response.url().includes('/transcript/search') && response.request().method() === 'GET',
      { timeout: 60_000 },
    )

    await searchInput.fill('api')
    await page.locator('[data-testid="transcript-evidence-search-submit"]').click()

    const searchResponse = await searchResponsePromise
    expect(searchResponse.ok()).toBeTruthy()

    const exportButton = page.locator('[data-testid="meeting-export-action-plan"]')
    if (await exportButton.isVisible()) {
      const exportResponsePromise = page.waitForResponse(
        (response) => response.url().includes('/action-plan/export') && response.ok(),
        { timeout: 60_000 },
      )
      await exportButton.click()
      const exportResponse = await exportResponsePromise
      expect(exportResponse.ok()).toBeTruthy()
    }
  })
})
