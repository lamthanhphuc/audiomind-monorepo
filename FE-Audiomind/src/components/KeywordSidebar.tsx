import React, { useState } from 'react';
import type { KeywordHit } from '../hooks/useRealtimeMeetingStream';
import './KeywordSidebar.css';

interface KeywordSidebarProps {
  keywords: KeywordHit[];
  onKeywordClick?: (keyword: KeywordHit) => void;
  maxHeight?: string;
}

export const KeywordSidebar: React.FC<KeywordSidebarProps> = ({
  keywords,
  onKeywordClick,
  maxHeight = '400px',
}) => {
  const [expandedId, setExpandedId] = useState<string | null>(null);

  // Deduplicate keywords by term, keeping the one with highest confidence
  const uniqueKeywords = Array.from(
    keywords.reduce((map, kw) => {
      const existing = map.get(kw.keyword);
      if (!existing || kw.confidence > existing.confidence) {
        map.set(kw.keyword, kw);
      }
      return map;
    }, new Map<string, KeywordHit>()).values()
  ).sort((a, b) => b.confidence - a.confidence);

  if (uniqueKeywords.length === 0) {
    return (
      <div className="keyword-sidebar-empty">
        <p>No keywords detected yet</p>
      </div>
    );
  }

  return (
    <div className="keyword-sidebar">
      <div className="sidebar-header">
        <h3>Keywords</h3>
        <span className="keyword-count">{uniqueKeywords.length}</span>
      </div>

      <div className="keywords-container" style={{ maxHeight }}>
        {uniqueKeywords.map((kw) => (
          <div
            key={kw.id}
            className="keyword-item"
            onClick={() => {
              setExpandedId(expandedId === kw.id ? null : kw.id);
              onKeywordClick?.(kw);
            }}
          >
            <div className="keyword-header">
              <div className="keyword-term-badge">
                <span className="keyword-term">{kw.keyword}</span>
                <span className="confidence-score">
                  {Math.round(kw.confidence * 100)}%
                </span>
              </div>
              {kw.definition && (
                <span className="expand-icon">
                  {expandedId === kw.id ? '▼' : '▶'}
                </span>
              )}
            </div>

            {kw.definition && expandedId === kw.id && (
              <div className="keyword-definition">
                {kw.definition}
              </div>
            )}
          </div>
        ))}
      </div>
    </div>
  );
};
