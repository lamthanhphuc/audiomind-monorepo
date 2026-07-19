// @vitest-environment jsdom
import { createRoot } from 'react-dom/client'
import { act } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import FeatureIntegrations from './FeatureIntegrations'
import * as googleIntegration from '../../services/googleIntegration'

vi.mock('../../services/googleIntegration', async () => {
  const actual = await vi.importActual<typeof googleIntegration>('../../services/googleIntegration')
  return {
    ...actual,
    getGoogleStatus: vi.fn(),
  }
})

vi.mock('./ZoomIntegrationPanel', () => ({
  default: () => <div data-testid="mock-zoom-panel">Zoom</div>,
}))

vi.mock('./TeamsIntegrationPanel', () => ({
  default: () => <div data-testid="mock-teams-panel">Teams</div>,
}))

describe('FeatureIntegrations', () => {
  let container: HTMLDivElement
  let root: ReturnType<typeof createRoot>

  beforeEach(() => {
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
    vi.mocked(googleIntegration.getGoogleStatus).mockResolvedValue({
      linked: true,
      googleEmail: 'user@example.com',
      grantedScopes: [googleIntegration.GOOGLE_CALENDAR_EVENTS_SCOPE],
      missingScopes: [],
    })
  })

  afterEach(() => {
    act(() => {
      root.unmount()
    })
    container.remove()
    vi.restoreAllMocks()
  })

  it('renders integrations shell with Google, Zoom and Teams sections', async () => {
    await act(async () => {
      root.render(
        <FeatureIntegrations
          meetings={[]}
          uploadLanguage="vi"
        />,
      )
    })
    await act(async () => {
      await Promise.resolve()
    })

    expect(container.querySelector('[data-testid="feature-integrations"]')).toBeTruthy()
    expect(container.textContent).toContain('user@example.com')
    expect(container.querySelector('[data-testid="integrations-zoom-section"]')).toBeTruthy()
    expect(container.querySelector('[data-testid="integrations-teams-section"]')).toBeTruthy()
    expect(container.querySelector('[data-testid="mock-zoom-panel"]')).toBeTruthy()
    expect(container.querySelector('[data-testid="mock-teams-panel"]')).toBeTruthy()
    expect(container.textContent).not.toContain('import cloud recording hoặc chọn file export thủ công')
  })
})

