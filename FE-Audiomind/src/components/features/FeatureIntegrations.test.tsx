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

  it('renders integrations shell with Google only', async () => {
    await act(async () => {
      root.render(
        <FeatureIntegrations
          meetings={[]}
        />,
      )
    })
    await act(async () => {
      await Promise.resolve()
    })

    expect(container.querySelector('[data-testid="feature-integrations"]')).toBeTruthy()
    expect(container.textContent).toContain('user@example.com')
    expect(container.querySelector('[data-testid="integrations-zoom-section"]')).toBeNull()
    expect(container.querySelector('[data-testid="integrations-teams-section"]')).toBeNull()
    expect(container.textContent).not.toContain('Zoom')
    expect(container.textContent).not.toContain('Teams')
    expect(container.textContent).not.toContain('import cloud recording hoặc chọn file export thủ công')
  })
})

