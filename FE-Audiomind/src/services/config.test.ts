import { describe, expect, it } from 'vitest'

import { normalizeApiBaseUrl } from './config'

describe('config service env normalization', () => {
  it('maps __SAME_ORIGIN__ sentinel to empty base URL', () => {
    expect(normalizeApiBaseUrl('__SAME_ORIGIN__')).toBe('')
    expect(normalizeApiBaseUrl('  __SAME_ORIGIN__  ')).toBe('')
  })

  it('returns trimmed non-empty URLs unchanged', () => {
    expect(normalizeApiBaseUrl('https://api.example.com')).toBe('https://api.example.com')
    expect(normalizeApiBaseUrl('  http://localhost:8083  ')).toBe('http://localhost:8083')
  })

  it('returns undefined for empty or missing values', () => {
    expect(normalizeApiBaseUrl(undefined)).toBeUndefined()
    expect(normalizeApiBaseUrl('')).toBeUndefined()
    expect(normalizeApiBaseUrl('   ')).toBeUndefined()
  })
})
