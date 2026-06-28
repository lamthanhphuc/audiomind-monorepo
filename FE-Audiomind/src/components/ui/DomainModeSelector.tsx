import { DOMAIN_MODE_OPTIONS, type DomainMode } from '../../constants/domainMode'

type DomainModeSelectorProps = {
  id?: string
  value: DomainMode
  onChange: (value: DomainMode) => void
  disabled?: boolean
  testId?: string
  compact?: boolean
}

export default function DomainModeSelector({
  id = 'domain-mode',
  value,
  onChange,
  disabled,
  testId = 'domain-mode-select',
  compact = false,
}: DomainModeSelectorProps) {
  const selected = DOMAIN_MODE_OPTIONS.find((option) => option.value === value)

  const select = (
    <select
      id={id}
      className={compact ? 'upload-panel__select' : undefined}
      value={value}
      disabled={disabled}
      data-testid={testId}
      onChange={(event) => onChange(event.target.value as DomainMode)}
    >
      {DOMAIN_MODE_OPTIONS.map((option) => (
        <option key={option.value} value={option.value}>
          {option.label}
        </option>
      ))}
    </select>
  )

  if (compact) {
    return (
      <label className="upload-panel__label domain-mode-selector domain-mode-selector--compact" htmlFor={id}>
        <span className="upload-panel__label-text">Lĩnh vực phân tích</span>
        {select}
      </label>
    )
  }

  return (
    <div className="form-group domain-mode-selector">
      <label htmlFor={id}>Lĩnh vực phân tích</label>
      {select}
      {selected && <p className="domain-mode-selector__hint">{selected.hint}</p>}
    </div>
  )
}
