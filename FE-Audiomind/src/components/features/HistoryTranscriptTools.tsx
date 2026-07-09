import type { AiAnalysis } from '../../types'
import type { TranscriptSegment } from '../../hooks/useRealtimeMeetingStream'
import type { SpeakerProfile } from '../../services/knowledgeLayer'
import { answerMeetingQuestion, type MeetingChatCitation } from '../../utils/meetingChatbot'
import AiAssistant from '../dashboard/AiAssistant'
import GlossaryNotesPanel from './GlossaryNotesPanel'
import MeetingTaskTracker from './MeetingTaskTracker'
import SpeakerNamingPanel from './SpeakerNamingPanel'

type Props = {
  meetingId: number | null
  analysis: AiAnalysis | null
  transcriptSegments: TranscriptSegment[]
  onTermSelect: (term: string) => void
  onProfilesSaved: (profiles: SpeakerProfile[]) => void
  onCitationClick: (citation: MeetingChatCitation) => void
}

export default function HistoryTranscriptTools({
  meetingId,
  analysis,
  transcriptSegments,
  onTermSelect,
  onProfilesSaved,
  onCitationClick,
}: Props) {
  return (
    <>
      <GlossaryNotesPanel
        meetingId={meetingId}
        analysis={analysis}
        onTermSelect={onTermSelect}
      />
      <SpeakerNamingPanel
        meetingId={meetingId}
        transcriptSegments={transcriptSegments}
        onProfilesSaved={onProfilesSaved}
      />
      <MeetingTaskTracker
        meetingId={meetingId}
        groupedActionPlan={analysis?.groupedActionPlan}
      />
      {meetingId != null && (
        <AiAssistant
          meetingId={meetingId}
          onCitationClick={onCitationClick}
          onAsk={async (message) => {
            const result = await answerMeetingQuestion(meetingId, message, analysis)
            if (result.provider === 'gemini') {
              return { text: result.answer, citations: result.sourceSegments }
            }

            const suffix = result.provider === 'evidence'
              ? '\n\n(Lưu ý: trả lời từ transcript đã lưu.)'
              : '\n\n(Lưu ý: Gemini tạm không khả dụng - trả lời từ dữ liệu phân tích cục bộ.)'

            return { text: `${result.answer}${suffix}`, citations: result.sourceSegments }
          }}
        />
      )}
    </>
  )
}
