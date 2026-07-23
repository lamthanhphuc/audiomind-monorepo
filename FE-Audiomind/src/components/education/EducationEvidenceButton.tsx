import { Link2 } from 'lucide-react'
import type { EvidenceClickHandler } from '../../utils/transcriptEvidence'
import './education-panel.css'

export type EducationEvidenceButtonProps = {
  sourceSegmentIds: string[]
  onEvidenceClick?: EvidenceClickHandler
  label?: string
  /** When true, evidence links cannot be resolved reliably; hide the button and show a hint instead. */
  evidenceUnavailable?: boolean
}

export function EducationEvidenceButton({
  sourceSegmentIds,
  onEvidenceClick,
  label = 'Xem bằng chứng',
  evidenceUnavailable = false,
}: EducationEvidenceButtonProps) {
  const segmentIds = sourceSegmentIds.map((id) => id.trim()).filter(Boolean)
  if (segmentIds.length === 0 || !onEvidenceClick) {
    return null
  }

  if (evidenceUnavailable) {
    return (
      <span className="education-evidence-unavailable" data-testid="education-evidence-unavailable">
        Transcript hiện không có định danh evidence ổn định.
      </span>
    )
  }

  return (
    <button
      type="button"
      className="education-evidence-btn"
      onClick={() => onEvidenceClick(segmentIds)}
      data-testid="education-evidence-button"
      title="Mở đoạn trích liên quan"
    >
      <Link2 size={12} aria-hidden />
      {label}
    </button>
  )
}

export default EducationEvidenceButton
