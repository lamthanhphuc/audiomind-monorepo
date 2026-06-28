import type { MindmapBranch } from './mindmapData'

export type MindmapLayoutNode = {
  id: string
  x: number
  y: number
  label: string
  kind: 'root' | 'hub' | 'leaf'
  tone?: string
  title?: string
  branchId?: string
}

export type MindmapLayoutEdge = {
  id: string
  from: string
  to: string
}

const LEVEL_ROOT = 0
const LEVEL_HUB = 280
const LEVEL_LEAF = 560
const HUB_GAP = 36
const LEAF_GAP = 72
const MIN_BRANCH_BLOCK = 56

const truncate = (value: string, max = 32): string => {
  const trimmed = value.trim()
  if (trimmed.length <= max) return trimmed
  return `${trimmed.slice(0, max - 1)}…`
}

export const buildMindmapLayout = (
  rootLabel: string,
  branches: MindmapBranch[],
  collapsedHubs: Record<string, boolean> = {},
): { nodes: MindmapLayoutNode[]; edges: MindmapLayoutEdge[] } => {
  const nodes: MindmapLayoutNode[] = [{
    id: 'root',
    x: LEVEL_ROOT,
    y: 0,
    label: truncate(rootLabel, 40),
    kind: 'root',
  }]
  const edges: MindmapLayoutEdge[] = []
  const activeBranches = branches.filter((branch) => branch.items.length > 0)

  const branchBlocks = activeBranches.map((branch) => {
    const hubId = `hub-${branch.id}`
    const collapsed = Boolean(collapsedHubs[hubId])
    const visibleLeaves = collapsed ? 0 : branch.items.length
    return Math.max(MIN_BRANCH_BLOCK, visibleLeaves * LEAF_GAP)
  })

  const totalHeight = branchBlocks.reduce((sum, block) => sum + block, 0)
    + Math.max(0, activeBranches.length - 1) * HUB_GAP

  let cursorY = -totalHeight / 2

  activeBranches.forEach((branch, branchIndex) => {
    const hubId = `hub-${branch.id}`
    const collapsed = Boolean(collapsedHubs[hubId])
    const blockHeight = branchBlocks[branchIndex] ?? MIN_BRANCH_BLOCK
    const hubY = cursorY + blockHeight / 2

    nodes.push({
      id: hubId,
      x: LEVEL_HUB,
      y: hubY,
      label: `${branch.label}${collapsed ? ' ▸' : ' ▾'}`,
      kind: 'hub',
      branchId: branch.id,
    })
    edges.push({ id: `e-root-${hubId}`, from: 'root', to: hubId })

    if (!collapsed) {
      const visibleLeaves = branch.items
      const leavesHeight = Math.max(MIN_BRANCH_BLOCK, visibleLeaves.length * LEAF_GAP)
      const leafStartY = hubY - leavesHeight / 2 + LEAF_GAP / 2

      visibleLeaves.forEach((leaf, leafIndex) => {
        const leafId = `leaf-${branch.id}-${leaf.id}`
        nodes.push({
          id: leafId,
          x: LEVEL_LEAF,
          y: leafStartY + leafIndex * LEAF_GAP,
          label: truncate(leaf.label),
          kind: 'leaf',
          tone: leaf.tone,
          title: leaf.title,
          branchId: branch.id,
        })
        edges.push({ id: `e-${hubId}-${leafId}`, from: hubId, to: leafId })
      })
    }

    cursorY += blockHeight + HUB_GAP
  })

  return { nodes, edges }
}

export type MindmapLayoutBounds = {
  minX: number
  minY: number
  width: number
  height: number
}

export const getMindmapLayoutBounds = (
  nodes: MindmapLayoutNode[],
  padding = 48,
): MindmapLayoutBounds => {
  if (nodes.length === 0) {
    return { minX: 0, minY: 0, width: 920, height: 520 }
  }

  const xs = nodes.map((node) => node.x)
  const ys = nodes.map((node) => node.y)
  const minX = Math.min(...xs) - padding
  const maxX = Math.max(...xs) + padding
  const minY = Math.min(...ys) - padding
  const maxY = Math.max(...ys) + padding

  return {
    minX,
    minY,
    width: Math.max(320, maxX - minX),
    height: Math.max(280, maxY - minY),
  }
}
