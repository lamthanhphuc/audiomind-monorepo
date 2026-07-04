import type { AiAnalysis } from '../types'
import { normalizeAnalysisResponse } from '../types'

export type TopicGraphNode = {
  id: string
  label: string
  weight: number
}

export type TopicGraphEdge = {
  id: string
  source: string
  target: string
  weight: number
}

export const buildTopicGraph = (analysis: AiAnalysis | null): {
  nodes: TopicGraphNode[]
  edges: TopicGraphEdge[]
} => {
  const normalized = normalizeAnalysisResponse(analysis)
  const terms = [
    ...normalized.keywords.map((term) => term.trim()).filter(Boolean),
    ...normalized.technicalTerms.map((term) => term.term.trim()).filter(Boolean),
  ]
  const uniqueTerms = Array.from(new Set(terms.map((term) => term.toLowerCase()))).slice(0, 12)
  const nodes = uniqueTerms.map((term, index) => ({
    id: `topic-${index}`,
    label: terms.find((candidate) => candidate.toLowerCase() === term) ?? term,
    weight: 1,
  }))

  const coOccurrence = new Map<string, number>()
  const sections = [
    normalized.summary ?? '',
    ...normalized.painPoints.map((item) => `${item.title} ${item.evidence ?? ''}`),
    ...normalized.actionItems,
  ]
  const haystack = sections.join(' ').toLowerCase()

  for (let left = 0; left < nodes.length; left += 1) {
    for (let right = left + 1; right < nodes.length; right += 1) {
      const leftTerm = nodes[left].label.toLowerCase()
      const rightTerm = nodes[right].label.toLowerCase()
      if (haystack.includes(leftTerm) && haystack.includes(rightTerm)) {
        const key = `${nodes[left].id}:${nodes[right].id}`
        coOccurrence.set(key, (coOccurrence.get(key) ?? 0) + 1)
      }
    }
  }

  const edges = Array.from(coOccurrence.entries()).map(([key, weight]) => {
    const [source, target] = key.split(':')
    return { id: key, source, target, weight }
  })

  return { nodes, edges }
}
