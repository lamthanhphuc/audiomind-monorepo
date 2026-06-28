import { describe, expect, it } from 'vitest'
import { listActiveJobs, type ProcessingJobItem } from '../services/jobs'
import { resolveNotificationMeetingId, type UserNotification } from '../services/notifications'

describe('notifications service', () => {
  it('resolveNotificationMeetingId returns meeting id from payload', () => {
    const notification: UserNotification = {
      id: 1,
      type: 'MEETING_SHARE_INVITE',
      title: 'Share',
      payload: { meetingId: 42 },
      read: false,
    }
    expect(resolveNotificationMeetingId(notification)).toBe(42)
  })
})

describe('jobs service', () => {
  it('listActiveJobs filters active and running statuses', () => {
    const jobs: ProcessingJobItem[] = [
      { meetingId: 1, status: 'COMPLETED' },
      { meetingId: 2, status: 'RUNNING', active: true },
      { meetingId: 3, status: 'QUEUED' },
    ]
    const active = listActiveJobs(jobs)
    expect(active.map((job) => job.meetingId)).toEqual([2, 3])
  })
})
