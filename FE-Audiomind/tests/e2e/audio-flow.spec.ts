import { expect, test } from '@playwright/test'
import path from 'node:path'

test.describe('Audio processing flow', () => {
  test('upload -> processing -> summary -> result display', async ({ page }, testInfo) => {
    const useRealBackend = process.env.PLAYWRIGHT_REAL_BACKEND === '1'
    if (!useRealBackend) {
      throw new Error('PLAYWRIGHT_REAL_BACKEND=1 is required. Mock mode is disabled by policy.')
    }
    const audioPath =
      process.env.PLAYWRIGHT_AUDIO_FILE ||
      path.resolve(process.cwd(), 'FE-Audiomind', 'tests', 'e2e', 'fixtures', 'sample-audio.mp3')

    const resolvedAudioPath = path.resolve(audioPath)
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

      const uploadInput = page.locator('input[type="file"]')
      const uploadCount = await uploadInput.count()
      if (uploadCount === 0) {
        throw new Error(
          'Upload control not found. Current UI may still be vertical-slice mode in App.tsx and does not render upload components.'
        )
      }

      log(`Set audio file: ${resolvedAudioPath}`)
      await uploadInput.first().setInputFiles(resolvedAudioPath)

      const submitButton = page
        .getByRole('button', { name: /Phan tich file|Phân tích file|Process|Upload/i })
        .first()

      await expect(submitButton).toBeVisible()
      log('Trigger processing')
      await submitButton.click()

      log('Wait for backend processing response')
      await page.waitForResponse(
        (response) => {
          const url = response.url()
          return (
            response.ok() &&
            url.includes('/api/process')
          )
        },
        { timeout: 4 * 60 * 1000 }
      )

      const statusLine = page.locator('p:has-text("Status:")').first()
      await expect(statusLine).toContainText(/completed|failed/i, {
        timeout: 8 * 60 * 1000,
      })

      const statusText = (await statusLine.innerText()).toLowerCase()
      log(`Final status line: ${statusText}`)
      if (statusText.includes('failed')) {
        const errorMessage = (
          await page.locator('p[style*="crimson"], p:has-text("failed")').first().innerText()
        ).trim()
        throw new Error(`Processing finished with FAILED status: ${errorMessage}`)
      }

      const transcriptLine = page.locator('p:has-text("Transcript:")').first()
      const summaryLine = page.locator('p:has-text("Summary:")').first()

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
