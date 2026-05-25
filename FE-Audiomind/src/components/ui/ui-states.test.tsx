import { createRoot } from 'react-dom/client'
import { act } from 'react-dom/test-utils'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { EmptyState } from './EmptyState'
import { ErrorState } from './ErrorState'
import { LoadingState } from './LoadingState'

describe('UI state components', () => {
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

  it('renders empty state', () => {
    act(() => {
      root.render(<EmptyState title="Trong" message="Khong co du lieu" />)
    })
    expect(container.querySelector('.ui-state--empty')).not.toBeNull()
    expect(container.textContent).toContain('Khong co du lieu')
  })

  it('renders loading state', () => {
    act(() => {
      root.render(<LoadingState message="Dang tai..." />)
    })
    expect(container.querySelector('.ui-state--loading')).not.toBeNull()
    expect(container.textContent).toContain('Dang tai...')
  })

  it('renders error state', () => {
    act(() => {
      root.render(<ErrorState message="Loi mang" />)
    })
    expect(container.querySelector('.ui-state--error')).not.toBeNull()
    expect(container.textContent).toContain('Loi mang')
  })
})
