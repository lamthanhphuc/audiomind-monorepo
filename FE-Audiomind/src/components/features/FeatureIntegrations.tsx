import type { RealtimeLanguage } from '../../hooks/useRealtimeMeetingStream'
import type { Meeting } from '../../types'
import type { RecordingSource, RealtimeMeetCaptureContext } from '../../constants/recordingSource'
import { GoogleIntegrationSection } from './GoogleIntegrationScene'
import TeamsIntegrationPanel from './TeamsIntegrationPanel'
import ZoomIntegrationPanel from './ZoomIntegrationPanel'
import './google-integration.css'

type FeatureIntegrationsProps = {
  meetings: Meeting[]
  callbackNotice?: string | null
  oauthEnabled?: boolean
  realtimeEnabled?: boolean
  uploadLanguage: RealtimeLanguage
  zoomCallbackNotice?: string | null
  zoomCallbackNoticeTone?: 'success' | 'error' | 'info'
  teamsCallbackNotice?: string | null
  teamsCallbackNoticeTone?: 'success' | 'error' | 'info'
  integrationsBusy?: boolean
  oauthRefreshTick?: number
  onNavigateRealtimeMeetCapture?: (source: RecordingSource, context?: RealtimeMeetCaptureContext) => void
  onMeetingImported?: (
    meetingId: number,
    meta: { duplicate: boolean; reused: boolean; processingStarted: boolean },
  ) => void
}

export default function FeatureIntegrations({
  meetings,
  callbackNotice,
  oauthEnabled,
  realtimeEnabled,
  uploadLanguage,
  zoomCallbackNotice,
  zoomCallbackNoticeTone = 'info',
  teamsCallbackNotice,
  teamsCallbackNoticeTone = 'info',
  integrationsBusy = false,
  oauthRefreshTick = 0,
  onNavigateRealtimeMeetCapture,
  onMeetingImported,
}: FeatureIntegrationsProps) {
  return (
    <div className="dashboard-page feature-integrations-page bg-gray-light" data-testid="feature-integrations">
      <GoogleIntegrationSection
        meetings={meetings}
        callbackNotice={callbackNotice}
        oauthEnabled={oauthEnabled}
        realtimeEnabled={realtimeEnabled}
        oauthRefreshTick={oauthRefreshTick}
        onNavigateRealtimeMeetCapture={onNavigateRealtimeMeetCapture}
      />

      <section className="integration-import-section integration-import-section--standalone" data-testid="integrations-zoom-section">
        <div>
          <h2 className="integration-import-section__title">Zoom Cloud</h2>
          <p className="integration-import-section__hint">
            Kết nối Zoom để import cloud recording hoặc chọn file export thủ công.
          </p>
        </div>
        <ZoomIntegrationPanel
          busy={integrationsBusy}
          uploadLanguage={uploadLanguage}
          callbackNotice={zoomCallbackNotice}
          callbackNoticeTone={zoomCallbackNoticeTone}
          oauthRefreshTick={oauthRefreshTick}
          onImported={onMeetingImported}
        />
      </section>

      <section className="integration-import-section integration-import-section--standalone" data-testid="integrations-teams-section">
        <div>
          <h2 className="integration-import-section__title">Microsoft Teams</h2>
          <p className="integration-import-section__hint">
            Kết nối Teams để import cloud recording hoặc chọn file export thủ công.
          </p>
        </div>
        <TeamsIntegrationPanel
          busy={integrationsBusy}
          uploadLanguage={uploadLanguage}
          callbackNotice={teamsCallbackNotice}
          callbackNoticeTone={teamsCallbackNoticeTone}
          oauthRefreshTick={oauthRefreshTick}
          onImported={onMeetingImported}
        />
      </section>
    </div>
  )
}
