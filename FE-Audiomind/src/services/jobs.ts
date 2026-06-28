import { getAccessToken } from './auth'
import { USER_API_BASE } from './config'

export type ProcessingJobItem = {
  meetingId: number
  meetingTitle?: string | null
  status: string
  progress?: number
  stage?: string | null
  error?: string | null
  updatedAt?: string | null
  meetingStatus?: string | null
  active?: boolean
}

export type MyJobsResponse = {
  status: string
  processing: {
    source?: string
    userId?: number
    jobs: ProcessingJobItem[]
    activeCount?: number
    error?: string
  }
  meeting: {
    source?: string
    userId?: number
    meetings: Array<Record<string, unknown>>
    error?: string
  }
}

const authHeaders = (): HeadersInit => {
  const token = getAccessToken()
  if (!token) throw new Error('Phiên đăng nhập đã hết hạn')
  return {
    Authorization: `Bearer ${token}`,
    'Content-Type': 'application/json',
  }
}

const normalizeJob = (raw: unknown): ProcessingJobItem | null => {
  const record = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : null
  if (!record) return null
  const meetingId = Number(record.meetingId)
  if (!Number.isFinite(meetingId) || meetingId <= 0) return null
  return {
    meetingId,
    meetingTitle: record.meetingTitle == null ? null : String(record.meetingTitle),
    status: String(record.status ?? 'UNKNOWN'),
    progress: record.progress == null ? undefined : Number(record.progress),
    stage: record.stage == null ? null : String(record.stage),
    error: record.error == null ? null : String(record.error),
    updatedAt: record.updatedAt == null ? null : String(record.updatedAt),
    meetingStatus: record.meetingStatus == null ? null : String(record.meetingStatus),
    active: Boolean(record.active),
  }
}

export async function getMyJobs(): Promise<MyJobsResponse> {
  const response = await fetch(`${USER_API_BASE}/api/users/me/jobs`, {
    headers: authHeaders(),
  })
  if (!response.ok) {
    throw new Error('Không tải được danh sách công việc')
  }
  const body = (await response.json()) as MyJobsResponse
  const processing = body.processing ?? { jobs: [] }
  const jobs = Array.isArray(processing.jobs)
    ? processing.jobs.map(normalizeJob).filter((item): item is ProcessingJobItem => item !== null)
    : []
  return {
    status: String(body.status ?? 'ok'),
    processing: { ...processing, jobs },
    meeting: body.meeting ?? { meetings: [] },
  }
}

export function listActiveJobs(jobs: ProcessingJobItem[]): ProcessingJobItem[] {
  return jobs.filter((job) => job.active || ['QUEUED', 'RUNNING', 'RETRYING'].includes(job.status.toUpperCase()))
}
