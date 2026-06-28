export type OAuthNavigationResult = 'new_tab' | 'same_tab'

/**
 * Open a blank tab synchronously while the user gesture is still active.
 * Keep window.opener so the callback tab can focus this tab after OAuth.
 */
export const prepareOAuthTab = (): Window | null => {
  return window.open('about:blank', '_blank')
}

/** @deprecated Prefer prepareOAuthTab + completeOAuthNavigation for async OAuth flows. */
export const openOAuthInNewTab = (url: string): boolean => {
  const opened = window.open(url, '_blank')
  return opened != null
}

const navigatePreparedTab = (preparedTab: Window, url: string): boolean => {
  try {
    preparedTab.location.replace(url)
    return true
  } catch {
    try {
      preparedTab.location.href = url
      return true
    } catch {
      return false
    }
  }
}

export const completeOAuthNavigation = (
  preparedTab: Window | null,
  url: string,
): OAuthNavigationResult => {
  if (preparedTab && !preparedTab.closed) {
    if (navigatePreparedTab(preparedTab, url)) {
      return 'new_tab'
    }
    preparedTab.close()
  }
  window.location.assign(url)
  return 'same_tab'
}

export const closeOAuthTab = (preparedTab: Window | null): void => {
  preparedTab?.close()
}
