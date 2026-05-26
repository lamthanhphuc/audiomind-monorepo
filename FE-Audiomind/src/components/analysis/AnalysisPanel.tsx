import type { AiAnalysis } from '../../types'
import { EmptyState } from '../ui/EmptyState'
import { ErrorState } from '../ui/ErrorState'
import { LoadingState } from '../ui/LoadingState'
import { AnalysisSection } from './AnalysisSection'
import { KeywordChips } from './KeywordChips'
import { PainPointCard } from './PainPointCard'
import { TechnicalTermCard } from './TechnicalTermCard'
import './analysis-panel.css'

export type AnalysisPanelStatus = 'idle' | 'loading' | 'ready' | 'empty' | 'error'

type AnalysisPanelProps = {
  title?: string
  analysis: AiAnalysis | null
  status?: AnalysisPanelStatus
  loadingMessage?: string
  errorMessage?: string | null
  emptyMessage?: string
  summaryFallback?: string
  testId?: string
  summaryTestId?: string
}

export const AnalysisPanel = ({
  title = 'Phân tích AI',
  analysis,
  status = 'ready',
  loadingMessage = 'Đang tải phân tích...',
  errorMessage = null,
  emptyMessage = 'Chưa có kết quả phân tích',
  summaryFallback = '(empty)',
  testId,
  summaryTestId,
}: AnalysisPanelProps) => {
  if (status === 'loading') {
    return (
      <section className="analysis-panel" data-testid={testId}>
        <header className="analysis-panel__header">
          <h2 className="analysis-panel__title">{title}</h2>
        </header>
        <LoadingState message={loadingMessage} />
      </section>
    )
  }

  if (errorMessage) {
    return (
      <section className="analysis-panel" data-testid={testId}>
        <header className="analysis-panel__header">
          <h2 className="analysis-panel__title">{title}</h2>
        </header>
        <ErrorState message={errorMessage} title="Không thể tải phân tích" />
      </section>
    )
  }

  if (!analysis || status === 'empty') {
    return (
      <section className="analysis-panel" data-testid={testId}>
        <header className="analysis-panel__header">
          <h2 className="analysis-panel__title">{title}</h2>
        </header>
        <EmptyState message={emptyMessage} />
      </section>
    )
  }

  const keywords = analysis.keywords ?? []
  const technicalTerms = analysis.technicalTerms ?? []
  const painPoints = analysis.painPoints ?? []
  const actionItems = analysis.actionItems ?? []

  return (
    <section className="analysis-panel" data-testid={testId}>
      <header className="analysis-panel__header">
        <h2 className="analysis-panel__title">{title}</h2>
        <span className="analysis-panel__domain">{analysis.domainMode ?? 'it'}</span>
      </header>

      <AnalysisSection title="Tóm tắt" isEmpty={!analysis.summary}>
        <p
          className="analysis-panel__summary"
          data-testid={summaryTestId ?? (testId ? `${testId}-summary` : undefined)}
        >
          {analysis.summary || summaryFallback}
        </p>
      </AnalysisSection>

      <AnalysisSection title="Từ khóa" isEmpty={keywords.length === 0} emptyMessage="Không có từ khóa">
        <KeywordChips keywords={keywords} />
      </AnalysisSection>

      <AnalysisSection
        title="Thuật ngữ kỹ thuật"
        isEmpty={technicalTerms.length === 0}
        emptyMessage="Không có thuật ngữ kỹ thuật"
      >
        {technicalTerms.map((item) => (
          <TechnicalTermCard key={item.term} term={item} />
        ))}
      </AnalysisSection>

      <AnalysisSection title="Pain points" isEmpty={painPoints.length === 0} emptyMessage="Không có pain points">
        {painPoints.map((item) => (
          <PainPointCard key={`${item.title}-${item.severity}`} item={item} />
        ))}
      </AnalysisSection>

      <AnalysisSection title="Đầu việc" isEmpty={actionItems.length === 0} emptyMessage="Không có đầu việc">
        <ul className="analysis-action-list">
          {actionItems.map((item) => (
            <li key={item}>{item}</li>
          ))}
        </ul>
      </AnalysisSection>
    </section>
  )
}
