import { useCallback, useEffect, useState } from 'react'
import { appendOpenMeetingQuery } from '../utils/inviteAuth'
import { resolvePublicLegalKind, type PublicLegalKind } from '../utils/publicRoutes'

export type AuthRoute = 'login' | 'register'

const resolveAuthRouteFromLocation = (): AuthRoute => {
  if (typeof window !== 'undefined' && window.location.pathname === '/register') {
    return 'register'
  }
  return 'login'
}

const resolvePublicLegalKindFromLocation = (): PublicLegalKind | null => {
  if (typeof window === 'undefined') {
    return null
  }
  return resolvePublicLegalKind(window.location.pathname)
}

const resolveAuthPath = (route: AuthRoute): string => {
  return route === 'register' ? '/register' : '/'
}

export const useAuthRouting = () => {
  const [authRoute, setAuthRoute] = useState<AuthRoute>(resolveAuthRouteFromLocation)
  const [publicLegalKind, setPublicLegalKind] = useState<PublicLegalKind | null>(
    resolvePublicLegalKindFromLocation,
  )

  useEffect(() => {
    const syncAuthRoute = () => {
      setPublicLegalKind(resolvePublicLegalKindFromLocation())
      setAuthRoute(resolveAuthRouteFromLocation())
    }

    window.addEventListener('popstate', syncAuthRoute)
    syncAuthRoute()

    return () => {
      window.removeEventListener('popstate', syncAuthRoute)
    }
  }, [])

  const navigateAuthRoute = useCallback((route: AuthRoute, replace = false) => {
    const nextPath = appendOpenMeetingQuery(resolveAuthPath(route), window.location.search)
    if (typeof window !== 'undefined') {
      const historyMethod = replace ? 'replaceState' : 'pushState'
      window.history[historyMethod]({}, '', nextPath)
    }
    setAuthRoute(route)
  }, [])

  return {
    authRoute,
    publicLegalKind,
    navigateAuthRoute,
    setAuthRoute,
    setPublicLegalKind,
  }
}
