export const getStatusBadgeClass = (statusText: string): string => {
  const normalized = statusText.toLowerCase()
  if (normalized.includes('completed') || normalized.includes('hoàn tất')) {
    return 'status-badge status-badge--completed'
  }
  if (normalized.includes('failed') || normalized.includes('lỗi')) {
    return 'status-badge status-badge--failed'
  }
  if (
    normalized.includes('process')
    || normalized.includes('upload')
    || normalized.includes('queue')
    || normalized.includes('running')
    || normalized.includes('fetching')
    || normalized.includes('đang')
  ) {
    return 'status-badge status-badge--processing'
  }
  return 'status-badge status-badge--idle'
}
