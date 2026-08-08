import { useEffect, useState } from 'react'
import { ExternalLink, Play, Sparkles } from 'lucide-react'
import {
  getAdvertisements,
  shouldRequestAdvertisements,
  type AdvertisementItem,
} from '../../services/advertisements'

type SponsoredAdPanelProps = {
  plan?: string
  placement?: string
  onNavigateBilling?: () => void
}

const normalizePlacement = (value?: string | null): string => String(value || 'DASHBOARD').trim().toUpperCase() || 'DASHBOARD'

const youtubeEmbedUrl = (url?: string | null): string | null => {
  const raw = String(url || '').trim()
  if (!raw) return null
  try {
    const parsed = new URL(raw)
    const host = parsed.hostname.replace(/^www\./, '').toLowerCase()
    const origin = typeof window === 'undefined' ? '' : window.location.origin
    const suffix = origin ? `?origin=${encodeURIComponent(origin)}&rel=0` : '?rel=0'
    if (host === 'youtu.be') {
      const id = parsed.pathname.split('/').filter(Boolean)[0]
      return id ? `https://www.youtube.com/embed/${encodeURIComponent(id)}${suffix}` : null
    }
    if (host === 'youtube.com' || host === 'm.youtube.com') {
      const id = parsed.searchParams.get('v') || parsed.pathname.split('/').filter(Boolean).pop()
      return id ? `https://www.youtube.com/embed/${encodeURIComponent(id)}${suffix}` : null
    }
  } catch {
    return null
  }
  return null
}

const isImageUrl = (url?: string | null): boolean => /\.(png|jpe?g|webp|gif|avif)(\?.*)?$/i.test(String(url || '').trim())

export function SponsoredAdPanel({ plan, placement = 'DASHBOARD', onNavigateBilling }: SponsoredAdPanelProps) {
  const [ad, setAd] = useState<AdvertisementItem | null>(null)
  const normalizedPlacement = normalizePlacement(placement)

  useEffect(() => {
    let active = true
    if (!shouldRequestAdvertisements(plan)) {
      setAd(null)
      return undefined
    }
    void getAdvertisements()
      .then((response) => {
        if (!active) return
        const matchingAd = response.items.find((item) => normalizePlacement(item.placement) === normalizedPlacement)
        setAd(response.advertisementEnabled ? matchingAd ?? null : null)
      })
      .catch(() => {
        if (active) setAd(null)
      })
    return () => {
      active = false
    }
  }, [normalizedPlacement, plan])

  if (!ad) return null
  const mediaUrl = ad.mediaUrl || ad.thumbnailUrl || null
  const embedUrl = youtubeEmbedUrl(ad.mediaUrl)
  const isVideo = String(ad.type || '').toUpperCase() === 'VIDEO'
  const ctaUrl = ad.targetUrl || null
  const handleCta = () => {
    if (ctaUrl) {
      window.open(ctaUrl, '_blank', 'noopener,noreferrer')
      return
    }
    onNavigateBilling?.()
  }

  return (
    <aside className="sponsored-ad-panel" data-placement={normalizedPlacement} data-testid="sponsored-ad-panel" aria-label={ad.label}>
      <div className="sponsored-ad-panel__label">
        <Sparkles size={14} aria-hidden /> {ad.label}
      </div>
      {embedUrl ? (
        <iframe
          className="sponsored-ad-panel__media sponsored-ad-panel__media--video"
          src={embedUrl}
          title={ad.title}
          loading="lazy"
          referrerPolicy="strict-origin-when-cross-origin"
          allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share"
          allowFullScreen
        />
      ) : mediaUrl && (isVideo || !isImageUrl(mediaUrl)) ? (
        <video className="sponsored-ad-panel__media" src={mediaUrl} poster={ad.thumbnailUrl || undefined} controls preload="metadata" />
      ) : mediaUrl ? (
        <img className="sponsored-ad-panel__media" src={mediaUrl} alt="" loading="lazy" />
      ) : null}
      <strong>{ad.title}</strong>
      <p>{ad.body}</p>
      <button type="button" className="btn btn--secondary btn--block" onClick={handleCta}>
        {ctaUrl ? <ExternalLink size={14} aria-hidden /> : <Play size={14} aria-hidden />}
        {ad.ctaLabel}
      </button>
    </aside>
  )
}
