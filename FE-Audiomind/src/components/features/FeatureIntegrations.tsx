import type { Meeting } from '../../types'
import type { RecordingSource, RealtimeMeetCaptureContext } from '../../constants/recordingSource'
import { GoogleIntegrationSection } from './GoogleIntegrationScene'
import './google-integration.css'

type FeatureIntegrationsProps = {
  meetings: Meeting[]
  callbackNotice?: string | null
  oauthEnabled?: boolean
  realtimeEnabled?: boolean
  oauthRefreshTick?: number
  onNavigateRealtimeMeetCapture?: (source: RecordingSource, context?: RealtimeMeetCaptureContext) => void
}

export default function FeatureIntegrations({
  meetings,
  callbackNotice,
  oauthEnabled,
  realtimeEnabled,
  oauthRefreshTick = 0,
  onNavigateRealtimeMeetCapture,
}: FeatureIntegrationsProps) {
  return (
    <div className="dashboard-page feature-integrations-page" data-testid="feature-integrations">
      <GoogleIntegrationSection
        meetings={meetings}
        callbackNotice={callbackNotice}
        oauthEnabled={oauthEnabled}
        realtimeEnabled={realtimeEnabled}
        oauthRefreshTick={oauthRefreshTick}
        onNavigateRealtimeMeetCapture={onNavigateRealtimeMeetCapture}
      />
    </div>
  )
}
