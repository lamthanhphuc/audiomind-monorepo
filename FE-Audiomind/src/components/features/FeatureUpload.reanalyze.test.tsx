import { createRoot } from 'react-dom/client'
import { act } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import FeatureUpload from './FeatureUpload'

vi.mock('../../hooks/useUpload', () => ({
  useUpload: () => ({
    supportedFormatsLabel: 'wav, mp3',
    config: { allowedExtensions: ['.wav', '.mp3'] },
  }),
}))

vi.mock('../onboarding/OnboardingTour', () => ({
  default: () => null,
}))

vi.mock('../subjects/SubjectPicker', () => ({
  default: () => null,
}))

describe('FeatureUpload reanalyze CTA', () => {
  let container: HTMLDivElement
  let root: ReturnType<typeof createRoot>

  beforeEach(() => {
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
  })

  afterEach(() => {
    act(() => {
      root.unmount()
    })
    container.remove()
  })

  it('shows Phân tích lại when upload failed with a meeting id', async () => {
    const onReanalyze = vi.fn()
    await act(async () => {
      root.render(
        <FeatureUpload
          uploadLanguage="vi"
          onUploadLanguageChange={() => undefined}
          domainMode="it"
          onDomainModeChange={() => undefined}
          status="failed"
          errorMessage="BATCH_PIPELINE_FAILED stage=analysis"
          errorCode="BATCH_PIPELINE_FAILED"
          lastMeetingId={42}
          onReanalyze={onReanalyze}
          onUpload={async () => undefined}
        />,
      )
    })

    const button = container.querySelector('[data-testid="upload-reanalyze-button"]') as HTMLButtonElement | null
    expect(button).toBeTruthy()
    expect(button?.textContent).toContain('Phân tích lại')

    await act(async () => {
      button?.click()
    })
    expect(onReanalyze).toHaveBeenCalledTimes(1)
  })

  it('hides Phân tích lại when no meeting id is available', async () => {
    await act(async () => {
      root.render(
        <FeatureUpload
          uploadLanguage="vi"
          onUploadLanguageChange={() => undefined}
          domainMode="it"
          onDomainModeChange={() => undefined}
          status="failed"
          errorMessage="Upload failed early"
          lastMeetingId={null}
          onReanalyze={vi.fn()}
          onUpload={async () => undefined}
        />,
      )
    })

    expect(container.querySelector('[data-testid="upload-reanalyze-button"]')).toBeNull()
  })
})
