import { PUBLIC_LEGAL_PATHS } from '../../utils/publicRoutes'

type PublicSiteFooterProps = {
  className?: string
}

export default function PublicSiteFooter({ className }: PublicSiteFooterProps) {
  const rootClass = ['public-site-footer', className].filter(Boolean).join(' ')

  return (
    <footer className={rootClass} data-testid="public-site-footer">
      <nav className="public-site-footer__nav" aria-label="Liên kết pháp lý">
        <a
          className="public-site-footer__link"
          href={PUBLIC_LEGAL_PATHS.privacy}
          data-testid="public-footer-privacy"
        >
          Chính sách quyền riêng tư
        </a>
        <span className="public-site-footer__sep" aria-hidden="true">
          ·
        </span>
        <a
          className="public-site-footer__link"
          href={PUBLIC_LEGAL_PATHS.terms}
          data-testid="public-footer-terms"
        >
          Điều khoản dịch vụ
        </a>
      </nav>
      <p className="public-site-footer__copy">© 2026 AudioMind</p>
    </footer>
  )
}
