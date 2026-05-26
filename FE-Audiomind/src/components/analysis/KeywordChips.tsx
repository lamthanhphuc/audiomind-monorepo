import './analysis-panel.css'

type KeywordChipsProps = {
  keywords: string[]
  emptyMessage?: string
}

export const KeywordChips = ({
  keywords,
  emptyMessage = 'Không có từ khóa',
}: KeywordChipsProps) => {
  if (keywords.length === 0) {
    return <p className="analysis-section__empty">{emptyMessage}</p>
  }

  return (
    <div className="keyword-chips">
      {keywords.map((keyword) => (
        <span key={keyword} className="keyword-chips__chip">
          {keyword}
        </span>
      ))}
    </div>
  )
}
