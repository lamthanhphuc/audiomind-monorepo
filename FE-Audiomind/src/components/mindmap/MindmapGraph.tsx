import { useMemo } from 'react'
import type { MindmapBranch } from '../../utils/mindmapData'
import { buildMindmapLayout, getMindmapLayoutBounds } from '../../utils/mindmapLayout'
import './mindmap-graph.css'

type MindmapGraphProps = {
  rootLabel: string
  branches: MindmapBranch[]
  emptyMessage?: string
  testId?: string
}

const NODE_WIDTH = { root: 200, hub: 156, leaf: 140 } as const
const NODE_HEIGHT = { root: 52, hub: 44, leaf: 40 } as const

const edgePath = (x1: number, y1: number, x2: number, y2: number): string => {
  const midX = (x1 + x2) / 2
  return `M ${x1} ${y1} C ${midX} ${y1}, ${midX} ${y2}, ${x2} ${y2}`
}

export default function MindmapGraph({
  rootLabel,
  branches,
  emptyMessage = 'Chưa có dữ liệu để vẽ sơ đồ.',
  testId = 'mindmap-graph',
}: MindmapGraphProps) {
  const hasData = branches.some((branch) => branch.items.length > 0)
  const { nodes, edges, viewBox } = useMemo(() => {
    const layout = buildMindmapLayout(rootLabel, branches)
    const bounds = getMindmapLayoutBounds(layout.nodes, 72)
    return {
      nodes: layout.nodes,
      edges: layout.edges,
      viewBox: `${bounds.minX} ${bounds.minY} ${bounds.width} ${bounds.height}`,
    }
  }, [branches, rootLabel])

  if (!hasData) {
    return (
      <div className="mindmap-graph-view mindmap-graph-view--empty" data-testid={testId}>
        <p>{emptyMessage}</p>
      </div>
    )
  }

  const nodeById = new Map(nodes.map((node) => [node.id, node]))

  return (
    <div className="mindmap-graph-view" data-testid={testId}>
      <svg
        className="mindmap-graph-view__svg"
        viewBox={viewBox}
        role="img"
        aria-label={`Sơ đồ mindmap: ${rootLabel}`}
      >
        {edges.map((edge) => {
          const from = nodeById.get(edge.from)
          const to = nodeById.get(edge.to)
          if (!from || !to) return null
          const fromWidth = NODE_WIDTH[from.kind]
          const toWidth = NODE_WIDTH[to.kind]
          const x1 = from.x + fromWidth / 2
          const y1 = from.y
          const x2 = to.x - toWidth / 2
          const y2 = to.y
          return (
            <path
              key={edge.id}
              className="mindmap-graph-view__edge"
              d={edgePath(x1, y1, x2, y2)}
              fill="none"
            />
          )
        })}
        {nodes.map((node) => {
          const width = NODE_WIDTH[node.kind]
          const height = NODE_HEIGHT[node.kind]
          return (
            <g key={node.id} transform={`translate(${node.x}, ${node.y})`}>
              <foreignObject
                x={-width / 2}
                y={-height / 2}
                width={width}
                height={height}
              >
                <div
                  className={`mindmap-graph-node mindmap-graph-node--${node.kind}${node.tone ? ` mindmap-graph-node--${node.tone}` : ''}`}
                  title={node.title}
                  data-testid={node.id === 'root' ? 'mindmap-root-label' : undefined}
                >
                  {node.label}
                </div>
              </foreignObject>
            </g>
          )
        })}
      </svg>
    </div>
  )
}
