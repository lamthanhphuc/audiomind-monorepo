import { createRoot } from 'react-dom/client'
import { act } from 'react-dom/test-utils'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import PublicLegalPage from './PublicLegalPage'
import PublicSiteFooter from './PublicSiteFooter'

describe('public legal pages', () => {
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

  it('renders privacy policy with required sections and footer links', () => {
    act(() => {
      root.render(<PublicLegalPage kind="privacy" />)
    })

    expect(container.querySelector('[data-testid="public-legal-privacy"]')).toBeTruthy()
    expect(container.textContent).toContain('Chính sách quyền riêng tư')
    expect(container.textContent).toContain('AudioMind là gì và thông tin liên hệ')
    expect(container.textContent).toContain('Không bán dữ liệu Google')
    expect(container.textContent).toContain('openid')
    expect(container.textContent).toContain('email')
    expect(container.textContent).toContain('profile')
    expect(container.textContent).toContain('https://www.googleapis.com/auth/calendar.events')
    expect(container.textContent).toContain('https://www.googleapis.com/auth/gmail.send')
    expect(container.textContent).toContain('đánh dấu grant là đã thu hồi')
    expect(container.textContent).toContain('support@audiomind.pro.vn')
    expect(container.textContent).not.toMatch(/Google Drive|drive\.google/i)

    const privacyLink = container.querySelector('[data-testid="public-footer-privacy"]') as HTMLAnchorElement
    const termsLink = container.querySelector('[data-testid="public-footer-terms"]') as HTMLAnchorElement
    expect(privacyLink?.getAttribute('href')).toBe('/privacy')
    expect(termsLink?.getAttribute('href')).toBe('/terms')
    expect(privacyLink?.textContent).toContain('Chính sách quyền riêng tư')
    expect(termsLink?.textContent).toContain('Điều khoản dịch vụ')
    expect(container.textContent).toContain('\u00a9 2026 AudioMind')
  })

  it('renders terms of service page', () => {
    act(() => {
      root.render(<PublicLegalPage kind="terms" />)
    })

    expect(container.querySelector('[data-testid="public-legal-terms"]')).toBeTruthy()
    expect(container.textContent).toContain('Điều khoản dịch vụ')
    expect(container.textContent).toContain('Chấp nhận điều khoản')
  })

  it('renders public footer links for guest homepage branding', () => {
    act(() => {
      root.render(<PublicSiteFooter />)
    })

    expect(container.querySelector('[data-testid="public-site-footer"]')).toBeTruthy()
    expect(container.querySelector('[data-testid="public-footer-privacy"]')?.textContent)
      .toContain('Chính sách quyền riêng tư')
    expect(container.querySelector('[data-testid="public-footer-terms"]')?.textContent)
      .toContain('Điều khoản dịch vụ')
    expect(container.textContent).toContain('\u00a9 2026 AudioMind')
  })
})
