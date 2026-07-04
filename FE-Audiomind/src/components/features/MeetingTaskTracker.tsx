import { useEffect, useMemo, useState } from 'react'

import type { GroupedActionPlan } from '../../types'
import {
  listMeetingTasks,
  seedMeetingTasksFromActionPlan,
  updateMeetingTask,
  type MeetingTask,
} from '../../services/meetingTasks'

type Props = {
  meetingId?: number | null
  groupedActionPlan?: GroupedActionPlan | null
}

const STATUS_OPTIONS = ['open', 'in_progress', 'blocked', 'done'] as const

export default function MeetingTaskTracker({ meetingId, groupedActionPlan }: Props) {
  const [tasks, setTasks] = useState<MeetingTask[]>([])
  const [loading, setLoading] = useState(false)
  const [seeding, setSeeding] = useState(false)
  const [statusFilter, setStatusFilter] = useState<string>('all')
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!meetingId) {
      setTasks([])
      return
    }
    let cancelled = false
    const load = async () => {
      setLoading(true)
      setError(null)
      try {
        const items = await listMeetingTasks(meetingId)
        if (!cancelled) {
          setTasks(items)
        }
      } catch (loadError) {
        if (!cancelled) {
          setError(loadError instanceof Error ? loadError.message : 'Không tải được tasks')
        }
      } finally {
        if (!cancelled) {
          setLoading(false)
        }
      }
    }
    void load()
    return () => {
      cancelled = true
    }
  }, [meetingId])

  const visibleTasks = useMemo(() => {
    if (statusFilter === 'all') {
      return tasks
    }
    return tasks.filter((task) => (task.status ?? 'open') === statusFilter)
  }, [statusFilter, tasks])

  const handleSeed = async () => {
    if (!meetingId || !groupedActionPlan) {
      return
    }
    setSeeding(true)
    setError(null)
    try {
      const seeded = await seedMeetingTasksFromActionPlan(meetingId, groupedActionPlan)
      if (seeded.length > 0) {
        setTasks((current) => [...seeded, ...current])
      } else {
        const items = await listMeetingTasks(meetingId)
        setTasks(items)
      }
    } catch (seedError) {
      setError(seedError instanceof Error ? seedError.message : 'Không seed được tasks')
    } finally {
      setSeeding(false)
    }
  }

  const handleStatusChange = async (task: MeetingTask, status: string) => {
    if (!meetingId) {
      return
    }
    try {
      const updated = await updateMeetingTask(meetingId, task.id, { status })
      setTasks((current) => current.map((item) => (item.id === updated.id ? updated : item)))
    } catch (updateError) {
      setError(updateError instanceof Error ? updateError.message : 'Không cập nhật được task')
    }
  }

  if (!meetingId) {
    return null
  }

  return (
    <section className="meeting-task-tracker" data-testid="meeting-task-tracker">
      <header className="meeting-task-tracker__header">
        <div>
          <h3>Task tracker</h3>
          <p>Theo dõi việc cần làm từ grouped action plan.</p>
        </div>
        <button
          type="button"
          className="secondary-cta"
          disabled={seeding || !groupedActionPlan}
          onClick={() => void handleSeed()}
          data-testid="meeting-task-seed"
        >
          {seeding ? 'Đang seed…' : 'Import từ action plan'}
        </button>
      </header>

      <div className="meeting-task-tracker__filters">
        <label htmlFor="meeting-task-status-filter">Lọc trạng thái</label>
        <select
          id="meeting-task-status-filter"
          value={statusFilter}
          onChange={(event) => setStatusFilter(event.target.value)}
        >
          <option value="all">Tất cả</option>
          {STATUS_OPTIONS.map((status) => (
            <option key={status} value={status}>{status}</option>
          ))}
        </select>
      </div>

      {loading && <p>Đang tải tasks…</p>}
      {error && <p role="alert">{error}</p>}
      {!loading && visibleTasks.length === 0 && (
        <p>Chưa có task. Hãy import từ grouped action plan.</p>
      )}

      <ul className="meeting-task-tracker__list">
        {visibleTasks.map((task) => (
          <li key={task.id} className="meeting-task-tracker__item">
            <label>
              <input
                type="checkbox"
                checked={(task.status ?? 'open') === 'done'}
                onChange={(event) => void handleStatusChange(
                  task,
                  event.target.checked ? 'done' : 'open',
                )}
              />
              <span>{task.title}</span>
            </label>
            <div className="meeting-task-tracker__meta">
              {task.owner && <span>{task.owner}</span>}
              {task.deadline && <span>{task.deadline}</span>}
              {task.priority && <span className="meta-pill">{task.priority}</span>}
            </div>
          </li>
        ))}
      </ul>
    </section>
  )
}
