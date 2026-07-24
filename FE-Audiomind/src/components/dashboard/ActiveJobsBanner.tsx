import { useEffect, useState } from 'react'
import { getMyJobs, listActiveJobs, type ProcessingJobItem } from '../../services/jobs'
import { formatJobStatus } from '../../utils/uiLabels'

type ActiveJobsBannerProps = {
  onOpenMeeting: (meetingId: number) => void
}

export default function ActiveJobsBanner({ onOpenMeeting }: ActiveJobsBannerProps) {
  const [jobs, setJobs] = useState<ProcessingJobItem[]>([])
  const [dismissed, setDismissed] = useState(false)

  useEffect(() => {
    let active = true
    const load = async () => {
      try {
        const response = await getMyJobs()
        if (!active) return
        setJobs(listActiveJobs(response.processing.jobs))
      } catch {
        if (active) setJobs([])
      }
    }
    void load()
    const timer = window.setInterval(() => {
      void load()
    }, 15_000)
    return () => {
      active = false
      window.clearInterval(timer)
    }
  }, [])

  if (dismissed || jobs.length === 0) {
    return null
  }

  return (
    <div className="active-jobs-banner" data-testid="active-jobs-banner">
      <div className="active-jobs-banner__content">
        <strong>Đang xử lý ({jobs.length})</strong>
        <ul className="active-jobs-banner__list">
          {jobs.slice(0, 3).map((job) => (
            <li key={job.meetingId}>
              <button
                type="button"
                className="active-jobs-banner__item"
                onClick={() => onOpenMeeting(job.meetingId)}
              >
                <span>{job.meetingTitle?.trim() || 'Cuộc họp đang xử lý'}</span>
                <span className="active-jobs-banner__status">{formatJobStatus(job.status)}</span>
              </button>
            </li>
          ))}
        </ul>
      </div>
      <button
        type="button"
        className="active-jobs-banner__dismiss"
        aria-label="Ẩn banner"
        onClick={() => setDismissed(true)}
      >
        ×
      </button>
    </div>
  )
}
