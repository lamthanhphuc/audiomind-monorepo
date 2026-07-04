export type DomainMode = 'general' | 'it' | 'business' | 'education'

export const DOMAIN_MODE_OPTIONS: Array<{ value: DomainMode; label: string; hint: string }> = [
  { value: 'general', label: 'Chung', hint: 'Cuộc họp đa lĩnh vực, ngôn ngữ trung tính' },
  { value: 'it', label: 'CNTT / Kỹ thuật', hint: 'Sprint, API, kiến trúc, bug, deploy' },
  { value: 'business', label: 'Kinh doanh', hint: 'KPI, doanh thu, khách hàng, chiến lược' },
  { value: 'education', label: 'Giáo dục', hint: 'Bài giảng, học phần, đánh giá' },
]

export const DEFAULT_DOMAIN_MODE: DomainMode = 'it'

export const normalizeDomainMode = (value: unknown): DomainMode => {
  const normalized = String(value ?? '').trim().toLowerCase()
  if (normalized === 'general' || normalized === 'it' || normalized === 'business' || normalized === 'education') {
    return normalized
  }
  return DEFAULT_DOMAIN_MODE
}

export const formatDomainModeLabel = (value: unknown): string => {
  const mode = normalizeDomainMode(value)
  return DOMAIN_MODE_OPTIONS.find((option) => option.value === mode)?.label ?? mode
}
