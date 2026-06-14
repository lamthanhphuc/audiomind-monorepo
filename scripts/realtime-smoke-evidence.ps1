#Requires -Version 5.1
<#
.SYNOPSIS
  Collects metadata-only G1 realtime STT smoke evidence for a meeting.

.DESCRIPTION
  Gathers filtered docker logs, event tallies, DB checkpoint/fragment metadata,
  and a PASS/FAIL checklist. Does not print raw transcript text or secrets.

.EXAMPLE
  .\scripts\realtime-smoke-evidence.ps1 -MeetingId 123 -Since "30m"
#>
[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [int]$MeetingId,

    [string]$Since = '30m',

    [string]$OutputDir = '.\smoke-evidence',

    [switch]$Help
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$WatchlistMarkers = @(
    'REALTIME_SESSION_STARTED',
    'AUDIO_CHUNK_SEND_ENQUEUED',
    'AUDIO_CHUNK_SEND_FLUSHED',
    'STREAM_STOP_AFTER_FLUSH',
    'STREAM_STOP_FAILED',
    'STREAM_STOP_BUFFER_DRAIN_TIMEOUT',
    'REALTIME_AUDIO_ENQUEUED',
    'REALTIME_AUDIO_DEQUEUED',
    'REALTIME_QUEUE_DRAIN_COMPLETE',
    'REALTIME_WORKER_CLEANUP',
    'REALTIME_FINALIZE_SKIPPED_DUPLICATE',
    'REALTIME_CHUNK_DROPPED_QUEUE_FULL',
    'REALTIME_CHUNK_DROPPED_STALE_SESSION',
    'REALTIME_STOP_FINALIZE_AFTER_DRAIN',
    'DG_REQUEST_PARAMS',
    'STT_FINALIZATION_REPLAY',
    'STT_FINALIZATION',
    'AI_SERVICE_CALL_FAILED',
    'Conflict'
)

$ContainerServices = @(
    'processing-api',
    'ai-api',
    'meeting-api'
)

function Show-Usage {
    Write-Output @'
Audiomind G1 realtime STT smoke evidence collector (metadata only).

Usage:
  .\scripts\realtime-smoke-evidence.ps1 -MeetingId <MEETING_ID> [-Since "30m"] [-OutputDir ".\smoke-evidence"]

Examples:
  .\scripts\realtime-smoke-evidence.ps1 -MeetingId 123 -Since "30m"
  .\scripts\realtime-smoke-evidence.ps1 -MeetingId 0 -Since "1m"

Outputs (under OutputDir/meeting-<id>-<timestamp>/):
  filtered-metadata.log   Redacted service logs for the meeting window
  event-tally.txt         Watchlist marker counts
  db-evidence.txt         transcript_fragments/checkpoints metadata (no text column)
  checklist.txt           PASS/FAIL/WARN summary for G1 happy path

Privacy:
  Does not SELECT transcript_fragments.text or print raw transcript/provider bodies.
'@
}

function Resolve-RepoRoot {
    param([string]$StartPath = $PSScriptRoot)

    $current = [System.IO.Path]::GetFullPath($StartPath)
    while ($current) {
        $envCandidate = Join-Path $current 'infra\.env'
        if (Test-Path -LiteralPath $envCandidate) {
            return $current
        }
        $parent = Split-Path -Parent $current
        if ([string]::IsNullOrWhiteSpace($parent) -or $parent -eq $current) {
            break
        }
        $current = $parent
    }

    return [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
}

function Get-EnvMap {
    param([string]$Path)

    $map = @{}
    if (-not (Test-Path -LiteralPath $Path)) {
        return $map
    }

    Get-Content -LiteralPath $Path | ForEach-Object {
        $line = $_.Trim()
        if (-not $line -or $line.StartsWith('#')) {
            return
        }
        $eq = $line.IndexOf('=')
        if ($eq -lt 1) {
            return
        }
        $key = $line.Substring(0, $eq).Trim()
        $value = $line.Substring($eq + 1).Trim()
        if ($value.StartsWith('"') -and $value.EndsWith('"')) {
            $value = $value.Substring(1, $value.Length - 2)
        }
        $map[$key] = $value
    }
    return $map
}

function Test-Truthy {
    param([string]$Value)
    switch ($Value.Trim().ToLowerInvariant()) {
        { $_ -in @('1', 'true', 'yes', 'on') } { return $true }
        default { return $false }
    }
}

function Redact-LogLine {
    param([string]$Line)

    $redacted = [string]$Line
    $redacted = $redacted -replace '(?i)(authorization:\s*bearer\s+)[A-Za-z0-9._~+/\-]+=*', '$1<redacted>'
    $redacted = $redacted -replace '(?i)(bearer\s+)[A-Za-z0-9._~+/\-]+=*', '$1<redacted>'
    $redacted = $redacted -replace '(?i)((api[_-]?key|token|secret|password|authorization|access[_-]?key|refresh[_-]?token)\s*[:=]\s*)("[^"]*"|''[^'']*''|[^,\s;]+)', '$1<redacted>'
    $redacted = $redacted -replace '(?i)((GEMINI|DEEPGRAM|OPENAI|JWT|REDIS|POSTGRES)[A-Z0-9_]*(KEY|TOKEN|SECRET|PASSWORD)\s*=\s*).+', '$1<redacted>'
    $redacted = $redacted -replace '(?i)(transcript=)([^,\s;]+)', '$1<redacted>'
    $redacted = $redacted -replace '(?i)(text=)([^,\s;]+)', '$1<redacted>'
    return $redacted
}

function Test-MeetingLogLine {
    param(
        [string]$Line,
        [int]$TargetMeetingId
    )

    if ($TargetMeetingId -le 0) {
        return $true
    }

    return $Line -match "(meetingId=$TargetMeetingId\b|meeting_id=$TargetMeetingId\b|meetingId[:\s]+`"$TargetMeetingId`"|meetingId[:\s]+$TargetMeetingId\b)"
}

function Get-ServiceLogs {
    param(
        [string[]]$ComposeArgs,
        [string]$Service,
        [string]$SinceWindow
    )

    try {
        $raw = & docker compose @ComposeArgs logs --since $SinceWindow --no-color $Service 2>&1
        if ($null -eq $raw) {
            return @()
        }
        if ($raw -is [string]) {
            return @($raw)
        }
        return @($raw | ForEach-Object { [string]$_ })
    } catch {
        return @("DOCKER_LOGS_UNAVAILABLE service=$Service reason=$($_.Exception.Message)")
    }
}

function Add-ChecklistItem {
    param(
        [System.Collections.Generic.List[object]]$Items,
        [string]$Check,
        [string]$Severity,
        [string]$Detail
    )
    $Items.Add([pscustomobject]@{
            check    = $Check
            severity = $Severity
            detail   = $Detail
        })
}

if ($Help) {
    Show-Usage
    exit 0
}

if ($MeetingId -lt 0) {
    Write-Error 'MeetingId must be a non-negative integer.'
}

$RepoRoot = Resolve-RepoRoot
$EnvFile = Join-Path $RepoRoot 'infra\.env'
$ComposeDev = Join-Path $RepoRoot 'infra\docker-compose.dev.yml'
$ComposeMvp = Join-Path $RepoRoot 'infra\docker-compose.mvp.yml'
$Timestamp = Get-Date -Format 'yyyyMMdd-HHmmss'
$RunDir = Join-Path ([System.IO.Path]::GetFullPath($OutputDir)) ("meeting-$MeetingId-$Timestamp")
New-Item -ItemType Directory -Path $RunDir -Force | Out-Null

$envMap = Get-EnvMap -Path $EnvFile
$asyncQueueEnabled = Test-Truthy ($(if ($envMap.ContainsKey('REALTIME_ASYNC_AUDIO_QUEUE_ENABLED')) { $envMap['REALTIME_ASYNC_AUDIO_QUEUE_ENABLED'] } else { 'true' }))

$composeArgs = @(
    '--env-file', $EnvFile,
    '-f', $ComposeDev,
    '-f', $ComposeMvp
)

$allLines = New-Object System.Collections.Generic.List[string]
foreach ($service in $ContainerServices) {
    $serviceLines = Get-ServiceLogs -ComposeArgs $composeArgs -Service $service -SinceWindow $Since
    foreach ($line in $serviceLines) {
        if (-not (Test-MeetingLogLine -Line $line -TargetMeetingId $MeetingId)) {
            continue
        }
        $allLines.Add("[${service}] $(Redact-LogLine $line)")
    }
}

$filteredLogPath = Join-Path $RunDir 'filtered-metadata.log'
if ($allLines.Count -eq 0) {
    @(
        "meetingId=$MeetingId",
        "since=$Since",
        'status=no_matching_container_logs',
        'note=FE-only markers (AUDIO_CHUNK_SEND_*, STREAM_STOP_AFTER_FLUSH) appear in browser console, not docker logs'
    ) | Out-File -FilePath $filteredLogPath -Encoding utf8
} else {
    $allLines | Out-File -FilePath $filteredLogPath -Encoding utf8
}

$logText = if ($allLines.Count -gt 0) { ($allLines -join "`n") } else { '' }

$tally = [ordered]@{}
foreach ($marker in $WatchlistMarkers) {
    if ([string]::IsNullOrWhiteSpace($logText)) {
        $tally[$marker] = 0
        continue
    }
    if ($marker -eq 'STT_FINALIZATION') {
        $matches = [regex]::Matches($logText, 'STT_FINALIZATION(?!_REPLAY)')
        $tally[$marker] = $matches.Count
        continue
    }
    $pattern = [regex]::Escape($marker)
    $tally[$marker] = ([regex]::Matches($logText, $pattern)).Count
}

$tallyPath = Join-Path $RunDir 'event-tally.txt'
$tallyLines = @(
    "meetingId=$MeetingId",
    "since=$Since",
    "asyncQueueEnabled=$asyncQueueEnabled",
    '---'
)
foreach ($entry in $tally.GetEnumerator()) {
    $tallyLines += ("{0}={1}" -f $entry.Key, $entry.Value)
}
$tallyLines | Out-File -FilePath $tallyPath -Encoding utf8

$dbEvidencePath = Join-Path $RunDir 'db-evidence.txt'
$fragmentCount = $null
$finalFragmentCount = $null
$maxEnd = $null
$checkpointFound = $false
$lastAckSeq = $null
$lastPersistedSeq = $null
$lastFinalizedSeq = $null
$checkpointUpdatedAt = $null
$dbQueryStatus = 'skipped'

if ($MeetingId -gt 0) {
    $sql = @"
SELECT 'fragments' AS row_type,
       meeting_id,
       COUNT(*) AS fragment_count,
       MAX(end_time) AS max_end,
       COUNT(*) FILTER (WHERE is_final = true) AS final_fragment_count
FROM transcript_fragments
WHERE meeting_id = $MeetingId
GROUP BY meeting_id;

SELECT 'checkpoint' AS row_type,
       meeting_id,
       last_ack_seq,
       last_persisted_seq,
       last_finalized_seq,
       updated_at
FROM transcript_checkpoints
WHERE meeting_id = $MeetingId;
"@

    try {
        $dbRaw = $sql | & docker compose @composeArgs exec -T db sh -lc 'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -At -F "|"' 2>&1
        $dbLines = @($dbRaw | ForEach-Object { Redact-LogLine ([string]$_) })
        $dbLines | Out-File -FilePath $dbEvidencePath -Encoding utf8
        $dbQueryStatus = 'ok'

        foreach ($row in $dbLines) {
            if ($row -match '^\s*$' -or $row -match '^(ERROR|WARNING|NOTICE)') {
                continue
            }
            $parts = $row.Split('|')
            if ($parts.Length -lt 2) {
                continue
            }
            switch ($parts[0]) {
                'fragments' {
                    if ($parts.Length -ge 5) {
                        $fragmentCount = [int]$parts[2]
                        $maxEnd = $parts[3]
                        $finalFragmentCount = [int]$parts[4]
                    }
                }
                'checkpoint' {
                    if ($parts.Length -ge 6) {
                        $checkpointFound = $true
                        $lastAckSeq = [int]$parts[2]
                        $lastPersistedSeq = [int]$parts[3]
                        $lastFinalizedSeq = [int]$parts[4]
                        $checkpointUpdatedAt = $parts[5]
                    }
                }
            }
        }
    } catch {
        $dbQueryStatus = 'failed'
        @(
            "meetingId=$MeetingId",
            "status=db_query_failed",
            "reason=$($_.Exception.Message)"
        ) | Out-File -FilePath $dbEvidencePath -Encoding utf8
    }
} else {
    $dbQueryStatus = 'skipped_meeting_zero'
    @(
        'meetingId=0',
        'status=skipped_db_query',
        'reason=MeetingId 0 is a dry-run; no DB evidence collected'
    ) | Out-File -FilePath $dbEvidencePath -Encoding utf8
}

$checklist = [System.Collections.Generic.List[object]]::new()
$hasFail = $false
$hasWarn = $false

function Mark-Fail {
    param([string]$Check, [string]$Detail)
    $script:hasFail = $true
    Add-ChecklistItem $checklist $Check 'fail' $Detail
}

function Mark-Warn {
    param([string]$Check, [string]$Detail)
    $script:hasWarn = $true
    Add-ChecklistItem $checklist $Check 'warn' $Detail
}

function Mark-Pass {
    param([string]$Check, [string]$Detail)
    Add-ChecklistItem $checklist $Check 'pass' $Detail
}

if ($tally['STREAM_STOP_FAILED'] -gt 0) {
    Mark-Fail 'stream_stop_failed' "STREAM_STOP_FAILED count=$($tally['STREAM_STOP_FAILED'])"
} else {
    Mark-Pass 'stream_stop_failed' 'no STREAM_STOP_FAILED in container logs'
}

if ($tally['REALTIME_CHUNK_DROPPED_QUEUE_FULL'] -gt 0) {
    Mark-Fail 'queue_full' "REALTIME_CHUNK_DROPPED_QUEUE_FULL count=$($tally['REALTIME_CHUNK_DROPPED_QUEUE_FULL'])"
} else {
    Mark-Pass 'queue_full' 'no queue-full marker'
}

if ($tally['AI_SERVICE_CALL_FAILED'] -gt 0 -and $logText -match 'Conflict') {
    Mark-Fail 'ai_conflict' 'AI_SERVICE_CALL_FAILED with Conflict detected'
} else {
    Mark-Pass 'ai_conflict' 'no AI_SERVICE_CALL_FAILED+Conflict pair'
}

if ($tally['REALTIME_STOP_FINALIZE_AFTER_DRAIN'] -gt 1) {
    Mark-Fail 'duplicate_finalize' "REALTIME_STOP_FINALIZE_AFTER_DRAIN count=$($tally['REALTIME_STOP_FINALIZE_AFTER_DRAIN'])"
} elseif ($tally['REALTIME_FINALIZE_SKIPPED_DUPLICATE'] -gt 1) {
    Mark-Fail 'duplicate_finalize' "REALTIME_FINALIZE_SKIPPED_DUPLICATE count=$($tally['REALTIME_FINALIZE_SKIPPED_DUPLICATE'])"
} elseif ($tally['REALTIME_FINALIZE_SKIPPED_DUPLICATE'] -eq 1) {
    Mark-Warn 'duplicate_finalize' 'single REALTIME_FINALIZE_SKIPPED_DUPLICATE treated as idempotent close path'
    Mark-Pass 'duplicate_finalize' 'no repeated finalize storm'
} else {
    Mark-Pass 'duplicate_finalize' 'no duplicate finalize markers'
}

if ($tally['STT_FINALIZATION_REPLAY'] -ge 3) {
    Mark-Fail 'stt_replay_loop' "STT_FINALIZATION_REPLAY count=$($tally['STT_FINALIZATION_REPLAY'])"
} elseif ($tally['STT_FINALIZATION_REPLAY'] -gt 0) {
    Mark-Warn 'stt_replay_loop' "STT_FINALIZATION_REPLAY count=$($tally['STT_FINALIZATION_REPLAY'])"
} else {
    Mark-Pass 'stt_replay_loop' 'no replay loop'
}

if ($MeetingId -gt 0) {
    if ($dbQueryStatus -ne 'ok') {
        Mark-Warn 'db_evidence' "db query status=$dbQueryStatus (checkpoint/fragment checks deferred)"
    } elseif (-not $checkpointFound) {
        Mark-Fail 'checkpoint_missing' 'transcript_checkpoints row not found'
    } else {
        Mark-Pass 'checkpoint_missing' 'checkpoint row present'
        if ($null -ne $lastFinalizedSeq -and $lastFinalizedSeq -le 0) {
            Mark-Fail 'checkpoint_finalized_seq' "last_finalized_seq=$lastFinalizedSeq"
        } else {
            Mark-Pass 'checkpoint_finalized_seq' "last_finalized_seq=$lastFinalizedSeq"
        }
    }

    if ($dbQueryStatus -eq 'ok') {
        if ($null -eq $fragmentCount -or $fragmentCount -eq 0) {
            Mark-Fail 'fragment_count' 'fragment_count=0 (expected speech fragments for G1 happy path)'
        } else {
            Mark-Pass 'fragment_count' "fragment_count=$fragmentCount final_fragment_count=$finalFragmentCount max_end=$maxEnd"
        }
    }
}

if ($tally['STREAM_STOP_AFTER_FLUSH'] -eq 0) {
    Mark-Warn 'fe_stream_stop_flush' 'STREAM_STOP_AFTER_FLUSH not in container logs (check browser console for FE stop path)'
} else {
    Mark-Pass 'fe_stream_stop_flush' "STREAM_STOP_AFTER_FLUSH count=$($tally['STREAM_STOP_AFTER_FLUSH'])"
}

if ($tally['REALTIME_STOP_FINALIZE_AFTER_DRAIN'] -eq 0) {
    if ($MeetingId -gt 0) {
        Mark-Fail 'processing_finalize' 'missing REALTIME_STOP_FINALIZE_AFTER_DRAIN in processing logs'
    } else {
        Mark-Warn 'processing_finalize' 'missing REALTIME_STOP_FINALIZE_AFTER_DRAIN (MeetingId 0 dry-run)'
    }
} else {
    Mark-Pass 'processing_finalize' "REALTIME_STOP_FINALIZE_AFTER_DRAIN count=$($tally['REALTIME_STOP_FINALIZE_AFTER_DRAIN'])"
}

if ($asyncQueueEnabled) {
    if ($tally['REALTIME_AUDIO_ENQUEUED'] -eq 0) {
        if ($MeetingId -gt 0) {
            Mark-Fail 'async_queue_marker' 'REALTIME_ASYNC_AUDIO_QUEUE_ENABLED=true but REALTIME_AUDIO_ENQUEUED=0'
        } else {
            Mark-Warn 'async_queue_marker' 'async queue marker absent in dry-run window'
        }
    } else {
        Mark-Pass 'async_queue_marker' "REALTIME_AUDIO_ENQUEUED count=$($tally['REALTIME_AUDIO_ENQUEUED'])"
    }
} else {
    Mark-Warn 'async_queue_marker' 'REALTIME_ASYNC_AUDIO_QUEUE_ENABLED=false (legacy sync path)'
}

if ($tally['STREAM_STOP_BUFFER_DRAIN_TIMEOUT'] -gt 0) {
    Mark-Warn 'fe_buffer_drain_timeout' "STREAM_STOP_BUFFER_DRAIN_TIMEOUT count=$($tally['STREAM_STOP_BUFFER_DRAIN_TIMEOUT'])"
}

if ($tally['DG_REQUEST_PARAMS'] -gt 0) {
    if ($logText -match 'sampleRateIncluded=false') {
        Mark-Pass 'dg_request_params' 'DG_REQUEST_PARAMS includes sampleRateIncluded=false'
    } else {
        Mark-Warn 'dg_request_params' 'DG_REQUEST_PARAMS present but sampleRateIncluded=false not confirmed in filtered logs'
    }
} else {
    Mark-Warn 'dg_request_params' 'DG_REQUEST_PARAMS not found in filtered logs'
}

$overall = if ($hasFail) { 'FAIL' } elseif ($hasWarn) { 'WARN' } else { 'PASS' }
$checklistPath = Join-Path $RunDir 'checklist.txt'
$checklistLines = @(
    "gate=G1_realtime_stt_core",
    "meetingId=$MeetingId",
    "since=$Since",
    "overall=$overall",
    '---'
)
foreach ($item in $checklist) {
    $checklistLines += ("[{0}] {1} :: {2}" -f $item.severity.ToUpperInvariant(), $item.check, $item.detail)
}
$checklistLines += '---'
$checklistLines += "outputDir=$RunDir"
$checklistLines += 'files=filtered-metadata.log,event-tally.txt,db-evidence.txt,checklist.txt'
$checklistLines | Out-File -FilePath $checklistPath -Encoding utf8

Write-Output "REALTIME_SMOKE_EVIDENCE gate=G1 meetingId=$MeetingId overall=$overall outputDir=$RunDir"
Write-Output "REALTIME_SMOKE_EVIDENCE files=filtered-metadata.log,event-tally.txt,db-evidence.txt,checklist.txt"
foreach ($item in $checklist) {
    Write-Output ("REALTIME_SMOKE_EVIDENCE check={0} severity={1} detail={2}" -f $item.check, $item.severity, $item.detail)
}

if ($hasFail) {
    exit 1
}
exit 0
