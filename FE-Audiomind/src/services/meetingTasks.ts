import { getAccessToken } from './auth'
import { MEETING_API_BASE } from './config'
import type { GroupedActionPlan } from '../types'

export type MeetingTask = {
  id: number
  meetingId: number
  title: string
  owner?: string | null
  deadline?: string | null
  priority?: string | null
  status?: string | null
  sourceKey?: string | null
  createdAt?: string | null
  updatedAt?: string | null
}

const withAuthHeaders = (): Headers => {
  const headers = new Headers({ 'Content-Type': 'application/json' })
  const token = getAccessToken()
  if (token) {
    headers.set('Authorization', `Bearer ${token}`)
  }
  return headers
}

const normalizeTask = (value: Record<string, unknown>): MeetingTask => ({
  id: Number(value.id),
  meetingId: Number(value.meetingId ?? value.meeting_id),
  title: String(value.title ?? ''),
  owner: value.owner == null ? null : String(value.owner),
  deadline: value.deadline == null ? null : String(value.deadline),
  priority: value.priority == null ? null : String(value.priority),
  status: value.status == null ? null : String(value.status),
  sourceKey: value.sourceKey == null && value.source_key == null
    ? null
    : String(value.sourceKey ?? value.source_key),
  createdAt: value.createdAt == null && value.created_at == null
    ? null
    : String(value.createdAt ?? value.created_at),
  updatedAt: value.updatedAt == null && value.updated_at == null
    ? null
    : String(value.updatedAt ?? value.updated_at),
})

export const listMeetingTasks = async (meetingId: number): Promise<MeetingTask[]> => {
  const response = await fetch(`${MEETING_API_BASE}/meetings/${meetingId}/tasks`, {
    headers: withAuthHeaders(),
  })
  if (!response.ok) {
    throw new Error(await response.text())
  }
  const body = await response.json() as { items?: unknown[] }
  return Array.isArray(body.items)
    ? body.items
      .filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === 'object')
      .map(normalizeTask)
    : []
}

export const createMeetingTask = async (
  meetingId: number,
  payload: Partial<MeetingTask>,
): Promise<MeetingTask> => {
  const response = await fetch(`${MEETING_API_BASE}/meetings/${meetingId}/tasks`, {
    method: 'POST',
    headers: withAuthHeaders(),
    body: JSON.stringify(payload),
  })
  if (!response.ok) {
    throw new Error(await response.text())
  }
  return normalizeTask(await response.json() as Record<string, unknown>)
}

export const updateMeetingTask = async (
  meetingId: number,
  taskId: number,
  payload: Partial<MeetingTask>,
): Promise<MeetingTask> => {
  const response = await fetch(`${MEETING_API_BASE}/meetings/${meetingId}/tasks/${taskId}`, {
    method: 'PATCH',
    headers: withAuthHeaders(),
    body: JSON.stringify(payload),
  })
  if (!response.ok) {
    throw new Error(await response.text())
  }
  return normalizeTask(await response.json() as Record<string, unknown>)
}

export const seedMeetingTasksFromActionPlan = async (
  meetingId: number,
  groupedActionPlan: GroupedActionPlan | null | undefined,
): Promise<MeetingTask[]> => {
  const response = await fetch(`${MEETING_API_BASE}/meetings/${meetingId}/tasks/seed-from-action-plan`, {
    method: 'POST',
    headers: withAuthHeaders(),
    body: JSON.stringify({ groupedActionPlan }),
  })
  if (!response.ok) {
    throw new Error(await response.text())
  }
  const body = await response.json() as { items?: unknown[] }
  return Array.isArray(body.items)
    ? body.items
      .filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === 'object')
      .map(normalizeTask)
    : []
}
