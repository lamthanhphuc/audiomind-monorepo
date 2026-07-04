import { normalizeAnalysisResponse, type AiAnalysis } from '../types'

export type MindmapLeaf = {
  id: string
  label: string
  tone?: 'default' | 'muted' | 'accent' | 'high' | 'medium' | 'low'
  title?: string
}

export type MindmapBranch = {
  id: string
  label: string
  items: MindmapLeaf[]
}

export const rootLabelFromAnalysis = (analysis: AiAnalysis | null, meetingTitle?: string): string => {
  const title = meetingTitle?.trim()
  if (title) return title.length > 42 ? `${title.slice(0, 42)}…` : title
  const summary = analysis?.summary?.trim()
  if (summary) return summary.length > 42 ? `${summary.slice(0, 42)}…` : summary
  return 'Cuộc họp'
}

const groupedPlanLeaves = (analysis: AiAnalysis | null): MindmapLeaf[] => {
  const grouped = analysis?.groupedActionPlan
  if (!grouped?.sections?.length) {
    return []
  }
  const leaves: MindmapLeaf[] = []
  grouped.sections.slice(0, 4).forEach((section, sectionIndex) => {
    section.items.slice(0, 2).forEach((item, itemIndex) => {
      leaves.push({
        id: `gap-${sectionIndex}-${itemIndex}`,
        label: item.title,
        title: section.title,
        tone: 'accent',
      })
    })
  })
  return leaves.slice(0, 6)
}

export const buildMindmapBranches = (analysis: AiAnalysis | null): MindmapBranch[] => {
  const normalized = normalizeAnalysisResponse(analysis)
  const groupedLeaves = groupedPlanLeaves(normalized)
  return [
    {
      id: 'keywords',
      label: 'Từ khóa',
      items: normalized.keywords.slice(0, 5).map((item, index) => ({
        id: `kw-${index}`,
        label: item,
        tone: 'accent' as const,
      })),
    },
    {
      id: 'terms',
      label: 'Thuật ngữ',
      items: normalized.technicalTerms.slice(0, 5).map((item, index) => ({
        id: `term-${index}`,
        label: item.term,
        title: item.meaning?.trim() || undefined,
        tone: 'muted' as const,
      })),
    },
    {
      id: 'pain',
      label: 'Vấn đề',
      items: normalized.painPoints.slice(0, 4).map((item, index) => ({
        id: `pain-${index}`,
        label: item.title,
        tone: (item.severity === 'high' ? 'high' : item.severity === 'medium' ? 'medium' : 'low') as MindmapLeaf['tone'],
      })),
    },
    {
      id: 'actions',
      label: 'Hành động',
      items: normalized.actionItems.slice(0, 4).map((item, index) => ({
        id: `action-${index}`,
        label: item,
        tone: 'accent' as const,
      })),
    },
    {
      id: 'grouped-plan',
      label: 'Grouped plan',
      items: groupedLeaves,
    },
  ]
}
