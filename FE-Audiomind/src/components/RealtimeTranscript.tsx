import React, { useEffect, useRef } from 'react';
import type { TranscriptSegment } from '../hooks/useRealtimeMeetingStream';
import './RealtimeTranscript.css';

interface RealtimeTranscriptProps {
  segments: TranscriptSegment[];
  isPaused?: boolean;
  onPauseToggle?: (paused: boolean) => void;
  highlightKeywords?: string[];
  maxHeight?: string;
}

export const RealtimeTranscript: React.FC<RealtimeTranscriptProps> = ({
  segments,
  isPaused = false,
  onPauseToggle,
  highlightKeywords = [],
  maxHeight = '400px',
}) => {
  const scrollContainerRef = useRef<HTMLDivElement>(null);
  const lastSegmentRef = useRef<HTMLDivElement>(null);

  // Auto-scroll to latest message when new segments arrive
  useEffect(() => {
    if (!isPaused && lastSegmentRef.current) {
      lastSegmentRef.current.scrollIntoView({ behavior: 'smooth', block: 'end' });
    }
  }, [segments, isPaused]);

  const highlightText = (text: string, keywords: string[]) => {
    if (keywords.length === 0) return text;

    let highlighted = text;
    keywords.forEach((keyword) => {
      const regex = new RegExp(`(${keyword})`, 'gi');
      highlighted = highlighted.replace(regex, '<span class="keyword-highlight">$1</span>');
    });
    return highlighted;
  };

  if (segments.length === 0) {
    return (
      <div className="realtime-transcript-empty">
        <p>Waiting for transcript...</p>
      </div>
    );
  }

  return (
    <div className="realtime-transcript">
      <div className="transcript-controls">
        {onPauseToggle && (
          <button
            className="pause-button"
            onClick={() => onPauseToggle(!isPaused)}
            title={isPaused ? 'Resume' : 'Pause'}
          >
            {isPaused ? '▶' : '⏸'}
          </button>
        )}
        <span className="segment-count">{segments.length} segments</span>
      </div>

      <div
        className="transcript-container"
        style={{ maxHeight }}
        ref={scrollContainerRef}
      >
        {segments.map((segment, index) => (
          <div
            key={segment.id}
            className="transcript-segment"
            ref={index === segments.length - 1 ? lastSegmentRef : undefined}
          >
            <div className="segment-speaker">{segment.speaker}</div>
            <div className="segment-text">
              <div
                dangerouslySetInnerHTML={{
                  __html: highlightText(segment.text, highlightKeywords),
                }}
              />
              {segment.confidence && segment.confidence < 0.9 && (
                <span className="confidence-badge">
                  {Math.round(segment.confidence * 100)}%
                </span>
              )}
            </div>
            <div className="segment-timestamp">
              {formatTimestamp(segment.timestamp)}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
};

function formatTimestamp(ms: number): string {
  const totalSeconds = Math.floor(ms / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${seconds.toString().padStart(2, '0')}`;
}
