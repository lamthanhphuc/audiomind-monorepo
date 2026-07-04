import { useMemo, useState } from 'react'
import {
  Background,
  Controls,
  MiniMap,
  ReactFlow,
  type Edge,
  type Node,
} from '@xyflow/react'
import '@xyflow/react/dist/style.css'

import type { MindmapBranch } from '../../utils/mindmapData'
import { buildMindmapLayout } from '../../utils/mindmapLayout'
import MindmapFlowNode from './MindmapFlowNode'
import './mindmap-flow.css'

const nodeTypes = { mindmap: MindmapFlowNode }

type Props = {
  rootLabel: string
  branches: MindmapBranch[]
  testId?: string
}

export default function MindmapFlow({ rootLabel, branches, testId = 'mindmap-flow' }: Props) {
  const [collapsedHubs, setCollapsedHubs] = useState<Record<string, boolean>>({})

  const toggleHub = (hubId: string) => {
    setCollapsedHubs((current) => ({
      ...current,
      [hubId]: !current[hubId],
    }))
  }

  const { nodes, edges } = useMemo(() => {
    const layout = buildMindmapLayout(rootLabel, branches, collapsedHubs)
    const flowNodes: Node[] = layout.nodes.map((node) => ({
      id: node.id,
      type: 'mindmap',
      position: { x: node.x, y: node.y },
      data: {
        label: node.label,
        kind: node.kind,
        tone: node.tone,
        title: node.title,
      },
      draggable: true,
    }))
    const flowEdges: Edge[] = layout.edges.map((edge) => ({
      id: edge.id,
      source: edge.from,
      target: edge.to,
      type: 'smoothstep',
      className: 'mindmap-flow-edge',
    }))
    return { nodes: flowNodes, edges: flowEdges }
  }, [branches, collapsedHubs, rootLabel])

  if (nodes.length <= 1) {
    return (
      <div className="mindmap-flow-view mindmap-flow-view--empty" data-testid={testId}>
        <p>Chưa đủ dữ liệu để hiển thị mindmap tương tác.</p>
      </div>
    )
  }

  return (
    <div className="mindmap-flow-view" data-testid={testId}>
      <p className="mindmap-flow-view__hint">
        Sơ đồ cây trái → phải · bấm nhánh để thu gọn · kéo node để sắp xếp · zoom bằng nút điều khiển
      </p>
      <div className="mindmap-flow-view__canvas">
        <ReactFlow
          nodes={nodes}
          edges={edges}
          nodeTypes={nodeTypes}
          nodeOrigin={[0.5, 0.5]}
          fitView
          fitViewOptions={{ padding: 0.2 }}
          nodesDraggable
          nodesConnectable={false}
          elementsSelectable
          panOnScroll={false}
          zoomOnScroll={false}
          preventScrolling={false}
          minZoom={0.25}
          maxZoom={1.6}
          onNodeClick={(_event, node) => {
            if (node.id.startsWith('hub-')) {
              toggleHub(node.id)
            }
          }}
        >
          <Background gap={20} size={1} color="rgba(148,163,184,0.18)" />
          <Controls showInteractive />
          <MiniMap
            pannable
            zoomable
            nodeColor={(node) => (
              node.id === 'root' ? '#4338ca' : node.id.startsWith('hub-') ? '#1e293b' : '#334155'
            )}
            maskColor="rgba(12, 16, 24, 0.75)"
          />
        </ReactFlow>
      </div>
    </div>
  )
}
