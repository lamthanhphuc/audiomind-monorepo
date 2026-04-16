import { expect, test } from '@playwright/test'
import fs from 'node:fs'
import path from 'node:path'

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

test.describe('Audio processing flow', () => {
  test('upload -> processing -> summary -> result display', async ({ page }, testInfo) => {
    const useRealBackend = process.env.PLAYWRIGHT_REAL_BACKEND === '1'
    if (!useRealBackend) {
      throw new Error('PLAYWRIGHT_REAL_BACKEND=1 is required. Mock mode is disabled by policy.')
    }
    const e2eUsername = process.env.E2E_USERNAME
    const e2ePassword = process.env.E2E_PASSWORD
    if (!e2eUsername || !e2ePassword) {
      throw new Error('ENVIRONMENT_BLOCKED: E2E_USERNAME and E2E_PASSWORD are required for real-backend E2E execution.')
    }

    const fixtureCandidatePath = process.env.PLAYWRIGHT_AUDIO_FILE || DEFAULT_FIXTURE_PATH
    const resolvedAudioPath = ensureFixturePath(fixtureCandidatePath)
    const logs: string[] = []

    const log = (message: string) => {
      const line = `[${new Date().toISOString()}] ${message}`
      logs.push(line)
      console.log(line)
    }

    page.on('console', (msg) => {
      log(`BROWSER ${msg.type().toUpperCase()}: ${msg.text()}`)
    })

    try {
      log('Open web app')
      await page.goto('/', { waitUntil: 'domcontentloaded' })

      log('Login with E2E credentials')
      await page.locator('[data-testid="e2e-login-username"]').fill(e2eUsername)
      await page.locator('[data-testid="e2e-login-password"]').fill(e2ePassword)
      await page.locator('[data-testid="e2e-login-submit"]').click()

      const uploadInput = page.locator('[data-testid="e2e-upload-input"]')
      await expect(uploadInput).toBeVisible({ timeout: 30_000 })

      log(`Set audio file: ${resolvedAudioPath}`)
      await uploadInput.setInputFiles(resolvedAudioPath)

      const submitButton = page.locator('[data-testid="e2e-process-submit"]')

      await expect(submitButton).toBeVisible()
      log('Trigger processing')

      const uploadResponsePromise = page.waitForResponse(
        (response) => response.ok() && response.url().includes('/processing/upload'),
        { timeout: 2 * 60 * 1000 }
      )

      const startResponsePromise = page.waitForResponse(
        (response) => response.ok() && response.url().includes('/processing/start'),
        { timeout: 4 * 60 * 1000 }
      )

      await submitButton.click()

      log('Wait for upload and processing start responses')
      await uploadResponsePromise
      await startResponsePromise

      const statusLine = page.locator('[data-testid="e2e-status"]').first()
      await expect(statusLine).toContainText(/completed|failed/i, {
        timeout: 8 * 60 * 1000,
      })

      const statusText = (await statusLine.innerText()).toLowerCase()
      log(`Final status line: ${statusText}`)
      if (statusText.includes('failed')) {
        const errorMessage = (
          await page.locator('p[style*="crimson"]').first().innerText()
        ).trim()
        throw new Error(`Processing finished with FAILED status: ${errorMessage}`)
      }

      const transcriptLine = page.locator('[data-testid="e2e-transcript"]').first()
      const summaryLine = page.locator('[data-testid="e2e-summary"]').first()

      await expect(transcriptLine).toBeVisible({ timeout: 120_000 })
      await expect(summaryLine).toBeVisible({ timeout: 120_000 })

      const transcriptText = (await transcriptLine.innerText()).replace(/^\s*Transcript:\s*/i, '').trim()
      const summaryText = (await summaryLine.innerText()).replace(/^\s*Summary:\s*/i, '').trim()

      log(`Transcript preview: ${transcriptText.slice(0, 120)}`)
      log(`Summary preview: ${summaryText.slice(0, 120)}`)

      expect(transcriptText.length, 'Transcript is empty').toBeGreaterThan(0)
      expect(summaryText.length, 'Summary is empty').toBeGreaterThan(0)

      log('Assertions passed: transcript and summary are rendered')
    } catch (error) {
      const failureMessage = error instanceof Error ? error.stack || error.message : String(error)
      log(`TEST FAILED: ${failureMessage}`)

      await testInfo.attach('failure-log', {
        body: logs.join('\n'),
        contentType: 'text/plain',
      })

      throw error
    }
  })
})
