import type { AiAnalysis } from '../../types'
import { formatDomainModeLabel } from '../../constants/domainMode'
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
  summaryFallback = '(trống)',
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
  const businessActionItems = analysis.businessActionItems ?? []
  const decisions = analysis.keyDecisions ?? analysis.decisions ?? []
  const risks = analysis.risks ?? []
  const blockers = analysis.blockers ?? []
  const nextSteps = analysis.nextSteps ?? []
  const hasImpact = Boolean(
    analysis.businessImpact?.trim() || analysis.customerImpact?.trim() || analysis.technicalImpact?.trim(),
  )
  const normalizedConfidence = typeof analysis.confidence === 'number'
    ? Math.max(0, Math.min(1, analysis.confidence > 1 && analysis.confidence <= 100 ? analysis.confidence / 100 : analysis.confidence))
    : undefined
  const actionItemDetails = businessActionItems.length > 0
    ? businessActionItems
    : actionItems.map((task) => ({
      task,
      owner: undefined,
      dueDate: undefined,
      deadline: undefined,
      priority: undefined,
      status: undefined,
      evidence: undefined,
    }))
  const summaryText = analysis.meetingSummary || analysis.summary

  return (
    <section className="analysis-panel" data-testid={testId}>
      <header className="analysis-panel__header">
        <h2 className="analysis-panel__title">{title}</h2>
        <span className="analysis-panel__domain">{formatDomainModeLabel(analysis.domainMode)}</span>
      </header>

      <AnalysisSection title="Tóm tắt" isEmpty={!summaryText}>
        <p
          className="analysis-panel__summary"
          data-testid={summaryTestId ?? (testId ? `${testId}-summary` : undefined)}
        >
          {summaryText || summaryFallback}
        </p>
      </AnalysisSection>

      <AnalysisSection title="Quyết định chính" isEmpty={decisions.length === 0} emptyMessage="Không có quyết định chính">
        <ul className="analysis-action-list">
          {decisions.map((item) => (
            <li key={item}>{item}</li>
          ))}
        </ul>
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

      <AnalysisSection title="Vấn đề / pain points" isEmpty={painPoints.length === 0} emptyMessage="Không có vấn đề được ghi nhận">
        {painPoints.map((item) => (
          <PainPointCard key={`${item.title}-${item.severity}`} item={item} />
        ))}
      </AnalysisSection>

      <AnalysisSection title="Đầu việc" isEmpty={actionItemDetails.length === 0} emptyMessage="Không có đầu việc">
        <ul className="analysis-action-list">
          {actionItemDetails.map((item) => (
            <li key={`${item.task}-${item.owner ?? 'none'}-${item.dueDate ?? item.deadline ?? 'none'}`}>
              <div className="analysis-action-item__task">{item.task}</div>
              {(item.owner || item.dueDate || item.deadline || item.priority || item.status) && (
                <div className="analysis-action-item__meta">
                  {item.owner && <span>Người phụ trách: {item.owner}</span>}
                  {(item.dueDate || item.deadline) && <span>Hạn: {item.dueDate ?? item.deadline}</span>}
                  {item.priority && <span>Ưu tiên: {item.priority}</span>}
                  {item.status && <span>Trạng thái: {item.status}</span>}
                </div>
              )}
              {item.evidence && <div className="analysis-action-item__evidence">Bằng chứng: {item.evidence}</div>}
            </li>
          ))}
        </ul>
      </AnalysisSection>

      <AnalysisSection title="Rủi ro" isEmpty={risks.length === 0} emptyMessage="Không có rủi ro">
        <ul className="analysis-action-list">
          {risks.map((item) => (
            <li key={item}>{item}</li>
          ))}
        </ul>
      </AnalysisSection>

      <AnalysisSection title="Điểm nghẽn" isEmpty={blockers.length === 0} emptyMessage="Không có điểm nghẽn">
        <ul className="analysis-action-list">
          {blockers.map((item) => (
            <li key={item}>{item}</li>
          ))}
        </ul>
      </AnalysisSection>

      <AnalysisSection title="Bước tiếp theo" isEmpty={nextSteps.length === 0} emptyMessage="Không có bước tiếp theo">
        <ul className="analysis-action-list">
          {nextSteps.map((item) => (
            <li key={item}>{item}</li>
          ))}
        </ul>
      </AnalysisSection>

      <AnalysisSection title="Tác động" isEmpty={!hasImpact} emptyMessage="Không có thông tin tác động">
        {analysis.businessImpact && <p className="analysis-panel__summary"><strong>Kinh doanh:</strong> {analysis.businessImpact}</p>}
        {analysis.customerImpact && <p className="analysis-panel__summary"><strong>Khách hàng:</strong> {analysis.customerImpact}</p>}
        {analysis.technicalImpact && <p className="analysis-panel__summary"><strong>Kỹ thuật:</strong> {analysis.technicalImpact}</p>}
      </AnalysisSection>

      <AnalysisSection
        title="Độ tin cậy"
        isEmpty={normalizedConfidence === undefined}
        emptyMessage="Không có độ tin cậy"
      >
        {normalizedConfidence !== undefined && (
          <p className="analysis-panel__summary">{Math.round(normalizedConfidence * 100)}%</p>
        )}
      </AnalysisSection>
    </section>
  )
}
