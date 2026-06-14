# Phase 7T-Search-A - Transcript Evidence Search

Status: SPEC-ONLY

Branch: `docs/7t-qa-f6-start-resume-preroll-mic-sensitivity-spec`

Date: 2026-06-11

This document is a spec and implementation plan only. It does not implement production code.

External docs verification completed against official PostgreSQL docs:

- PostgreSQL full text search overview: https://www.postgresql.org/docs/current/textsearch.html
- PostgreSQL full text search introduction: https://www.postgresql.org/docs/current/textsearch-intro.html
- PostgreSQL preferred text search indexes: https://www.postgresql.org/docs/current/textsearch-indexes.html

Key external findings:

- PostgreSQL full-text search is based on `tsvector`, `tsquery`, and the `@@` match operator.
- `to_tsvector`, `plainto_tsquery`, and `phraseto_tsquery` normalize text/query input.
- GIN indexes are the preferred text-search index type when regular DB-backed search becomes necessary.
- Indexes are not mandatory for correctness, so an app-level MVP can avoid a migration first.

## 1. Problem Statement

Users need to search a saved meeting transcript by keyword/phrase and see the exact surrounding evidence. Export-A also needs a reusable evidence object so action plan rows can cite transcript context without calling Gemini again.

Risks to solve:

- Search must use the same transcript source users see in meeting detail.
- Search must not leak transcript text across meetings or users.
- Search must work before introducing DB migrations, vectors, or embeddings.
- Search logs must not contain full queries when sensitive or any transcript text.

## 2. Current Implementation Audit

Files and symbols inspected:

| Area | File/symbol | Finding |
| ---- | ----------- | ------- |
| Transcript model | `demoRecordAUDIOMID/ai-service/app/models.py::Transcript` | Durable transcript rows store `meeting_id`, `speaker`, `start_time`, `end_time`, `text`, plus canonical sidecar metadata: `raw_transcript_hash`, `canonical_transcript_rows`, `canonical_transcript_version`, `canonical_transcript_hash`, `canonical_generated_at`, `canonical_stats`. |
| Realtime fragments | `models.py::TranscriptFragment`, `TranscriptCheckpoint` | Realtime persistence uses fragment rows with `meeting_id`, `seq`, `speaker`, time range, text, normalized text, final flag, confidence, and dedupe key. |
| AI transcript route | `demoRecordAUDIOMID/ai-service/app/main.py::get_transcript` | Loads visible realtime fragments first, falls back to `transcripts` rows, resolves canonical sidecar when valid, and returns `TranscriptResponse` with `transcriptMode=canonical` or `raw`, canonical metadata, and optional `rawTranscripts`. This route does not enforce user ownership by itself. |
| Canonical sidecar | `main.py::_resolve_canonical_sidecar` | Uses raw transcript hash validation and returns canonical rows only when version/hash and rows are present. Falls back to raw rows otherwise. |
| Processing transcript endpoint | `ProcessingController.transcript`, `transcriptByJob` | Exposes `GET /processing/{meetingId}/transcript` and `GET /processing/transcript/{jobId}` after `requirePrincipal()`. Both currently call `processingService.getTranscript`. |
| Processing transcript service | `ProcessingService.getTranscript` | Calls `assertMeetingAccess`, reads job state, fetches persisted transcript payload from ai-service, chooses readable transcript source, stabilizes speaker display, and returns transcript data. |
| Source selection | `ProcessingService.selectReadableTranscriptSource` | Prefers ai-service canonical persisted transcript when available, then processing job-state raw rows, then ai-service persisted transcript, then empty. |
| Response shape | `ProcessingService.buildTranscriptResponse` | Returns `meeting_id`, `status`, `transcripts`, `transcriptMode`, speaker stabilization metadata, canonical metadata, and raw transcript rows when canonical mode is active. |
| Auth boundary | `ProcessingController.requirePrincipal`, `ProcessingService.fetchAccessibleMeeting`, `assertMeetingAccess` | Processing-service requires an authenticated principal and validates meeting access by calling meeting-service with the caller Authorization header. Missing auth returns 401; forbidden/not found propagate as 403/404. |
| Meeting service | `MeetingController.getMeetings`, `MeetingServiceClient.getMeetingById` | Meeting listing/get-by-id are owner-scoped. Processing-service delegates to `GET /meetings/{id}` for authorization. |
| Frontend API | `FE-Audiomind/src/services/api.ts::getTranscript` | Fetches `${API_BASE}/processing/transcript/${meetingId}` and unwraps optional `data`. Note: this uses the legacy-by-job-shaped path even though the controller also has `/processing/{meetingId}/transcript`. |
| Frontend UI | `MeetingHistoryScene.tsx` | Loads meeting detail, transcript, and saved analysis together. Renders transcript via `TranscriptDisplay` and analysis via `AnalysisPanel`. Existing history list search is for meeting names/files, not transcript evidence. |
| Transcript FE utils | `normalizePersistedTranscriptSegments`, `mergeTranscriptSegments` | Normalize persisted transcript rows and merge/upsert segments for display. Search result display should reuse the same segment identity/timing conventions where possible. |
| Tests | `test_stt_stream_route.py`, `ProcessingServiceTest`, `ProcessingControllerReportTest`, FE `api.test.ts` | Existing tests cover transcript retrieval from fragment persistence, empty transcript 404, canonical sidecar returns, raw fallback, transcript export modes, report export, and auth/ownership around processing-service paths. |

## 3. Chosen Direction

Options considered:

| Option | Summary | Benefits | Risks |
| ------ | ------- | -------- | ----- |
| App-level normalized substring search | Load the owner-scoped readable transcript payload through processing-service, normalize text/query in memory, rank segment matches, return context windows. | No DB migration, reuses current auth/source selection, fast to test, matches preferred MVP. | Not ideal for very large transcripts or global search; ranking is simple. |
| PostgreSQL full-text search | Add `tsvector`/GIN-backed search on transcript rows. | Scales better and supports richer text search. | Requires migration/design around canonical sidecar JSON, user scope, and language config; overkill for MVP. |
| Vector/semantic search | Embed segments and semantic-search evidence. | Best conceptual recall. | Explicit non-goal for MVP; adds cost, storage, privacy, and provider complexity. |

Recommended MVP: app-level transcript evidence search in processing-service, no DB migration first, with an interface that can later move to PostgreSQL full-text search.

Rationale:

- Processing-service already owns the safe meeting access boundary.
- Processing-service already chooses the user-visible readable transcript source.
- Export-A can reuse the same service object without calling Gemini.
- No migrations are needed for the MVP.
- Search must be case-insensitive and Vietnamese diacritic-insensitive in MVP.
- PostgreSQL full-text search remains future work only; do not add DB migrations for Search-A MVP.

## 4. API Path Decision

Canonical Search-A endpoint:

```http
GET /processing/{meetingId}/transcript/search?q=&limit=&context=
```

Product decisions:

- This is the only new canonical Search-A API path.
- Existing transcript paths stay for compatibility:
  - `GET /processing/{meetingId}/transcript`
  - `GET /processing/transcript/{jobId}`
- FE can keep the existing transcript load path for now.
- New FE transcript-search helper should call `GET /processing/{meetingId}/transcript/search`.
- Do not expose ai-service transcript/search routes directly to FE.

## 5. API Proposal

Recommended endpoint:

```http
GET /processing/{meetingId}/transcript/search?q={query}&limit=20&context=1
```

Why this path:

- It follows the canonical existing `/processing/{meetingId}/transcript` family.
- It can call `requirePrincipal()` and `ProcessingService.assertMeetingAccess(...)`.
- It avoids exposing ai-service transcript routes directly to the FE.

Response:

```json
{
  "meetingId": 123,
  "query": "api deadline",
  "normalizedQuery": "api deadline",
  "transcriptMode": "canonical",
  "canonicalTranscriptHash": "optional",
  "canonicalTranscriptVersion": "optional",
  "matches": [
    {
      "evidenceId": "meeting-123-segment-4-api-deadline",
      "segmentId": "meeting-123-start-12.300-speaker_1",
      "index": 4,
      "speaker": "Speaker 1",
      "startTime": 12.3,
      "endTime": 18.7,
      "text": "Short matching segment text",
      "textTruncated": false,
      "contextBefore": [
        {
          "segmentId": "meeting-123-start-8.100-speaker_2",
          "speaker": "Speaker 2",
          "startTime": 8.1,
          "endTime": 11.9,
          "text": "Previous segment",
          "textTruncated": false
        }
      ],
      "contextAfter": [],
      "score": 12.5,
      "rank": 1,
      "matchType": "phrase|token"
    }
  ]
}
```

Validation:

- `q` is required after trim.
- Minimum normalized query length is 2 characters after case/diacritic normalization.
- Empty or too-short query returns 400 with a repo-compatible validation error such as `INVALID_SEARCH_QUERY`.
- `limit` default is 20.
- Valid `limit` range is 1..50.
- Missing `limit` uses default 20.
- Non-numeric, non-integer, zero, or negative `limit` returns 400.
- `limit` greater than 50 is clamped to 50.
- `context` default is 1.
- Valid `context` range is 0..3.
- Missing `context` uses default 1.
- Non-numeric, non-integer, or negative `context` returns 400.
- `context=0` is valid and returns no contextBefore/contextAfter rows.
- `context` greater than 3 is clamped to 3.
- Return 404 only when the meeting/transcript does not exist according to existing repo conventions.

Response caps:

- Max `limit`: 50.
- Max `context`: 3.
- Max match `text` length: 800 characters.
- Max context row `text` length: 400 characters.
- These caps are for response size safety only and must not reduce search accuracy.
- If a match or context text field is truncated, include `textTruncated=true` on that DTO. If no truncation occurred, include `textTruncated=false` for deterministic FE rendering.
- Search response should include `transcriptMode`, `canonicalTranscriptHash` when available, and `canonicalTranscriptVersion` when available.
- Do not expose deep raw sidecar metadata in Search-A MVP.

## 6. Internal Service/Helper Contract

Search-A should have an internal processing-service helper that Export-A can call directly instead of making HTTP calls back into processing-service.

Recommended helper shape:

```java
TranscriptSearchResult searchTranscriptEvidence(
        Long meetingId,
        TranscriptPayload transcriptPayload,
        String query,
        int limit,
        int context
)
```

or, if meeting access and payload loading are part of the helper:

```java
TranscriptSearchResult searchTranscriptEvidenceForMeeting(
        Long meetingId,
        String query,
        int limit,
        int context,
        String traceId,
        String authorization
)
```

Rules:

- The public API path must enforce `requirePrincipal()` and meeting access before search.
- Export-A should prefer a lower-level helper that accepts already-authorized meeting data and an already-loaded transcript payload.
- Export-A must not call the Search-A HTTP endpoint from inside processing-service.
- The helper must return the same evidence DTO shape as the public endpoint so FE and Export-A share one contract.
- The helper must search the same readable transcript source used by meeting detail: canonical rows first, then raw/readable fallback.

## 7. Search Behavior

Normalization:

- Case-insensitive.
- Collapse whitespace.
- Strip punctuation at token edges.
- Use Java `Normalizer` or equivalent to remove Vietnamese diacritics for matching in MVP.
- Keep the original text in response.

Matching:

- Phrase match: normalized segment text contains normalized query.
- Token match: all query tokens appear in the normalized segment text.
- Optional partial token match only for tokens length >= 4.
- Do not implement quoted phrase syntax in MVP.
- Treat quotes as normal punctuation/separators.
- Plain phrase match and token match are enough for MVP.

Ranking:

- Phrase match outranks token match.
- More query-token hits score higher.
- Earlier exact match position scores slightly higher.
- Shorter segment with same hit quality scores slightly higher.
- Preserve stable ordering by segment index for ties.

Context:

- `contextBefore` and `contextAfter` are segment windows from the same transcript payload only.
- Do not cross meeting boundaries.
- Beginning/end of transcript should return shorter context arrays without error.

Transcript mode:

- Search the same readable rows returned by processing-service for meeting detail.
- If canonical mode is available, search canonical rows and include canonical metadata.
- If canonical mode is absent, search raw/readable fallback rows and return `transcriptMode=raw`.
- Include only `transcriptMode`, `canonicalTranscriptHash`, and `canonicalTranscriptVersion` as transcript metadata in the search response.
- Do not expose deep raw sidecar metadata in Search-A MVP.

Security:

- Call `requirePrincipal()` at controller level.
- Call `assertMeetingAccess()` before loading/searching transcript.
- Do not call ai-service directly from FE.
- Do not return raw transcript rows from another mode unless explicitly included as context in the selected payload.

## 8. Implementation Slices

### Search-A-1 - Backend service + DTO + tests

- Add a processing-service transcript search service/helper that accepts a `TranscriptPayload` or normalized transcript rows.
- Add DTOs/records for `TranscriptSearchResponse`, `TranscriptEvidenceMatch`, and `TranscriptEvidenceContext`.
- Add `textTruncated` or equivalent per-field truncation metadata to match/context DTOs.
- Implement normalization as case-insensitive and Vietnamese diacritic-insensitive.
- Add unit tests for phrase match, token match, ranking, context windows, diacritic-insensitive matching, empty query, special chars, quotes-as-punctuation, repeated keyword, no result, long transcript, and response text truncation metadata.

### Search-A-2 - API endpoint + auth/scope tests

- Add `GET /processing/{meetingId}/transcript/search`.
- Reuse `requirePrincipal()` and `ProcessingService.assertMeetingAccess(...)`.
- Reuse existing transcript source selection behavior.
- Add controller/service tests for missing auth, forbidden meeting, not found meeting, empty transcript, no cross-meeting leakage, and no cross-user leakage.

### Search-A-3 - FE search box/evidence results if needed

- Add a lightweight transcript-search box near the Transcript header in `MeetingHistoryScene`.
- Add a FE API helper such as `searchMeetingTranscriptEvidence(meetingId, query, options)`.
- Display evidence results with speaker, time range, and short context. Keep the existing transcript viewer intact.
- Do not redesign the history UI in this phase.

### Search-A-4 - Export integration hooks

- Expose a backend service method usable by Export-A to resolve action item `evidenceKeywords` into evidence matches.
- Export-A should call the service/helper, not HTTP, when in the same processing-service process.
- If no evidence is found, Export-A should produce a clear fallback note rather than calling Gemini.

## 9. Test Plan

Backend unit tests:

- Exact phrase match.
- Uppercase/lowercase match.
- Vietnamese diacritic-insensitive match.
- Query with punctuation/special chars.
- No result returns empty `matches`.
- `limit=abc`, `limit=0`, and `limit=-1` return 400.
- `limit=999` succeeds but uses effective limit 50.
- `context=abc` and `context=-1` return 400.
- `context=0` succeeds and returns no context rows.
- `context=999` succeeds but uses effective context 3.
- Context at beginning/end of transcript.
- Repeated keyword ranks deterministically.
- Multiple matches respect `limit`.
- Canonical transcript mode is searched when available.
- Raw fallback is searched when canonical is absent.
- Long transcript remains bounded and deterministic.
- Response caps truncate match text at 800 chars and context text at 400 chars with `textTruncated=true`.
- Search response includes `transcriptMode`, `canonicalTranscriptHash`, and `canonicalTranscriptVersion` when available, without deep sidecar metadata.
- Quoted text is treated as punctuation/separators, not as special syntax.

Auth/scope tests:

- Missing principal returns 401.
- Forbidden meeting returns 403.
- Unknown meeting returns 404.
- User A cannot search User B meeting.
- Matches never include rows from another meeting.
- Search query for meeting A cannot return context rows from meeting B even if text is identical.
- Export-A helper reuse cannot bypass the authorization/payload source rules.

Frontend tests:

- API helper builds the expected path and query string.
- UI does not call search for empty/too-short query.
- Results render speaker/time/text/context.
- Search error does not clear loaded transcript/analysis detail.

Manual cases:

- Search Vietnamese word with and without diacritics.
- Search a phrase spanning only one segment.
- Search at first/last transcript segment.
- Search a meeting with canonical transcript metadata.
- Search with quoted terms and verify quotes do not enable special syntax.

## 10. Logging Plan

Log:

- `event=TRANSCRIPT_SEARCH_REQUEST`
- `traceId`, `requestId`, `meetingId`
- query length and query hash prefix only
- `limit`, `context`, `transcriptMode`
- transcript row count
- result count
- duration

Do not log:

- Raw query text, even in non-production.
- Full transcript text.
- Context snippets.
- Authorization header.
- API keys or env values.

## 11. Acceptance Criteria

- Authenticated user can search their own saved meeting transcript and receive ranked evidence snippets with context.
- Search uses the same canonical/raw transcript mode semantics as meeting detail.
- Search uses `GET /processing/{meetingId}/transcript/search` as the canonical public endpoint.
- Search is case-insensitive and Vietnamese diacritic-insensitive.
- Search response includes only `transcriptMode`, `canonicalTranscriptHash`, and `canonicalTranscriptVersion` as transcript metadata.
- Search enforces validation and caps deterministically: invalid numeric query params return 400, values above max are clamped, and response text caps include truncation metadata.
- Export-A can reuse Search-A via an internal helper without HTTP loopback.
- Empty/short query is rejected with a clear 400.
- No cross-user or cross-meeting leakage is possible.
- Search-A does not require a DB migration.
- Search-A does not use embeddings or vector search.
- Logs contain only safe metadata.
- F6 realtime behavior and F7 Gemini fallback behavior remain unchanged.

## 12. Non-goals

- No vector search or embeddings in MVP.
- No PostgreSQL full-text migration in MVP.
- No global search across all meetings.
- No quoted phrase syntax in MVP.
- No semantic summarization or Gemini call during search.
- No frontend redesign.
- No production implementation in this spec task.

## 13. Future Work, Not Blocking MVP

- When implementation cleanup happens later, should FE transcript detail calls eventually move from `/processing/transcript/{meetingId}` to `/processing/{meetingId}/transcript`, or should both remain indefinitely?
- Evaluate PostgreSQL full-text search only after app-level Search-A shows performance or ranking limits.
