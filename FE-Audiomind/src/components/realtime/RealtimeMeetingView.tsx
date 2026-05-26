import { useState } from 'react';
import { useRealtimeMeetingStream } from '../../hooks/useRealtimeMeetingStream';
import { RealtimeTranscript } from '../transcript/RealtimeTranscript';
import { KeywordSidebar } from './KeywordSidebar';
import './RealtimeMeetingView.css';

interface RealtimeMeetingViewProps {
  meetingId: number;
  userId: number;
  token: string;
}

export const RealtimeMeetingView: React.FC<RealtimeMeetingViewProps> = ({
  meetingId,
  userId,
  token,
}) => {
  const {
    isConnected,
    status,
    transcripts,
    keywords,
    pause,
    resume,
    clearTranscripts,
  } = useRealtimeMeetingStream({
    meetingId,
    userId,
    token,
    autoReconnect: true,
  });

  const [isPaused, setIsPaused] = useState(false);
  const [selectedKeyword, setSelectedKeyword] = useState<string | null>(null);

  const handlePauseToggle = (paused: boolean) => {
    setIsPaused(paused);
    if (paused) {
      pause();
    } else {
      resume();
    }
  };

  // Get keywords to highlight in transcript
  const highlightedKeywords = selectedKeyword
    ? [selectedKeyword]
    : keywords.map((kw) => kw.keyword);

  return (
    <div className="realtime-meeting-view">
      <div className="meeting-header">
        <div className="header-info">
          <h2>Meeting {meetingId}</h2>
          <div
            className={`connection-status ${
              isConnected ? 'connected' : 'disconnected'
            }`}
          >
            <span className="status-dot"></span>
            <span className="status-text">
              {isConnected ? 'Connected' : status.state}
            </span>
          </div>
        </div>
        <div className="header-actions">
          <button
            className="clear-button"
            onClick={clearTranscripts}
            title="Clear transcript"
          >
            Clear
          </button>
        </div>
      </div>

      {status.message && !isConnected && (
        <div className="status-message">{status.message}</div>
      )}

      <div className="meeting-content">
        <div className="transcript-section">
          <RealtimeTranscript
            segments={transcripts}
            isPaused={isPaused}
            onPauseToggle={handlePauseToggle}
            highlightKeywords={highlightedKeywords}
            maxHeight="600px"
          />
        </div>

        <div className="sidebar-section">
          <KeywordSidebar
            keywords={keywords}
            onKeywordClick={(kw) =>
              setSelectedKeyword(
                selectedKeyword === kw.keyword ? null : kw.keyword
              )
            }
            maxHeight="600px"
          />
        </div>
      </div>

      <div className="meeting-footer">
        <div className="stats">
          <span>{transcripts.length} segments</span>
          <span className="separator">•</span>
          <span>{keywords.length} keywords detected</span>
        </div>
      </div>
    </div>
  );
};
