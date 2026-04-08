param(
    [switch]$Nuke,
    [switch]$AutoNukeOnLowReclaim,
    [switch]$Simulate,
    [ValidateRange(30, 1200)]
    [int]$DockerReadyTimeoutSeconds = 300,
    [ValidateRange(1, 30)]
    [int]$DockerPollIntervalSeconds = 3,
    [ValidateRange(1, 5)]
    [int]$MaxCompactionPasses = 2,
    [Parameter(ValueFromRemainingArguments = $true)]
    [string[]]$ExtraArgs
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

if ($ExtraArgs -contains '--nuke') {
    $Nuke = $true
}
if ($ExtraArgs -contains '--autonukeonlowreclaim') {
    $AutoNukeOnLowReclaim = $true
}

$scriptRoot = $PSScriptRoot
$workspaceRoot = Split-Path -Parent $scriptRoot
$logDir = Join-Path $workspaceRoot 'logs'
$logPath = Join-Path $logDir 'docker-clean-deep.log'

function Initialize-LogFile {
    try {
        if (-not (Test-Path -LiteralPath $logDir)) {
            New-Item -ItemType Directory -Path $logDir -Force | Out-Null
        }

        if (-not (Test-Path -LiteralPath $logPath)) {
            New-Item -ItemType File -Path $logPath -Force | Out-Null
        }

        return $logPath
    }
    catch {
        $fallback = Join-Path $env:TEMP 'docker-clean-deep.log'
        if (-not (Test-Path -LiteralPath $fallback)) {
            New-Item -ItemType File -Path $fallback -Force | Out-Null
        }
        return $fallback
    }
}

$global:ActiveLog = Initialize-LogFile

function Write-Log {
    param(
        [string]$Message,
        [ValidateSet('INFO', 'WARN', 'ERROR')]
        [string]$Level = 'INFO'
    )

    $line = '{0} [{1}] {2}' -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'), $Level, $Message
    Write-Host $line
    try {
        Add-Content -LiteralPath $global:ActiveLog -Value $line
    }
    catch {
        Write-Warning ("Log write failed: {0}" -f $_.Exception.Message)
    }
}

function Test-IsWindows {
    return $env:OS -eq 'Windows_NT'
}

function Test-IsAdministrator {
    if (-not (Test-IsWindows)) {
        return $false
    }

    $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
    $principal = [Security.Principal.WindowsPrincipal]::new($identity)
    return $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
}

function Restart-ElevatedSelf {
    $argList = @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', ('"{0}"' -f $PSCommandPath))

    if ($Nuke) { $argList += '-Nuke' }
    if ($AutoNukeOnLowReclaim) { $argList += '-AutoNukeOnLowReclaim' }
    if ($Simulate) { $argList += '-Simulate' }
    $argList += @('-DockerReadyTimeoutSeconds', $DockerReadyTimeoutSeconds)
    $argList += @('-DockerPollIntervalSeconds', $DockerPollIntervalSeconds)
    $argList += @('-MaxCompactionPasses', $MaxCompactionPasses)

    foreach ($arg in $ExtraArgs) {
        $argList += ('"{0}"' -f $arg)
    }

    Write-Log 'Administrator rights are required. Relaunching elevated.' 'WARN'
    try {
        Start-Process -FilePath 'powershell.exe' -Verb RunAs -ArgumentList ($argList -join ' ') -ErrorAction Stop | Out-Null
    }
    catch {
        throw 'Unable to relaunch as Administrator. Cleanup is blocked until elevated execution is allowed.'
    }
    exit 0
}

function Invoke-Step {
    param(
        [string]$Name,
        [scriptblock]$Action,
        [switch]$Required
    )

    try {
        Write-Log ('=> START: {0}' -f $Name)
        & $Action
        Write-Log ('<= OK: {0}' -f $Name)
        return $true
    }
    catch {
        Write-Log ('<= FAIL: {0} | {1}' -f $Name, $_.Exception.Message) 'ERROR'
        if ($Required) {
            throw
        }
        return $false
    }
}

function Get-DockerDesktopPath {
    $candidates = @(
        (Join-Path $env:ProgramFiles 'Docker\Docker\Docker Desktop.exe'),
        (Join-Path $env:ProgramFiles 'Docker\Docker\Docker.exe')
    )

    foreach ($candidate in $candidates) {
        if (Test-Path -LiteralPath $candidate) {
            return $candidate
        }
    }

    return $null
}

function Get-DockerCliPath {
    $candidate = Join-Path $env:ProgramFiles 'Docker\Docker\resources\bin\docker.exe'
    if (Test-Path -LiteralPath $candidate) {
        return $candidate
    }

    if (Get-Command docker -ErrorAction SilentlyContinue) {
        return 'docker'
    }

    return $null
}

function Test-DockerReady {
    if ($Simulate) {
        return $true
    }

    try {
        $probe = (& docker info --format '{{.ServerVersion}}|{{.OSType}}|{{.Driver}}' 2>&1 | Out-String).Trim()
        if ($LASTEXITCODE -ne 0) {
            return $false
        }

        if ($probe -notmatch '^[^|]+\|[^|]+\|[^|]+$') {
            return $false
        }

        return $true
    }
    catch {
        return $false
    }
}

function Wait-DockerReady {
    param([int]$TimeoutSeconds)

    $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
    while ((Get-Date) -lt $deadline) {
        if (Test-DockerReady) {
            return $true
        }
        Start-Sleep -Seconds $DockerPollIntervalSeconds
    }

    return $false
}

function Stop-DockerDesktop {
    if ($Simulate) {
        Write-Log 'SIMULATE: Docker Desktop shutdown skipped.'
        return
    }

    $dockerCli = Join-Path $env:ProgramFiles 'Docker\Docker\DockerCli.exe'
    if (Test-Path -LiteralPath $dockerCli) {
        try {
            & $dockerCli -Shutdown 2>$null | Out-Null
        }
        catch {
            Write-Log ('DockerCli -Shutdown failed: {0}' -f $_.Exception.Message) 'WARN'
        }
    }

    $names = @('Docker Desktop', 'Docker Desktop Backend', 'com.docker.backend')
    foreach ($name in $names) {
        try {
            Get-Process -Name $name -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
        }
        catch {
            Write-Log ('Stop process failed for {0}: {1}' -f $name, $_.Exception.Message) 'WARN'
        }
    }
}

function Start-DockerDesktop {
    if ($Simulate) {
        Write-Log 'SIMULATE: Docker Desktop start skipped.'
        return $true
    }

    $desktopPath = Get-DockerDesktopPath
    if (-not $desktopPath) {
        Write-Log 'Docker Desktop executable not found.' 'ERROR'
        return $false
    }

    try {
        Start-Process -FilePath $desktopPath -WindowStyle Hidden | Out-Null
        return $true
    }
    catch {
        Write-Log ('Failed to start Docker Desktop: {0}' -f $_.Exception.Message) 'ERROR'
        return $false
    }
}

function Ensure-DockerReady {
    if (Test-DockerReady) {
        Write-Log 'Docker daemon is already healthy.'
        return $true
    }

    [void](Start-DockerDesktop)
    if (Wait-DockerReady -TimeoutSeconds $DockerReadyTimeoutSeconds) {
        Write-Log 'Docker daemon became healthy.'
        return $true
    }

    Write-Log ('Docker daemon did not become healthy within {0}s.' -f $DockerReadyTimeoutSeconds) 'ERROR'
    return $false
}

function Invoke-Docker {
    param(
        [string[]]$DockerArgs,
        [switch]$AllowFailure
    )

    if ($Simulate) {
        Write-Log ('SIMULATE: docker {0}' -f ($DockerArgs -join ' '))
        return @('SIMULATED')
    }

    $output = & docker @DockerArgs 2>&1
    $code = $LASTEXITCODE
    if ($code -ne 0 -and -not $AllowFailure) {
        throw "docker $($DockerArgs -join ' ') failed with exit code $code. $($output -join ' ')"
    }

    if ($code -ne 0 -and $AllowFailure) {
        Write-Log ("Non-fatal docker failure for 'docker {0}': {1}" -f ($DockerArgs -join ' '), ($output -join ' ')) 'WARN'
    }

    return @($output)
}

function Get-DockerIds {
    param([string[]]$DockerArgs)

    $output = Invoke-Docker -DockerArgs $DockerArgs -AllowFailure
    $ids = @($output | Where-Object { -not [string]::IsNullOrWhiteSpace($_) } | ForEach-Object { $_.Trim() } | Select-Object -Unique)
    return $ids
}

function Show-DockerDf {
    param([string]$Label)

    Write-Log ("===== {0} docker system df =====" -f $Label)
    $df = Invoke-Docker -DockerArgs @('system', 'df') -AllowFailure
    foreach ($line in $df) {
        Write-Log ("{0} docker system df | {1}" -f $Label, $line)
    }

    Write-Log ("===== {0} docker system df -v =====" -f $Label)
    $dfv = Invoke-Docker -DockerArgs @('system', 'df', '-v') -AllowFailure
    foreach ($line in $dfv) {
        Write-Log ("{0} docker system df -v | {1}" -f $Label, $line)
    }
}

function Invoke-HardDockerClean {
    Invoke-Step -Name 'Stop all running containers' -Action {
        $containers = @(Get-DockerIds -DockerArgs @('ps', '-q'))
        if ($containers.Count -eq 0) {
            Write-Log 'No running containers found.'
            return
        }
        [void](Invoke-Docker -DockerArgs (@('stop') + $containers) -AllowFailure)
    }

    Invoke-Step -Name 'Remove all containers' -Action {
        $containers = @(Get-DockerIds -DockerArgs @('ps', '-aq'))
        if ($containers.Count -eq 0) {
            Write-Log 'No containers found.'
            return
        }
        [void](Invoke-Docker -DockerArgs (@('rm', '-f') + $containers) -AllowFailure)
    }

    Invoke-Step -Name 'Remove all images' -Action {
        $images = @(Get-DockerIds -DockerArgs @('images', '-aq'))
        if ($images.Count -eq 0) {
            Write-Log 'No images found.'
            return
        }
        [void](Invoke-Docker -DockerArgs (@('rmi', '-f') + $images) -AllowFailure)
    }

    Invoke-Step -Name 'Remove all volumes' -Action {
        $volumes = @(Get-DockerIds -DockerArgs @('volume', 'ls', '-q'))
        if ($volumes.Count -eq 0) {
            Write-Log 'No volumes found.'
            return
        }
        [void](Invoke-Docker -DockerArgs (@('volume', 'rm') + $volumes) -AllowFailure)
    }

    Invoke-Step -Name 'Remove all unused networks' -Action {
        [void](Invoke-Docker -DockerArgs @('network', 'prune', '-f') -AllowFailure)
    }

    Invoke-Step -Name 'Run docker system prune -a --volumes -f' -Action {
        [void](Invoke-Docker -DockerArgs @('system', 'prune', '-a', '--volumes', '-f') -AllowFailure)
    }

    Invoke-Step -Name 'Run docker builder prune -a -f' -Action {
        [void](Invoke-Docker -DockerArgs @('builder', 'prune', '-a', '-f') -AllowFailure)
    }
}

function Resolve-VhdxPaths {
    $candidates = @(
        (Join-Path $env:USERPROFILE 'AppData\Local\Docker\wsl\data\ext4.vhdx'),
        (Join-Path $env:USERPROFILE 'AppData\Local\Docker\wsl\disk\docker_data.vhdx')
    )

    $found = @()
    foreach ($path in $candidates) {
        if (Test-Path -LiteralPath $path) {
            $found += $path
        }
    }

    return $found
}

function Get-VhdxSizes {
    param([string[]]$Paths)

    $result = @{}
    foreach ($path in $Paths) {
        if (Test-Path -LiteralPath $path) {
            $result[$path] = (Get-Item -LiteralPath $path).Length
        }
        else {
            $result[$path] = 0
        }
    }
    return $result
}

function Invoke-WslShutdown {
    if ($Simulate) {
        Write-Log 'SIMULATE: wsl --shutdown skipped.'
        return
    }

    try {
        & wsl --shutdown 2>&1 | Out-Null
        if ($LASTEXITCODE -ne 0) {
            Write-Log ("wsl --shutdown returned exit code {0}" -f $LASTEXITCODE) 'WARN'
        }
        else {
            Write-Log 'wsl --shutdown completed.'
        }
    }
    catch {
        Write-Log ('wsl --shutdown failed: {0}' -f $_.Exception.Message) 'WARN'
    }
}

function Invoke-DiskpartCompact {
    param([string]$Path)

    if ($Simulate) {
        Write-Log ("SIMULATE: diskpart compact for {0}" -f $Path)
        return
    }

    $scriptFile = Join-Path $env:TEMP ('diskpart-compact-{0}.txt' -f ([Guid]::NewGuid().ToString('N')))
    @(
        "select vdisk file=`"$Path`"",
        'attach vdisk readonly',
        'compact vdisk',
        'detach vdisk',
        'exit'
    ) | Set-Content -LiteralPath $scriptFile -Encoding ASCII

    try {
        & diskpart.exe /s $scriptFile 2>&1 | Out-Null
        if ($LASTEXITCODE -ne 0) {
            throw "diskpart exited with code $LASTEXITCODE"
        }
    }
    finally {
        Remove-Item -LiteralPath $scriptFile -Force -ErrorAction SilentlyContinue
    }
}

function Compact-Vhdx {
    param([string]$Path)

    $optimizeCmd = Get-Command Optimize-VHD -ErrorAction SilentlyContinue
    $mountCmd = Get-Command Mount-VHD -ErrorAction SilentlyContinue
    $dismountCmd = Get-Command Dismount-VHD -ErrorAction SilentlyContinue
    $mounted = $false
    $optimized = $false

    if ($optimizeCmd) {
        try {
            if ($Simulate) {
                Write-Log ("SIMULATE: Optimize-VHD -Path '{0}' -Mode Full" -f $Path)
            }
            else {
                Optimize-VHD -Path $Path -Mode Full -ErrorAction Stop
            }
            Write-Log ("Optimize-VHD succeeded for {0}" -f $Path)
            $optimized = $true
        }
        catch {
            Write-Log ("Optimize-VHD failed for {0}: {1}" -f $Path, $_.Exception.Message) 'WARN'
            Write-Log 'Trying fallback sequence: Mount-VHD -> Optimize-VHD -Mode Full -> Dismount-VHD.' 'WARN'
        }
    }
    else {
        Write-Log 'Optimize-VHD is unavailable. Skipping to fallback compaction methods.' 'WARN'
    }

    if ($optimized) {
        return $true
    }

    try {
        if ($mountCmd -and $dismountCmd -and $optimizeCmd) {
            if ($Simulate) {
                Write-Log ("SIMULATE: Mount-VHD -Path '{0}' -ReadOnly" -f $Path)
                Write-Log ("SIMULATE: Optimize-VHD -Path '{0}' -Mode Full" -f $Path)
                Write-Log ("SIMULATE: Dismount-VHD -Path '{0}'" -f $Path)
            }
            else {
                Mount-VHD -Path $Path -ReadOnly -ErrorAction Stop | Out-Null
                $mounted = $true
                Optimize-VHD -Path $Path -Mode Full -ErrorAction Stop
            }

            Write-Log ("Fallback compaction via Mount-VHD/Optimize-VHD succeeded for {0}" -f $Path)
            return $true
        }

        Write-Log 'Mount-VHD/Dismount-VHD or Optimize-VHD are unavailable for mounted fallback; moving to diskpart compact.' 'WARN'
    }
    catch {
        Write-Log ("Mount-VHD/Optimize fallback failed for {0}: {1}" -f $Path, $_.Exception.Message) 'WARN'
    }
    finally {
        if ($mounted -and $dismountCmd) {
            try {
                if ($Simulate) {
                    Write-Log ("SIMULATE: Dismount-VHD -Path '{0}'" -f $Path)
                }
                else {
                    Dismount-VHD -Path $Path -ErrorAction Stop
                }
                Write-Log ("Dismount-VHD succeeded for {0}" -f $Path)
            }
            catch {
                Write-Log ("Dismount-VHD failed for {0}: {1}" -f $Path, $_.Exception.Message) 'WARN'
            }
        }
    }

    try {
        Invoke-DiskpartCompact -Path $Path
        Write-Log ("diskpart fallback compaction succeeded for {0}" -f $Path)
        return $true
    }
    catch {
        Write-Log ("diskpart fallback compaction failed for {0}: {1}" -f $Path, $_.Exception.Message) 'ERROR'
        return $false
    }
}

function Invoke-NukeVhdx {
    param([string[]]$Paths)

    Write-Log 'NUKE mode enabled: deleting Docker WSL2 VHDX files.' 'WARN'

    foreach ($path in $Paths) {
        Invoke-Step -Name ("Delete VHDX {0}" -f $path) -Action {
            if ($Simulate) {
                Write-Log ("SIMULATE: Remove-Item -LiteralPath '{0}' -Force" -f $path)
            }
            else {
                Remove-Item -LiteralPath $path -Force -ErrorAction Stop
            }
        } | Out-Null
    }
}

function Write-VhdxSummary {
    param(
        [hashtable]$Before,
        [hashtable]$After
    )

    $totalBefore = 0.0
    $totalAfter = 0.0

    foreach ($path in $Before.Keys) {
        $b = [double]$Before[$path]
        $a = [double]$After[$path]
        $delta = $b - $a
        $pct = 0.0
        if ($b -gt 0) {
            $pct = [Math]::Round(($delta / $b) * 100.0, 2)
        }

        $totalBefore += $b
        $totalAfter += $a

        Write-Log (
            'VHDX_SUMMARY|PATH={0}|BEFORE_BYTES={1}|AFTER_BYTES={2}|RECLAIMED_BYTES={3}|RECLAIMED_GB={4}|RECLAIMED_PCT={5}' -f $path, [Int64]$b, [Int64]$a, [Int64]$delta, [Math]::Round($delta / 1GB, 3), $pct
        )
    }

    $totalDelta = $totalBefore - $totalAfter
    $totalPct = 0.0
    if ($totalBefore -gt 0) {
        $totalPct = [Math]::Round(($totalDelta / $totalBefore) * 100.0, 2)
    }

    Write-Log (
        'TOTAL_SUMMARY|BEFORE_BYTES={0}|AFTER_BYTES={1}|RECLAIMED_BYTES={2}|RECLAIMED_GB={3}|RECLAIMED_PCT={4}' -f [Int64]$totalBefore, [Int64]$totalAfter, [Int64]$totalDelta, [Math]::Round($totalDelta / 1GB, 3), $totalPct
    )

    return [double]$totalDelta
}

Write-Log 'docker-clean-deep starting.'
Write-Log ("Flags: Nuke={0}, AutoNukeOnLowReclaim={1}, Simulate={2}" -f $Nuke, $AutoNukeOnLowReclaim, $Simulate)
Write-Log ("LogFile={0}" -f $global:ActiveLog)

if (-not (Test-IsWindows)) {
    throw 'This script is designed for Windows + Docker Desktop + WSL2.'
}

if (-not (Get-DockerCliPath)) {
    throw 'Docker CLI not found in PATH.'
}

if (-not (Test-IsAdministrator)) {
    Restart-ElevatedSelf
}

try {
    Import-Module Hyper-V -ErrorAction SilentlyContinue | Out-Null
}
catch {
    Write-Log ('Import-Module Hyper-V failed: {0}' -f $_.Exception.Message) 'WARN'
}

Invoke-Step -Name 'Initial Docker Desktop stop (safe pre-clean reset)' -Action {
    Stop-DockerDesktop
} | Out-Null

$dockerReady = Invoke-Step -Name 'Ensure Docker daemon ready for cleanup' -Action {
    if (-not (Ensure-DockerReady)) {
        throw 'Docker daemon is not reachable. Cleanup steps will be skipped and reclaim will continue.'
    }
}

if ($dockerReady) {
    Invoke-Step -Name 'Capture BEFORE docker disk usage' -Action {
        Show-DockerDf -Label 'BEFORE'
    } | Out-Null
}
else {
    Write-Log 'Skipping BEFORE docker system df because Docker is unavailable.' 'WARN'
}

$vhdxPaths = @(Resolve-VhdxPaths)
if ($vhdxPaths.Count -eq 0) {
    Write-Log 'No Docker VHDX found in expected locations. Continuing with Docker cleanup only.' 'WARN'
}
else {
    Write-Log ('Detected Docker VHDX files: {0}' -f ($vhdxPaths -join '; '))
}

$beforeSizes = @{}
if ($vhdxPaths.Count -gt 0) {
    $beforeSizes = Get-VhdxSizes -Paths $vhdxPaths
    foreach ($path in $beforeSizes.Keys) {
        $bytes = [double]$beforeSizes[$path]
        Write-Log ('VHDX_BEFORE|PATH={0}|BYTES={1}|GB={2}' -f $path, [Int64]$bytes, [Math]::Round($bytes / 1GB, 3))
    }
}

if ($dockerReady) {
    Invoke-Step -Name 'Hard clean Docker data' -Action {
        Invoke-HardDockerClean
    } | Out-Null
}
else {
    Write-Log 'Skipping hard Docker clean because Docker daemon is unavailable.' 'WARN'
}

Invoke-Step -Name 'Stop Docker Desktop before WSL reclaim' -Action {
    Stop-DockerDesktop
} | Out-Null

Invoke-Step -Name 'Shutdown WSL' -Action {
    Invoke-WslShutdown
} | Out-Null

if ($vhdxPaths.Count -gt 0) {
    if ($Nuke) {
        Invoke-NukeVhdx -Paths $vhdxPaths
    }
    else {
        $plateauReached = $false
        $targetPasses = [Math]::Min([Math]::Max($MaxCompactionPasses, 2), 2)
        for ($pass = 1; $pass -le $targetPasses; $pass++) {
            Write-Log ("Compaction pass {0} of {1}" -f $pass, $MaxCompactionPasses)
            $allCompactionsSucceeded = $true
            foreach ($path in $vhdxPaths) {
                $stepOk = Invoke-Step -Name ("Compact VHDX {0}" -f $path) -Action {
                    if (-not (Compact-Vhdx -Path $path)) {
                        throw 'Compaction method failed'
                    }
                }
                if (-not $stepOk) {
                    $allCompactionsSucceeded = $false
                }
            }

            $probeAfter = Get-VhdxSizes -Paths $vhdxPaths
            $deltaProbe = 0.0
            foreach ($path in $vhdxPaths) {
                $deltaProbe += ([double]$beforeSizes[$path] - [double]$probeAfter[$path])
            }

            if ($deltaProbe -gt 0) {
                Write-Log ('Compaction pass {0} reclaimed bytes: {1}' -f $pass, [Int64]$deltaProbe)
                break
            }

            if (-not $allCompactionsSucceeded) {
                Write-Log 'Compaction failed in this pass; reclaim may be limited.' 'WARN'
            }

            if ($pass -lt $targetPasses) {
                Write-Log 'No reclaim observed yet; running one extra compaction pass.' 'WARN'
            }
            else {
                Write-Log 'PLATEAU_REACHED' 'WARN'
                $plateauReached = $true
            }
        }

        if ($plateauReached) {
            Write-Log 'Compaction plateau reached after retry pass.' 'WARN'
        }
    }
}

Invoke-Step -Name 'Restart Docker Desktop after cleanup' -Action {
    if (-not (Start-DockerDesktop)) {
        throw 'Docker Desktop start failed.'
    }
} | Out-Null

Invoke-Step -Name 'Wait for docker info to become healthy after restart' -Action {
    if (-not (Wait-DockerReady -TimeoutSeconds $DockerReadyTimeoutSeconds)) {
        throw "docker info did not become healthy within $DockerReadyTimeoutSeconds seconds"
    }
} | Out-Null

if (Test-DockerReady) {
    Invoke-Step -Name 'Capture AFTER docker disk usage' -Action {
        Show-DockerDf -Label 'AFTER'
    } | Out-Null
}
else {
    Write-Log 'Skipping AFTER docker system df because Docker is unavailable after restart attempt.' 'WARN'
}

$afterSizes = @{}
if ($vhdxPaths.Count -gt 0) {
    $afterSizes = Get-VhdxSizes -Paths $vhdxPaths
    foreach ($path in $afterSizes.Keys) {
        $bytes = [double]$afterSizes[$path]
        Write-Log ('VHDX_AFTER|PATH={0}|BYTES={1}|GB={2}' -f $path, [Int64]$bytes, [Math]::Round($bytes / 1GB, 3))
    }

    $totalDelta = Write-VhdxSummary -Before $beforeSizes -After $afterSizes
    $totalBeforeBytes = 0.0
    foreach ($v in $beforeSizes.Values) {
        $totalBeforeBytes += [double]$v
    }
    $totalReclaimPct = 0.0
    if ($totalBeforeBytes -gt 0) {
        $totalReclaimPct = [Math]::Round(($totalDelta / $totalBeforeBytes) * 100.0, 4)
    }

    $realSuccess = $false
    if ($totalDelta -gt 0) {
        $realSuccess = $true
    }

    if ($totalReclaimPct -lt 1.0) {
        Write-Log 'WARNING: No real disk reclaim detected (<1%). Consider running with --nuke for full reset.' 'WARN'
        if ($AutoNukeOnLowReclaim -and -not $Nuke) {
            Write-Log 'AutoNukeOnLowReclaim is enabled. Triggering nuke fallback now.' 'WARN'
            Invoke-Step -Name 'Stop Docker Desktop before auto-nuke fallback' -Action { Stop-DockerDesktop } | Out-Null
            Invoke-Step -Name 'Shutdown WSL before auto-nuke fallback' -Action { Invoke-WslShutdown } | Out-Null
            Invoke-NukeVhdx -Paths $vhdxPaths
            Invoke-Step -Name 'Restart Docker Desktop after auto-nuke fallback' -Action {
                if (-not (Start-DockerDesktop)) {
                    throw 'Docker Desktop start failed after auto-nuke fallback.'
                }
            } | Out-Null
            Invoke-Step -Name 'Wait for docker info after auto-nuke fallback' -Action {
                if (-not (Wait-DockerReady -TimeoutSeconds $DockerReadyTimeoutSeconds)) {
                    throw "docker info did not become healthy within $DockerReadyTimeoutSeconds seconds after auto-nuke fallback"
                }
            } | Out-Null
            $afterNukeSizes = Get-VhdxSizes -Paths $vhdxPaths
            foreach ($path in $afterNukeSizes.Keys) {
                $bytes = [double]$afterNukeSizes[$path]
                Write-Log ('VHDX_AFTER_AUTONUKE|PATH={0}|BYTES={1}|GB={2}' -f $path, [Int64]$bytes, [Math]::Round($bytes / 1GB, 3))
            }
            $nukeDelta = Write-VhdxSummary -Before $beforeSizes -After $afterNukeSizes
            $nukePct = 0.0
            if ($totalBeforeBytes -gt 0) {
                $nukePct = [Math]::Round(($nukeDelta / $totalBeforeBytes) * 100.0, 4)
            }
            $totalDelta = $nukeDelta
            $totalReclaimPct = $nukePct
            $realSuccess = ($totalDelta -gt 0)
        }
    }

    Write-Log ('REAL_SUCCESS={0}' -f $(if ($realSuccess) { 'TRUE' } else { 'FALSE' }))
    Write-Log ('RECLAIM_GB={0}' -f [Math]::Round($totalDelta / 1GB, 3))
    Write-Log ('RECLAIM_PERCENT={0}' -f $totalReclaimPct)
}
else {
    Write-Log 'REAL_SUCCESS=FALSE' 'WARN'
    Write-Log 'RECLAIM_GB=0' 'WARN'
    Write-Log 'RECLAIM_PERCENT=0' 'WARN'
}

Write-Log 'docker-clean-deep completed.'
