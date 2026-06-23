import { describe, expect, it } from 'vitest'
import { normalizeToken, tokenizeForTfIdf } from './tokenizer'

describe('tokenizer', () => {
  it('normalizes Vietnamese diacritics', () => {
    expect(normalizeToken('Hợp')).toBe('hop')
    expect(normalizeToken('đồng')).toBe('dong')
  })

  it('tokenizes with word boundaries', () => {
    const tokens = tokenizeForTfIdf('Hợp đồng luật sư')
    expect(tokens).toContain('hop')
    expect(tokens).toContain('dong')
  })
})
