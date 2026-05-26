import { createRoot } from 'react-dom/client'
import { act } from 'react-dom/test-utils'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import App from './App'
import * as api from '../services/api'

describe('Upload language selector (integration)', () => {
  let container: HTMLDivElement
  let root: ReturnType<typeof createRoot>

  beforeEach(() => {
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
    // mark as authenticated
    localStorage.setItem('audiomind.access_token', 'dummy-token')
  })

  afterEach(() => {
    act(() => {
      root.unmount()
    })
    container.remove()
    vi.restoreAllMocks()
    localStorage.clear()
  })

  it('shows upload language selector, logs selection and includes language on upload', async () => {
    const uploadSpy = vi.spyOn(api, 'uploadToMeetingApi').mockResolvedValue({ id: 42, audioPath: '/tmp', title: 'f' })
    vi.spyOn(api, 'startProcessingByPath').mockResolvedValue({} as any)
    vi.spyOn(api, 'getProcessingStatus').mockResolvedValue({ meeting_id: 42, status: 'COMPLETED', error: null, updated_at: '' } as any)
    vi.spyOn(api, 'getTranscript').mockResolvedValue({ meeting_id: 42, transcripts: [] } as any)
    vi.spyOn(api, 'getAnalysis').mockResolvedValue({ summary: '' } as any)

    const infoSpy = vi.spyOn(console, 'info').mockImplementation(() => {})

    await act(async () => {
      root.render(<App />)
    })

    const select = container.querySelector('[data-testid="e2e-upload-language-select"]') as HTMLSelectElement
    expect(select).not.toBeNull()
    expect(select.value).toBe('vi')

    // change selection to English
    await act(async () => {
      select.value = 'en'
      select.dispatchEvent(new Event('change', { bubbles: true }))
    })

    expect(infoSpy).toHaveBeenCalled()
    const selectionCalls = infoSpy.mock.calls.flat()
    const foundSelection = selectionCalls.find((c) => typeof c === 'string' && c.includes('FE_UPLOAD_LANGUAGE_SELECTED'))
    expect(foundSelection).toBeDefined()
    expect(String(foundSelection)).toContain('language=en')

    // attach a file
    const fileInput = container.querySelector('[data-testid="e2e-upload-input"]') as HTMLInputElement
    const testFile = new File(['abc'], 'test.wav', { type: 'audio/wav' })
    await act(async () => {
      // simulate file selection
      Object.defineProperty(fileInput, 'files', { value: [testFile], writable: false })
      fileInput.dispatchEvent(new Event('change', { bubbles: true }))
    })

    const submit = container.querySelector('[data-testid="e2e-process-submit"]') as HTMLButtonElement
    expect(submit).not.toBeNull()

    await act(async () => {
      submit.click()
      // allow attached async work to complete
      await Promise.resolve()
    })

    // upload called with language arg
    expect(uploadSpy).toHaveBeenCalled()
    const args = uploadSpy.mock.calls[0]
    expect(args[2]).toBe('en')

    const postCalls = infoSpy.mock.calls.flat()
    const foundUploadLog = postCalls.find((c) => typeof c === 'string' && c.includes('UPLOAD_REQUEST_SEND'))
    expect(foundUploadLog).toBeDefined()
    expect(String(foundUploadLog)).toContain('language=en')
  })
})
