import { useCallback, useMemo } from 'react'
import {
  Background,
  Controls,
  MiniMap,
  ReactFlow,
  type Edge,
  type Node,
  type NodeMouseHandler,
} from '@xyflow/react'
import '@xyflow/react/dist/style.css'
import type { MindMapContent, MindMapNode } from '../../types/studyArtifacts'
import { pickStudyEvidence } from '../../types/studyArtifacts'
import MindmapFlowNode from '../mindmap/MindmapFlowNode'
import '../mindmap/mindmap-flow.css'
import { EmptyState } from '../ui/EmptyState'
import './study.css'

export type SubjectMindMapViewProps = {
  content: MindMapContent | null | undefined
  onOpenEvidence?: (meetingId: number, segmentId: string) => void
  testId?: string
}

const nodeTypes = { mindmap: MindmapFlowNode }

const resolveKind = (
  depth: number,
  type: string | undefined,
  hasChildren: boolean,
): 'root' | 'hub' | 'leaf' => {
  const normalized = (type || '').toUpperCase()
  if (normalized === 'SUBJECT' || depth === 0) return 'root'
  if (normalized === 'TOPIC' || normalized === 'CHAPTER' || hasChildren) return 'hub'
  return 'leaf'
}

export const hasCycleOrOrphan = (rootId: string, nodes: MindMapNode[]): boolean => {
  const ids = new Set(nodes.map((n) => n.id))
  ids.add(rootId)
  const parents = new Map(nodes.map((n) => [n.id, n.parentId ?? null]))
  for (const node of nodes) {
    if (!node.parentId || !ids.has(node.parentId)) {
      return true
    }
    let parent: string | null | undefined = node.parentId
    const seen = new Set<string>([node.id])
    while (parent && parent !== rootId) {
      if (seen.has(parent) || !ids.has(parent)) {
        return true
      }
      seen.add(parent)
      parent = parents.get(parent) ?? null
    }
  }
  return false
}

export const layoutNodes = (content: MindMapContent): { nodes: Node[]; edges: Edge[] } => {
  const rootId = content.root.id || 'root'
  const validNodes = content.nodes.filter((node) => node.id && node.id !== rootId)
  if (hasCycleOrOrphan(rootId, validNodes)) {
    return { nodes: [], edges: [] }
  }

  const children = new Map<string, MindMapNode[]>()
  for (const node of validNodes) {
    const parent = node.parentId || rootId
    const list = children.get(parent) ?? []
    list.push(node)
    children.set(parent, list)
  }

  // Stable visual order: hubs with larger subtrees first, then label.
  const subtreeSize = (id: string): number => {
    const kids = children.get(id) ?? []
    if (kids.length === 0) return 1
    return kids.reduce((sum, kid) => sum + subtreeSize(kid.id), 0)
  }
  for (const [parent, kids] of children) {
    kids.sort((a, b) => {
      const sizeDiff = subtreeSize(b.id) - subtreeSize(a.id)
      if (sizeDiff !== 0) return sizeDiff
      return (a.label || a.id).localeCompare(b.label || b.id, 'vi')
    })
    children.set(parent, kids)
  }

  const flowNodes: Node[] = []
  const flowEdges: Edge[] = []
  const levelGapX = 360
  const leafGapY = 156

  const measureLeaves = (id: string): number => {
    const kids = children.get(id) ?? []
    if (kids.length === 0) return 1
    return kids.reduce((sum, kid) => sum + measureLeaves(kid.id), 0)
  }

  const walk = (parentId: string, depth: number, leafStart: number): number => {
    const kids = children.get(parentId) ?? []
    if (kids.length === 0) {
      return leafStart + 1
    }

    let cursor = leafStart
    for (let index = 0; index < kids.length; index += 1) {
      const child = kids[index]
      const leafCount = measureLeaves(child.id)
      const childLeafStart = cursor
      const childLeafEnd = walk(child.id, depth + 1, childLeafStart)
      const centerLeaf = childLeafStart + (leafCount - 1) / 2
      const midY = centerLeaf * leafGapY

      const childEvidence = pickStudyEvidence(child)
      const hasChildren = (children.get(child.id) ?? []).length > 0
      const kind = resolveKind(depth, child.type, hasChildren)
      flowNodes.push({
        id: child.id,
        type: 'mindmap',
        position: { x: depth * levelGapX, y: midY },
        data: {
          label: child.label || child.id,
          kind,
          title: child.description || child.label || child.id,
          evidenceMeetingId: childEvidence?.meetingId,
          evidenceSegmentId: childEvidence?.segmentId,
        },
        style: childEvidence ? { cursor: 'pointer' } : undefined,
      })
      flowEdges.push({
        id: `${parentId}->${child.id}`,
        source: parentId,
        target: child.id,
        type: 'smoothstep',
        className:
          depth === 1 ? 'mindmap-flow-edge mindmap-flow-edge--primary' : 'mindmap-flow-edge',
      })
      cursor = childLeafEnd
      // Extra leaf slots between sibling subtrees so fan-out edges stay readable.
      if (index < kids.length - 1) {
        cursor += 0.55
      }
    }
    return cursor
  }

  const totalLeafSlots = walk(rootId, 1, 0)
  const treeHeight = Math.max(0, (totalLeafSlots - 1) * leafGapY)
  const rootY =
    (children.get(rootId) ?? []).length > 0
      ? flowNodes
          .filter((node) => (node.position.x ?? 0) === levelGapX)
          .reduce((sum, node, _i, arr) => sum + node.position.y / arr.length, 0)
      : treeHeight / 2

  flowNodes.unshift({
    id: rootId,
    type: 'mindmap',
    position: { x: 0, y: Number.isFinite(rootY) ? rootY : 0 },
    data: {
      label: content.root.label || 'Subject',
      kind: 'root',
      title: content.root.label || 'Subject',
    },
  })

  // Only keep tree edges (parentId links). Extra model edges create crossing wires.
  const treeEdgeIds = new Set(flowEdges.map((edge) => edge.id))
  const parentById = new Map(validNodes.map((node) => [node.id, node.parentId || rootId]))
  for (const edge of content.edges ?? []) {
    if (!edge.source || !edge.target) continue
    const id = `${edge.source}->${edge.target}`
    if (treeEdgeIds.has(id)) continue
    if (parentById.get(edge.target) !== edge.source) continue
    flowEdges.push({
      id,
      source: edge.source,
      target: edge.target,
      type: 'smoothstep',
      className: 'mindmap-flow-edge',
    })
    treeEdgeIds.add(id)
  }

  const placed = new Set(flowNodes.map((n) => n.id))
  let orphanY = treeHeight + leafGapY
  for (const node of validNodes) {
    if (placed.has(node.id)) continue
    const orphanEvidence = pickStudyEvidence(node)
    flowNodes.push({
      id: node.id,
      type: 'mindmap',
      position: { x: levelGapX, y: orphanY },
      data: {
        label: node.label || node.id,
        kind: 'leaf',
        title: node.description || node.label || node.id,
        evidenceMeetingId: orphanEvidence?.meetingId,
        evidenceSegmentId: orphanEvidence?.segmentId,
      },
      style: orphanEvidence ? { cursor: 'pointer' } : undefined,
    })
    orphanY += leafGapY
  }

  return { nodes: flowNodes, edges: flowEdges }
}

export function SubjectMindMapView({
  content,
  onOpenEvidence,
  testId = 'subject-mind-map-view',
}: SubjectMindMapViewProps) {
  const { nodes, edges } = useMemo(() => {
    if (!content?.root) {
      return { nodes: [] as Node[], edges: [] as Edge[] }
    }
    return layoutNodes(content)
  }, [content])

  const handleNodeClick = useCallback<NodeMouseHandler>(
    (_event, node) => {
      if (!onOpenEvidence) return
      const data = node.data as { evidenceMeetingId?: number; evidenceSegmentId?: string }
      if (data.evidenceMeetingId != null && data.evidenceSegmentId) {
        onOpenEvidence(data.evidenceMeetingId, data.evidenceSegmentId)
      }
    },
    [onOpenEvidence],
  )

  if (!content?.root) {
    return <EmptyState message="Chưa có mind map cho môn học này." />
  }

  if (nodes.length <= 1) {
    return (
      <div className="study-mindmap study-mindmap--empty" data-testid={testId}>
        <EmptyState message="Mind map chưa đủ dữ liệu hợp lệ để hiển thị (có thể có node mồ côi hoặc chu trình)." />
      </div>
    )
  }

  return (
    <div className="study-mindmap study-mindmap--stage" data-testid={testId}>
      <div className="mindmap-flow-view study-mindmap__shell">
        <p className="mindmap-flow-view__hint">
          Sơ đồ cây trái → phải · kéo node để sắp xếp · zoom bằng nút điều khiển · bấm node có bằng
          chứng để mở transcript
        </p>
        <div className="mindmap-flow-view__canvas study-mindmap__canvas">
          <ReactFlow
            nodes={nodes}
            edges={edges}
            nodeTypes={nodeTypes}
            nodeOrigin={[0.5, 0.5]}
            fitView
            fitViewOptions={{ padding: 0.1, maxZoom: 1.15 }}
            nodesDraggable
            nodesConnectable={false}
            elementsSelectable
            minZoom={0.15}
            maxZoom={1.85}
            defaultEdgeOptions={{
              type: 'smoothstep',
              className: 'mindmap-flow-edge',
            }}
            onNodeClick={onOpenEvidence ? handleNodeClick : undefined}
            proOptions={{ hideAttribution: true }}
          >
            <Background gap={22} size={1} color="rgba(148,163,184,0.16)" />
            <Controls showInteractive />
            <MiniMap
              pannable
              zoomable
              nodeColor={(node) => {
                const kind = (node.data as { kind?: string } | undefined)?.kind
                if (kind === 'root') return '#4338ca'
                if (kind === 'hub') return '#1e293b'
                return '#334155'
              }}
            />
          </ReactFlow>
        </div>
      </div>
    </div>
  )
}

export default SubjectMindMapView
