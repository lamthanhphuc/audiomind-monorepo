import { Handle, Position, type NodeProps } from '@xyflow/react'

type MindmapFlowNodeData = {
  label: string
  kind: 'root' | 'hub' | 'leaf'
  tone?: string
  title?: string
}

const toneClass = (tone?: string) => {
  switch (tone) {
    case 'accent': return 'mindmap-flow-node--accent'
    case 'high': return 'mindmap-flow-node--high'
    case 'medium': return 'mindmap-flow-node--medium'
    case 'low': return 'mindmap-flow-node--low'
    case 'muted': return 'mindmap-flow-node--muted'
    default: return ''
  }
}

export default function MindmapFlowNode({ data }: NodeProps) {
  const nodeData = data as MindmapFlowNodeData
  const className = [
    'mindmap-flow-node',
    `mindmap-flow-node--${nodeData.kind}`,
    nodeData.kind === 'leaf' ? toneClass(nodeData.tone) : '',
  ].filter(Boolean).join(' ')

  return (
    <div className={className} title={nodeData.title}>
      {nodeData.kind !== 'root' && (
        <Handle className="mindmap-flow-handle" type="target" position={Position.Left} />
      )}
      <span className="mindmap-flow-node__label">{nodeData.label}</span>
      {nodeData.kind !== 'leaf' && (
        <Handle className="mindmap-flow-handle" type="source" position={Position.Right} />
      )}
    </div>
  )
}
