import { describe, expect, it } from 'vitest'

import type { MindmapBranch } from './mindmapData'
import { buildMindmapLayout } from './mindmapLayout'

const sampleBranches: MindmapBranch[] = [
  {
    id: 'keywords',
    label: 'Từ khóa',
    items: [
      { id: 'kw-0', label: 'đăng ký nhóm', tone: 'accent' },
      { id: 'kw-1', label: 'chia bảng', tone: 'accent' },
    ],
  },
  {
    id: 'terms',
    label: 'Thuật ngữ',
    items: [{ id: 'term-0', label: 'Seminar', tone: 'muted' }],
  },
  {
    id: 'actions',
    label: 'Hành động',
    items: [{ id: 'action-0', label: 'check-in', tone: 'accent' }],
  },
]

describe('buildMindmapLayout', () => {
  it('creates a left-to-right tree with hub-relative leaves', () => {
    const { nodes, edges } = buildMindmapLayout('Cuộc họp demo', sampleBranches)

    const root = nodes.find((node) => node.id === 'root')
    const keywordHub = nodes.find((node) => node.id === 'hub-keywords')
    const keywordLeaf = nodes.find((node) => node.id === 'leaf-keywords-kw-0')
    const termLeaf = nodes.find((node) => node.id === 'leaf-terms-term-0')

    expect(root).toBeTruthy()
    expect(keywordHub).toBeTruthy()
    expect(keywordLeaf).toBeTruthy()
    expect(termLeaf).toBeTruthy()

    expect(keywordHub!.x).toBeGreaterThan(root!.x)
    expect(keywordLeaf!.x).toBeGreaterThan(keywordHub!.x)
    expect(termLeaf!.x).toBeGreaterThan(nodes.find((node) => node.id === 'hub-terms')!.x)

    expect(edges.some((edge) => edge.from === 'root' && edge.to === 'hub-keywords')).toBe(true)
    expect(edges.some((edge) => edge.from === 'hub-keywords' && edge.to === 'leaf-keywords-kw-0')).toBe(true)
    expect(edges.some((edge) => edge.from === 'hub-terms' && edge.to === 'leaf-terms-term-0')).toBe(true)
  })

  it('hides leaves when a hub is collapsed', () => {
    const collapsed = { 'hub-keywords': true }
    const { nodes, edges } = buildMindmapLayout('Cuộc họp demo', sampleBranches, collapsed)

    expect(nodes.some((node) => node.id.startsWith('leaf-keywords-'))).toBe(false)
    expect(edges.some((edge) => edge.to.startsWith('leaf-keywords-'))).toBe(false)
    expect(nodes.find((node) => node.id === 'hub-keywords')?.label).toContain('▸')
  })
})
