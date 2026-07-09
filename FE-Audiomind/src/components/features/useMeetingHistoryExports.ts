import { useCallback, useState } from 'react'

import {
  ApiError,
  downloadMeetingActionPlan,
  downloadMeetingReport,
  downloadMeetingTranscript,
  getMeetingActionPlan,
} from '../../services/api'
import type { Meeting } from '../../types'
import { formatGroupedActionPlanForCopy } from '../../types'
import type {
  ActionPlanState,
  TranscriptExportFormat,
  TranscriptExportMode,
  TranscriptExportRequest,
} from './MeetingHistoryPanels'

type AnalysisState = 'idle' | 'processing' | 'completed' | 'failed' | 'failed_retryable' | 'missing'
type TranscriptState = 'loading' | 'ready' | 'empty' | 'error'

type UseMeetingHistoryExportsOptions = {
  selectedMeetingSummary: Meeting | null | undefined
  transcriptState: TranscriptState
  analysisState: AnalysisState
}

const ACTION_PLAN_REQUIRED_MESSAGE = 'Cần có phân tích cuộc họp trước khi xuất action plan.'

const getActionPlanErrorMessage = (error: unknown): string => {
  if (error instanceof ApiError && error.status === 409) {
    return ACTION_PLAN_REQUIRED_MESSAGE
  }
  if (error instanceof Error) {
    return error.message
  }
  return 'Không thể xuất action plan'
}

const saveBlobToFile = (blob: Blob, filename: string) => {
  const objectUrl = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = objectUrl
  anchor.download = filename
  document.body.appendChild(anchor)
  anchor.click()
  anchor.remove()
  URL.revokeObjectURL(objectUrl)
}

const copyTextToClipboard = async (text: string): Promise<void> => {
  if (navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(text)
    return
  }

  const textarea = document.createElement('textarea')
  textarea.value = text
  textarea.setAttribute('readonly', 'true')
  textarea.style.position = 'fixed'
  textarea.style.top = '-9999px'
  document.body.appendChild(textarea)
  textarea.select()
  document.execCommand('copy')
  textarea.remove()
}

export function useMeetingHistoryExports({
  selectedMeetingSummary,
  transcriptState,
  analysisState,
}: UseMeetingHistoryExportsOptions) {
  const [exportBusy, setExportBusy] = useState(false)
  const [exportError, setExportError] = useState<string | null>(null)
  const [transcriptExportBusy, setTranscriptExportBusy] = useState<TranscriptExportRequest | null>(null)
  const [transcriptExportError, setTranscriptExportError] = useState<string | null>(null)
  const [transcriptExportMenuOpen, setTranscriptExportMenuOpen] = useState(false)
  const [exportActionsMenuOpen, setExportActionsMenuOpen] = useState(false)
  const [actionPlanState, setActionPlanState] = useState<ActionPlanState>({
    preview: null,
    loading: false,
    exporting: false,
    error: null,
    success: null,
  })

  const handleExportDocx = async () => {
    if (!selectedMeetingSummary || transcriptState !== 'ready') {
      return
    }
    if (analysisState === 'processing' || analysisState === 'failed_retryable') {
      setExportError('Phân tích chưa hoàn tất. Vui lòng đợi hệ thống thử lại hoặc chạy phân tích lại trước khi xuất report.')
      return
    }

    setExportBusy(true)
    setExportError(null)
    try {
      const { blob, filename } = await downloadMeetingReport(selectedMeetingSummary.id, 'docx')
      saveBlobToFile(blob, filename)
    } catch (error) {
      setExportError(error instanceof Error ? error.message : 'Không thể xuất report')
    } finally {
      setExportBusy(false)
    }
  }

  const handleExportPdf = async () => {
    if (!selectedMeetingSummary || transcriptState !== 'ready') {
      return
    }
    if (analysisState === 'processing' || analysisState === 'failed_retryable') {
      setExportError('Phân tích chưa hoàn tất. Vui lòng đợi hệ thống thử lại hoặc chạy phân tích lại trước khi xuất report.')
      return
    }

    setExportBusy(true)
    setExportError(null)
    try {
      const { blob, filename } = await downloadMeetingReport(selectedMeetingSummary.id, 'pdf')
      saveBlobToFile(blob, filename)
    } catch (error) {
      setExportError(error instanceof Error ? error.message : 'Không thể xuất PDF')
    } finally {
      setExportBusy(false)
    }
  }

  const handleTranscriptExport = async (mode: TranscriptExportMode, format: TranscriptExportFormat) => {
    if (!selectedMeetingSummary || transcriptState !== 'ready') {
      return
    }
    setTranscriptExportBusy({ mode, format })
    setTranscriptExportError(null)
    setTranscriptExportMenuOpen(false)
    try {
      const { blob, filename } = await downloadMeetingTranscript(selectedMeetingSummary.id, format, mode)
      saveBlobToFile(blob, filename)
    } catch (error) {
      setTranscriptExportError(error instanceof Error ? error.message : 'Không thể xuất transcript')
    } finally {
      setTranscriptExportBusy(null)
    }
  }

  const handleActionPlanExport = async (format: 'docx' | 'pdf' = 'docx') => {
    const meetingId = selectedMeetingSummary?.id
    if (!meetingId) {
      return
    }
    setActionPlanState((current) => ({
      ...current,
      loading: true,
      exporting: false,
      error: null,
      success: null,
    }))
    try {
      const preview = await getMeetingActionPlan(meetingId)
      setActionPlanState({
        preview,
        loading: false,
        exporting: true,
        error: null,
        success: null,
      })
      const { blob, filename } = await downloadMeetingActionPlan(meetingId, format)
      saveBlobToFile(blob, filename)
      setActionPlanState({
        preview,
        loading: false,
        exporting: false,
        error: null,
        success: `Action plan (${format.toUpperCase()}) đã sẵn sàng để tải xuống.`,
      })
    } catch (error) {
      setActionPlanState((current) => ({
        ...current,
        loading: false,
        exporting: false,
        error: getActionPlanErrorMessage(error),
        success: null,
      }))
    }
  }

  const handleActionPlanCopy = async () => {
    if (!actionPlanState.preview) {
      return
    }
    const copyText = formatGroupedActionPlanForCopy(
      actionPlanState.preview.groupedActionPlan ?? undefined,
      actionPlanState.preview.actionItems,
    )
    try {
      await copyTextToClipboard(copyText)
      setActionPlanState((current) => ({
        ...current,
        error: null,
        success: 'Action plan đã được copy.',
      }))
    } catch (error) {
      setActionPlanState((current) => ({
        ...current,
        error: error instanceof Error ? error.message : 'Không thể copy action plan',
        success: null,
      }))
    }
  }

  const resetExportState = useCallback(() => {
    setTranscriptExportMenuOpen(false)
    setExportActionsMenuOpen(false)
    setTranscriptExportBusy(null)
    setTranscriptExportError(null)
    setExportError(null)
    setActionPlanState({
      preview: null,
      loading: false,
      exporting: false,
      error: null,
      success: null,
    })
  }, [])

  return {
    exportBusy,
    exportError,
    transcriptExportBusy,
    transcriptExportError,
    transcriptExportMenuOpen,
    setTranscriptExportMenuOpen,
    exportActionsMenuOpen,
    setExportActionsMenuOpen,
    actionPlanState,
    handleExportDocx,
    handleExportPdf,
    handleTranscriptExport,
    handleActionPlanExport,
    handleActionPlanCopy,
    resetExportState,
  }
}
