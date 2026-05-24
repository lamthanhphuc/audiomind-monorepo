import { DEFAULT_IT_TERMS } from '../constants/itTerms'
import type { ITTermDefinition } from '../constants/itTerms'

export type HighlightTermInput = string | ITTermDefinition

export interface HighlightTextPart {
  type: 'text'
  text: string
}

export interface HighlightMatchPart {
  type: 'highlight'
  text: string
  canonical: string
}

export type HighlightPart = HighlightTextPart | HighlightMatchPart

interface MatchCandidate {
  start: number
  end: number
  canonical: string
}

interface TextRange {
  start: number
  end: number
}

interface TermVariant {
  canonical: string
  term: string
  caseSensitive: boolean
}

const WORD_CHAR_REGEX = /[\p{L}\p{N}_]/u
const URL_OR_EMAIL_REGEX = /(?:https?:\/\/[^\s]+|www\.[^\s]+|\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b)/giu

const escapeRegExp = (value: string): string => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

const isWordChar = (value: string): boolean => WORD_CHAR_REGEX.test(value)

const buildTermVariants = (terms: HighlightTermInput[]): TermVariant[] => {
  const variants: TermVariant[] = []
  const seen = new Set<string>()

  terms.forEach((entry) => {
    const termDefinition = typeof entry === 'string' ? { canonical: entry } : entry
    const canonical = termDefinition.canonical.trim()

    if (!canonical) {
      return
    }

    const allVariants = [canonical, ...(termDefinition.aliases ?? [])]
    allVariants.forEach((rawVariant) => {
      const variant = rawVariant.trim()
      if (!variant) {
        return
      }

      const caseSensitive = Boolean(termDefinition.caseSensitive)
      const dedupeKey = `${canonical.toLocaleLowerCase()}::${variant.toLocaleLowerCase()}::${caseSensitive ? 'sensitive' : 'insensitive'}`
      if (seen.has(dedupeKey)) {
        return
      }

      seen.add(dedupeKey)
      variants.push({ canonical, term: variant, caseSensitive })
    })
  })

  return variants.sort((left, right) => right.term.length - left.term.length)
}

const collectProtectedRanges = (text: string): TextRange[] => {
  const ranges: TextRange[] = []
  const matcher = new RegExp(URL_OR_EMAIL_REGEX)
  let current = matcher.exec(text)

  while (current) {
    ranges.push({
      start: current.index,
      end: current.index + current[0].length,
    })
    current = matcher.exec(text)
  }

  return ranges
}

const overlapsProtectedRange = (start: number, end: number, ranges: TextRange[]): boolean => {
  return ranges.some((range) => start < range.end && end > range.start)
}

const passesWordBoundaryCheck = (text: string, term: string, start: number, end: number): boolean => {
  const startsWithWordChar = isWordChar(term.charAt(0))
  const endsWithWordChar = isWordChar(term.charAt(term.length - 1))
  const previousChar = start > 0 ? text.charAt(start - 1) : ''
  const nextChar = end < text.length ? text.charAt(end) : ''

  if (startsWithWordChar && previousChar && isWordChar(previousChar)) {
    return false
  }

  if (endsWithWordChar && nextChar && isWordChar(nextChar)) {
    return false
  }

  return true
}

const collectCandidates = (text: string, variants: TermVariant[]): MatchCandidate[] => {
  const protectedRanges = collectProtectedRanges(text)
  const candidates: MatchCandidate[] = []

  variants.forEach(({ canonical, term, caseSensitive }) => {
    const flags = caseSensitive ? 'gu' : 'giu'
    const regex = new RegExp(escapeRegExp(term), flags)
    let current = regex.exec(text)

    while (current) {
      const start = current.index
      const end = start + current[0].length

      if (
        !overlapsProtectedRange(start, end, protectedRanges)
        && passesWordBoundaryCheck(text, term, start, end)
      ) {
        candidates.push({ start, end, canonical })
      }

      current = regex.exec(text)
    }
  })

  return candidates
}

const pickNonOverlappingMatches = (candidates: MatchCandidate[]): MatchCandidate[] => {
  const ordered = [...candidates].sort((left, right) => {
    if (left.start !== right.start) {
      return left.start - right.start
    }

    const leftLength = left.end - left.start
    const rightLength = right.end - right.start
    if (leftLength !== rightLength) {
      return rightLength - leftLength
    }

    return left.canonical.localeCompare(right.canonical)
  })

  const selected: MatchCandidate[] = []

  ordered.forEach((candidate) => {
    const latest = selected[selected.length - 1]
    if (!latest || candidate.start >= latest.end) {
      selected.push(candidate)
      return
    }

    const candidateLength = candidate.end - candidate.start
    const latestLength = latest.end - latest.start
    if (candidate.start === latest.start && candidateLength > latestLength) {
      selected[selected.length - 1] = candidate
    }
  })

  return selected
}

export const highlightTermsInText = (
  text: string,
  terms: HighlightTermInput[] = DEFAULT_IT_TERMS,
): HighlightPart[] => {
  if (typeof text !== 'string' || text.length === 0) {
    return [{ type: 'text', text: text ?? '' }]
  }

  const variants = buildTermVariants(terms)
  if (variants.length === 0) {
    return [{ type: 'text', text }]
  }

  const matches = pickNonOverlappingMatches(collectCandidates(text, variants))
  if (matches.length === 0) {
    return [{ type: 'text', text }]
  }

  const parts: HighlightPart[] = []
  let cursor = 0

  matches.forEach((match) => {
    if (match.start > cursor) {
      parts.push({
        type: 'text',
        text: text.slice(cursor, match.start),
      })
    }

    parts.push({
      type: 'highlight',
      text: text.slice(match.start, match.end),
      canonical: match.canonical,
    })

    cursor = match.end
  })

  if (cursor < text.length) {
    parts.push({
      type: 'text',
      text: text.slice(cursor),
    })
  }

  return parts
}
