import { useMemo, useState } from 'react'

import { normalizeAnalysisResponse, type AiAnalysis } from '../../types'

import { buildMindmapBranches, rootLabelFromAnalysis } from '../../utils/mindmapData'

import { formatDomainMode } from '../../utils/uiLabels'

import MindmapGraph from '../mindmap/MindmapGraph'
import MindmapFlow from '../mindmap/MindmapFlow'

import './mindmap-view.css'



export type MindmapViewProps = {

  analysis: AiAnalysis | null

  meetingId?: number | null

  meetingTitle?: string

  onRefresh?: () => void | Promise<void>

  busy?: boolean

  /** @deprecated use layout="embedded" */
  compact?: boolean

  layout?: 'default' | 'page' | 'embedded'

}



const downloadSvgAsPng = async (svg: SVGSVGElement, filename: string) => {

  const serializer = new XMLSerializer()

  const source = serializer.serializeToString(svg)

  const blob = new Blob([source], { type: 'image/svg+xml;charset=utf-8' })

  const url = URL.createObjectURL(blob)

  const image = new Image()

  await new Promise<void>((resolve, reject) => {

    image.onload = () => resolve()

    image.onerror = () => reject(new Error('Không export được mindmap PNG'))

    image.src = url

  })

  const canvas = document.createElement('canvas')

  canvas.width = svg.viewBox.baseVal.width || svg.clientWidth || 920

  canvas.height = svg.viewBox.baseVal.height || svg.clientHeight || 520

  const context = canvas.getContext('2d')

  if (!context) {

    URL.revokeObjectURL(url)

    throw new Error('Canvas không khả dụng')

  }

  context.fillStyle = '#0b1020'

  context.fillRect(0, 0, canvas.width, canvas.height)

  context.drawImage(image, 0, 0, canvas.width, canvas.height)

  URL.revokeObjectURL(url)

  const pngBlob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/png'))

  if (!pngBlob) {

    throw new Error('Không tạo được PNG')

  }

  const downloadUrl = URL.createObjectURL(pngBlob)

  const anchor = document.createElement('a')

  anchor.href = downloadUrl

  anchor.download = filename

  anchor.click()

  URL.revokeObjectURL(downloadUrl)

}



export default function MindmapView({

  analysis,

  meetingId,

  meetingTitle,

  onRefresh,

  busy,

  compact = false,

  layout,

}: MindmapViewProps) {

  const resolvedLayout = layout ?? (compact ? 'embedded' : 'default')
  const isEmbedded = resolvedLayout === 'embedded'
  const isPageLayout = resolvedLayout === 'page'

  const [exporting, setExporting] = useState(false)
  const [viewMode, setViewMode] = useState<'flow' | 'svg'>('flow')

  const normalizedAnalysis = useMemo(() => normalizeAnalysisResponse(analysis), [analysis])

  const rootLabel = useMemo(

    () => rootLabelFromAnalysis(normalizedAnalysis, meetingTitle),

    [meetingTitle, normalizedAnalysis],

  )

  const branches = useMemo(() => buildMindmapBranches(normalizedAnalysis), [normalizedAnalysis])



  const handleExportPng = async () => {

    const svg = document.querySelector('[data-testid="mindmap-graph"] svg') as SVGSVGElement | null

    if (!svg) {

      return

    }

    setExporting(true)

    try {

      await downloadSvgAsPng(svg, `meeting-${meetingId ?? 'mindmap'}-mindmap.png`)

    } finally {

      setExporting(false)

    }

  }



  return (

    <div className={`mindmap-view${isEmbedded ? ' mindmap-view--compact' : ''}${isPageLayout ? ' mindmap-view--page' : ''}`}>

      {!isEmbedded && !isPageLayout && (

        <header className="mindmap-view__header">

          <div>

            <h2>Sơ đồ mindmap cuộc họp</h2>

            <p>Trực quan hóa từ khóa, thuật ngữ, vấn đề và kế hoạch hành động.</p>

          </div>

          <div className="mindmap-view__actions">
            <button
              type="button"
              className="btn btn--secondary"
              onClick={() => setViewMode((mode) => (mode === 'flow' ? 'svg' : 'flow'))}
              data-testid="mindmap-view-toggle"
            >
              {viewMode === 'flow' ? 'Bản tĩnh' : 'Bản tương tác'}
            </button>
            <button

              type="button"

              className="btn btn--secondary"

              disabled={exporting || !analysis}

              onClick={() => void handleExportPng()}

              data-testid="mindmap-export-png"

            >

              {exporting ? 'Đang xuất…' : 'Xuất PNG'}

            </button>

            {onRefresh && (

              <button type="button" className="btn btn--secondary" disabled={busy || !meetingId} onClick={() => void onRefresh()}>

                Làm mới dữ liệu

              </button>

            )}

          </div>

        </header>

      )}

      {isPageLayout && (
        <div className="mindmap-view__toolbar">
          <div className="mindmap-view__status">
            <span className="feature-chip">Cuộc họp #{meetingId ?? '—'}</span>
            <span className="mindmap-status__dot" />
            <span>
              {analysis
                ? `Đã đồng bộ · lĩnh vực ${formatDomainMode(normalizedAnalysis.domainMode)}`
                : 'Chưa có dữ liệu phân tích'}
            </span>
          </div>
          <div className="mindmap-view__actions">
            <button
              type="button"
              className="btn btn--secondary"
              onClick={() => setViewMode((mode) => (mode === 'flow' ? 'svg' : 'flow'))}
              data-testid="mindmap-view-toggle"
            >
              {viewMode === 'flow' ? 'Bản tĩnh' : 'Bản tương tác'}
            </button>
            <button
              type="button"
              className="btn btn--secondary"
              disabled={exporting || !analysis}
              onClick={() => void handleExportPng()}
              data-testid="mindmap-export-png"
            >
              {exporting ? 'Đang xuất…' : 'Xuất PNG'}
            </button>
            {onRefresh && (
              <button type="button" className="btn btn--secondary" disabled={busy || !meetingId} onClick={() => void onRefresh()}>
                Làm mới dữ liệu
              </button>
            )}
          </div>
        </div>
      )}

      {!isEmbedded && !isPageLayout && (

        <div className="mindmap-view__status">

        <span className="feature-chip">Cuộc họp #{meetingId ?? '—'}</span>

        <span className="mindmap-status__dot" />

        <span>

          {analysis

            ? `Đã đồng bộ · lĩnh vực ${formatDomainMode(normalizedAnalysis.domainMode)}`

            : 'Chưa có dữ liệu phân tích'}

        </span>

      </div>

      )}

      <div className="mindmap-view__canvas-shell">
        {viewMode === 'flow' ? (
          <MindmapFlow rootLabel={rootLabel} branches={branches} />
        ) : (
          <MindmapGraph rootLabel={rootLabel} branches={branches} />
        )}
      </div>

      {isPageLayout && (
        <p className="mindmap-view__footer-hint">
          Kéo node để sắp xếp · dùng nút zoom góc trái · cuộn trang để xem thêm nội dung bên dưới
        </p>
      )}

    </div>

  )

}


