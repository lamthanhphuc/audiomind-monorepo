import { Link2 } from 'lucide-react'
import './education-panel.css'

export type EducationEvidenceButtonProps = {
  sourceSegmentIds: string[]
  onEvidenceClick?: (segmentId: string) => void
  label?: string
}

export function EducationEvidenceButton({
  sourceSegmentIds,
  onEvidenceClick,
  label = 'Xem bằng chứng',
}: EducationEvidenceButtonProps) {
  const segmentId = sourceSegmentIds.find((id) => id.trim())?.trim()
  if (!segmentId || !onEvidenceClick) {
    return null
  }

  return (
    <button
      type="button"
      className="education-evidence-btn"
      onClick={() => onEvidenceClick(segmentId)}
      data-testid="education-evidence-button"
      title={`Segment: ${segmentId}`}
    >
      <Link2 size={12} aria-hidden />
      {label}
    </button>
  )
}

export default EducationEvidenceButton
