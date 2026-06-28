import { useEffect, useState } from 'react'

import { getLexicon, getTranscriptQualityPolicy, type DomainLexicon } from '../services/configService'
import type { HighlightTermInput } from '../utils/highlightTerms'

const mapLexiconToHighlightTerms = (lexicon: DomainLexicon): HighlightTermInput[] => {
  const terms: HighlightTermInput[] = []
  for (const entry of lexicon.terms) {
    const canonical = String(entry.term ?? '').trim()
    if (!canonical) continue
    const aliases = Object.entries(lexicon.normalizationMap)
      .filter(([, normalized]) => normalized === canonical)
      .map(([alias]) => alias)
    terms.push({ canonical, aliases })
  }
  return terms
}

export const useDomainLexiconTerms = (domainMode?: string | null, enabled = true): HighlightTermInput[] => {
  const [terms, setTerms] = useState<HighlightTermInput[]>([])

  useEffect(() => {
    if (!enabled) {
      setTerms([])
      return
    }

    let active = true
    void (async () => {
      try {
        const policy = await getTranscriptQualityPolicy()
        const supportedPacks = policy.lexicon?.supportedDomainPacks ?? []
        const requestedDomain = String(domainMode ?? policy.lexicon?.defaultDomainPack ?? 'general').trim().toLowerCase() || 'general'
        const domain = supportedPacks.length > 0 && !supportedPacks.includes(requestedDomain)
          ? (supportedPacks.includes('general') ? 'general' : requestedDomain)
          : requestedDomain
        const lexicon = await getLexicon(domain)
        if (active) {
          setTerms(mapLexiconToHighlightTerms(lexicon))
        }
      } catch {
        if (active) setTerms([])
      }
    })()

    return () => {
      active = false
    }
  }, [domainMode, enabled])

  return terms
}
