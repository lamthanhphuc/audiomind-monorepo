import type { ReactNode } from 'react'
import './analysis-panel.css'

type AnalysisSectionProps = {
  title: string
  children: ReactNode
  emptyMessage?: string
  isEmpty?: boolean
}

export const AnalysisSection = ({
  title,
  children,
  emptyMessage = 'Không có dữ liệu',
  isEmpty = false,
}: AnalysisSectionProps) => (
  <section className="analysis-section">
    <h3 className="analysis-section__title">{title}</h3>
    {isEmpty ? (
      <p className="analysis-section__empty">{emptyMessage}</p>
    ) : (
      <div className="analysis-section__body">{children}</div>
    )}
  </section>
)
