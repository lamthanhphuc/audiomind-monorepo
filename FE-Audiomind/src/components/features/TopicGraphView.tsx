import { useMemo } from 'react'

import type { AiAnalysis } from '../../types'
import { buildTopicGraph } from '../../utils/topicGraphData'

type Props = {
  analysis?: AiAnalysis | null
}

const WIDTH = 720
const HEIGHT = 420

export default function TopicGraphView({ analysis }: Props) {
  const graph = useMemo(() => buildTopicGraph(analysis ?? null), [analysis])
  const radius = 150

  const nodePositions = useMemo(() => {
    return graph.nodes.map((node, index) => {
      const angle = (Math.PI * 2 * index) / Math.max(graph.nodes.length, 1) - Math.PI / 2
      return {
        ...node,
        x: WIDTH / 2 + Math.cos(angle) * radius,
        y: HEIGHT / 2 + Math.sin(angle) * radius,
      }
    })
  }, [graph.nodes])

  if (graph.nodes.length === 0) {
    return (
      <section className="topic-graph topic-graph--empty" data-testid="topic-graph">
        <p>Chưa đủ keywords/thuật ngữ để dựng topic graph.</p>
      </section>
    )
  }

  const positionById = new Map(nodePositions.map((node) => [node.id, node]))

  return (
    <section className="topic-graph" data-testid="topic-graph">
      <header className="topic-graph__header">
        <h3>Topic graph</h3>
        <p>Liên kết đồng xuất hiện giữa keywords và technical terms.</p>
      </header>
      <svg className="topic-graph__svg" viewBox={`0 0 ${WIDTH} ${HEIGHT}`} role="img" aria-label="Topic graph">
        {graph.edges.map((edge) => {
          const source = positionById.get(edge.source)
          const target = positionById.get(edge.target)
          if (!source || !target) {
            return null
          }
          return (
            <line
              key={edge.id}
              x1={source.x}
              y1={source.y}
              x2={target.x}
              y2={target.y}
              stroke="rgba(124,108,255,0.35)"
              strokeWidth={1 + edge.weight}
            />
          )
        })}
        {nodePositions.map((node) => (
          <g key={node.id}>
            <circle cx={node.x} cy={node.y} r={24} fill="rgba(124,108,255,0.18)" stroke="rgba(124,108,255,0.55)" />
            <text x={node.x} y={node.y + 4} textAnchor="middle" fontSize="11" fill="currentColor">
              {node.label.length > 12 ? `${node.label.slice(0, 11)}…` : node.label}
            </text>
          </g>
        ))}
      </svg>
    </section>
  )
}
