/** Shared tokenizer for TF-IDF (Epic 3 §2.4) — FE port. */

export function normalizeToken(text: string): string {
  if (!text) return ''
  const lower = text.toLowerCase().replace(/\u0111/g, 'd').replace(/\u0110/g, 'D')
  const decomposed = lower.normalize('NFD')
  return decomposed.replace(/\p{M}+/gu, '').trim()
}

export function tokenizeForTfIdf(text: string): string[] {
  if (!text) return []
  const matches = text.match(/[\p{L}\p{N}_']+/gu) ?? []
  return matches
    .map((token) => normalizeToken(token))
    .filter((token) => token.length >= 1)
}
