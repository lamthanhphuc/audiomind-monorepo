import { createRoot } from 'react-dom/client'
import { act } from 'react-dom/test-utils'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { ErrorDisplay } from './ErrorDisplay'

describe('ErrorDisplay', () => {
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

  it('renders traceId when showTraceId is enabled', () => {
    act(() => {
      root.render(
        <ErrorDisplay
          message="Khong the tai du lieu"
          traceId="trace-abc-123"
          errorCode="INTERNAL_ERROR"
          showTraceId
        />,
      )
    })

    const traceNode = container.querySelector('[data-testid="error-trace-id"]')
    expect(traceNode).not.toBeNull()
    expect(container.textContent).toContain('trace-abc-123')
    expect(container.textContent).toContain('INTERNAL_ERROR')
  })

  it('renders CTA button for catalog error codes', () => {
    act(() => {
      root.render(
        <ErrorDisplay
          message="File vượt quá dung lượng cho phép (tối đa 100MB)."
          ctaId="reduce_file_size"
          ctaLabel="Giảm dung lượng file"
          errorCode="UPLOAD_TOO_LARGE"
          showCta
        />,
      )
    })

    const cta = container.querySelector('[data-testid="error-cta"]')
    expect(cta).not.toBeNull()
    expect(cta?.getAttribute('data-cta-id')).toBe('reduce_file_size')
    expect(container.textContent).toContain('Giảm dung lượng file')
  })

  it('hides traceId when showTraceId is disabled', () => {
    act(() => {
      root.render(
        <ErrorDisplay
          message="Loi mang"
          traceId="trace-hidden"
          showTraceId={false}
        />,
      )
    })

    expect(container.querySelector('[data-testid="error-trace-id"]')).toBeNull()
    expect(container.textContent).not.toContain('trace-hidden')
  })
})
