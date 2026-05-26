import React, { useMemo } from 'react'
import { DEFAULT_IT_TERMS } from '../../constants/itTerms'
import type { HighlightTermInput } from '../../utils/highlightTerms'
import { highlightTermsInText } from '../../utils/highlightTerms'

interface HighlightedTranscriptTextProps {
  text: string
  terms?: HighlightTermInput[]
  enabled?: boolean
  className?: string
}

const renderPlainText = (text: string, className?: string) => {
  if (!className) {
    return <>{text}</>
  }

  return <span className={className}>{text}</span>
}

export const HighlightedTranscriptText: React.FC<HighlightedTranscriptTextProps> = ({
  text,
  terms = DEFAULT_IT_TERMS,
  enabled = true,
  className,
}) => {
  const parts = useMemo(() => {
    if (!enabled) {
      return null
    }

    return highlightTermsInText(text, terms)
  }, [enabled, text, terms])

  if (!enabled || !parts || parts.length === 0 || (parts.length === 1 && parts[0].type === 'text')) {
    return renderPlainText(text, className)
  }

  const content = parts.map((part, index) => {
    if (part.type === 'text') {
      return <React.Fragment key={`t-${index}`}>{part.text}</React.Fragment>
    }

    return (
      <mark
        key={`h-${index}`}
        className="it-term-highlight"
        data-canonical={part.canonical}
      >
        {part.text}
      </mark>
    )
  })

  if (!className) {
    return <>{content}</>
  }

  return <span className={className}>{content}</span>
}
