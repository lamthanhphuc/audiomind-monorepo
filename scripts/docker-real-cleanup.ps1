[CmdletBinding(SupportsShouldProcess = $true, ConfirmImpact = 'High')]
param(
    [ValidateSet('Compact', 'Move')]
    [string]$Mode = 'Compact',

    # Used by Move mode. Example: D:\
    [string]$TargetDrive = 'D:\',

    # Subfolder created under TargetDrive for move artifacts.
    [string]$TargetSubdir = 'wsl\docker-desktop-data',

    # Backup distro tar is always kept. Name includes timestamp.
    [string]$BackupNamePrefix = 'docker-desktop-data-backup',

    # WSL distro to move (default Docker Desktop data distro).
    [string]$DistroName = 'docker-desktop-data',

    # Run without interactive confirmation prompts.
    [switch]$Force,

    # Skip Docker Desktop restart at the end.
    [switch]$SkipRestart,

    # Optional stack verification after restart.
    [switch]$VerifyStack,

    # Optional health check URLs to probe after stack verification.
    [string[]]$HealthCheckUrls = @(),

    # Compose file used only when -VerifyStack is set.
    [string]$ComposeFile = 'infra/docker-compose.dev.yml',

    [ValidateRange(30, 900)]
    [int]$DockerReadyTimeoutSeconds = 180,

    [ValidateRange(1, 30)]
    [int]$DockerPollIntervalSeconds = 3
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

# Windows PowerShell 5.1 does not define $IsWindows; normalize a platform flag.
$isWindowsPlatform = if (Get-Variable -Name IsWindows -ErrorAction SilentlyContinue) {
    [bool]$IsWindows
}
else {
    ($PSVersionTable.PSEdition -eq 'Desktop') -or ($env:OS -eq 'Windows_NT')
}

# -----------------------------
# Logging
# -----------------------------
$scriptRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
$workspaceRoot = Split-Path -Parent $scriptRoot
$logDir = Join-Path $workspaceRoot 'logs'
if (-not (Test-Path -LiteralPath $logDir)) {
    New-Item -ItemType Directory -Path $logDir -Force | Out-Null
}
$logPath = Join-Path $logDir ("docker-real-cleanup-{0}.log" -f (Get-Date -Format 'yyyyMMdd-HHmmss'))

function Write-Log {
    param(
        [string]$Message,
        [ValidateSet('INFO', 'WARN', 'ERROR')]
        [string]$Level = 'INFO'
    )

    $line = "{0} [{1}] {2}" -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'), $Level, $Message
    Write-Host $line
    Add-Content -LiteralPath $logPath -Value $line
}

function Exit-Failure {
    param([string]$Message)
    Write-Log -Message $Message -Level 'ERROR'
    Write-Log -Message ("Log file: {0}" -f $logPath) -Level 'ERROR'
    exit 1
}

# -----------------------------
# Generic helpers
# -----------------------------
function Test-IsAdministrator {
    $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
    $principal = [Security.Principal.WindowsPrincipal]::new($identity)
    return $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
}

function Confirm-IfNeeded {
    param(
        [string]$Question,
        [string]$Caption = 'Confirm operation'
    )

    if ($Force -or $WhatIfPreference) {
        return
    }

    $ok = $PSCmdlet.ShouldContinue($Question, $Caption)
    if (-not $ok) {
        throw 'User canceled the operation.'
    }
}

function Format-Bytes {
    param([int64]$Value)
    return "{0:N2} GB" -f ($Value / 1GB)
}

function Get-DriveLetterFromPath {
    param([string]$Path)
    $root = [System.IO.Path]::GetPathRoot($Path)
    if (-not $root) { return $null }
    return $root.TrimEnd('\').TrimEnd(':')
}

function Get-DriveSnapshot {
    param([string[]]$DriveLetters)

    $rows = @()
    foreach ($d in $DriveLetters | Select-Object -Unique) {
        if (-not $d) { continue }
        $drive = Get-PSDrive -Name $d -ErrorAction SilentlyContinue
        if ($null -eq $drive) { continue }

        $used = $drive.Used
        $free = $drive.Free
        $total = $used + $free

        $rows += [PSCustomObject]@{
            Drive      = $d + ':'
            UsedBytes  = [int64]$used
            FreeBytes  = [int64]$free
            TotalBytes = [int64]$total
        }
    }

    return $rows
}

function Write-DriveSnapshot {
    param(
        [string]$Label,
        [object[]]$Snapshot
    )

    Write-Log ("==== Drive usage {0} ====" -f $Label)
    foreach ($row in $Snapshot) {
        Write-Log ("{0} Used={1} Free={2} Total={3}" -f $row.Drive, (Format-Bytes $row.UsedBytes), (Format-Bytes $row.FreeBytes), (Format-Bytes $row.TotalBytes))
    }
}

# -----------------------------
# Docker / WSL control
# -----------------------------
function Get-DockerDesktopExe {
    $candidates = @(
        (Join-Path $env:ProgramFiles 'Docker\Docker\Docker Desktop.exe'),
        (Join-Path ${env:ProgramFiles(x86)} 'Docker\Docker\Docker Desktop.exe')
    )

    foreach ($candidate in $candidates) {
        if ($candidate -and (Test-Path -LiteralPath $candidate)) {
            return $candidate
        }
    }

    return $null
}

function Get-DockerCli {
    $cli = Join-Path $env:ProgramFiles 'Docker\Docker\DockerCli.exe'
    if (Test-Path -LiteralPath $cli) { return $cli }
    return $null
}

function Test-DockerInfo {
    try {
        $null = docker info --format '{{.ServerVersion}}' 2>$null
        return ($LASTEXITCODE -eq 0)
    }
    catch {
        return $false
    }
}

function Stop-DockerDesktop {
    Write-Log 'Stopping Docker Desktop...'

    $dockerCli = Get-DockerCli
    if ($dockerCli) {
        try {
            & $dockerCli -Shutdown 2>$null | Out-Null
        }
        catch {
            Write-Log ("DockerCli shutdown warning: {0}" -f $_.Exception.Message) 'WARN'
        }
    }

    $names = @('Docker Desktop', 'Docker Desktop Backend', 'com.docker.backend')
    foreach ($name in $names) {
        try {
            Get-Process -Name $name -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
        }
        catch {
            Write-Log ("Stop process warning for {0}: {1}" -f $name, $_.Exception.Message) 'WARN'
        }
    }

    Start-Sleep -Seconds 2
}

function Start-DockerDesktop {
    $exe = Get-DockerDesktopExe
    if (-not $exe) {
        throw 'Docker Desktop executable not found.'
    }

    Write-Log 'Starting Docker Desktop...'
    Start-Process -FilePath $exe | Out-Null
}

function Wait-DockerReady {
    param(
        [int]$TimeoutSeconds,
        [int]$IntervalSeconds
    )

    $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
    while ((Get-Date) -lt $deadline) {
        if (Test-DockerInfo) { return $true }
        Start-Sleep -Seconds $IntervalSeconds
    }

    return $false
}

function Ensure-DockerStopped {
    if (Test-DockerInfo) {
        Write-Log 'Docker daemon is currently reachable and must be stopped.'
    }
    else {
        Write-Log 'Docker daemon is already stopped/unreachable.'
    }

    if ($PSCmdlet.ShouldProcess('Docker Desktop', 'Stop Docker Desktop')) {
        Stop-DockerDesktop
    }

    if (Test-DockerInfo) {
        throw 'Docker is still running after stop attempt. Please close Docker Desktop manually and retry.'
    }

    Write-Log 'Docker is confirmed stopped.'
}

function Shutdown-WSL {
    Write-Log 'Shutting down WSL...'
    if ($PSCmdlet.ShouldProcess('WSL', 'wsl --shutdown')) {
        & wsl --shutdown
        if ($LASTEXITCODE -ne 0) {
            throw "wsl --shutdown failed with exit code $LASTEXITCODE"
        }
    }
}

function Get-WslDistroList {
    $raw = & wsl -l -q 2>$null
    if ($LASTEXITCODE -ne 0) {
        return @()
    }

    return @($raw | ForEach-Object { $_.Trim() } | Where-Object { $_ })
}

function Get-LxssDistroInfo {
    param([string]$Name)

    $root = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Lxss'
    if (-not (Test-Path -LiteralPath $root)) {
        return $null
    }

    foreach ($key in Get-ChildItem -Path $root -ErrorAction SilentlyContinue) {
        $props = Get-ItemProperty -Path $key.PSPath -ErrorAction SilentlyContinue
        if ($props -and $props.DistributionName -eq $Name) {
            return [PSCustomObject]@{
                Name     = $props.DistributionName
                BasePath = $props.BasePath
                KeyPath  = $key.PSPath
            }
        }
    }

    return $null
}

# -----------------------------
# Docker storage path detection
# -----------------------------
function Resolve-DockerVhdxPath {
    # 1) Environment variable hints (if user/system sets them)
    $envCandidates = @(
        $env:DOCKER_DESKTOP_WSL_DISK_PATH,
        $env:DOCKER_WSL_DISK_PATH,
        $env:DOCKER_DATA_VHDX_PATH,
        $env:WSL_DOCKER_DATA_VHDX
    ) | Where-Object { $_ -and $_.Trim() }

    # 2) Common Docker Desktop defaults
    $defaultCandidates = @(
        (Join-Path $env:LOCALAPPDATA 'Docker\wsl\disk\docker_data.vhdx'),
        (Join-Path $env:LOCALAPPDATA 'Docker\wsl\data\ext4.vhdx')
    )

    # 3) Registry-based path from docker-desktop-data distro
    $registryCandidate = $null
    $distroInfo = Get-LxssDistroInfo -Name $DistroName
    if ($distroInfo -and $distroInfo.BasePath) {
        $registryCandidate = Join-Path $distroInfo.BasePath 'ext4.vhdx'
    }

    $allCandidates = @($envCandidates + $defaultCandidates + $registryCandidate) |
        Where-Object { $_ } |
        Select-Object -Unique

    foreach ($candidate in $allCandidates) {
        if (Test-Path -LiteralPath $candidate) {
            return [PSCustomObject]@{
                Found      = $true
                Path       = $candidate
                Candidates = $allCandidates
            }
        }
    }

    return [PSCustomObject]@{
        Found      = $false
        Path       = $null
        Candidates = $allCandidates
    }
}

# -----------------------------
# Compact mode
# -----------------------------
function Test-OptimizeVhdAvailable {
    $optimizeCmd = Get-Command Optimize-VHD -ErrorAction SilentlyContinue
    if (-not $optimizeCmd) {
        return $false
    }

    try {
        $feature = Get-WindowsOptionalFeature -Online -FeatureName Microsoft-Hyper-V-All -ErrorAction SilentlyContinue
        if ($feature -and $feature.State -eq 'Enabled') {
            return $true
        }
    }
    catch {
        Write-Log ("Hyper-V feature check warning: {0}" -f $_.Exception.Message) 'WARN'
    }

    # Command exists but feature check inconclusive; still allow attempt.
    return $true
}

function Invoke-DiskPartCompact {
    param([string]$VhdxPath)

    $tmpScript = Join-Path $env:TEMP ("diskpart-compact-{0}.txt" -f [Guid]::NewGuid().ToString('N'))
    @(
        ('select vdisk file="{0}"' -f $VhdxPath),
        'attach vdisk readonly',
        'compact vdisk',
        'detach vdisk',
        'exit'
    ) | Set-Content -LiteralPath $tmpScript -Encoding ASCII

    try {
        & diskpart.exe /s $tmpScript
        if ($LASTEXITCODE -ne 0) {
            throw "diskpart compact failed with exit code $LASTEXITCODE"
        }
    }
    finally {
        Remove-Item -LiteralPath $tmpScript -Force -ErrorAction SilentlyContinue
    }
}

function Invoke-CompactMode {
    $resolved = Resolve-DockerVhdxPath
    if (-not $resolved.Found) {
        throw ("Cannot locate Docker VHDX. Candidates tried: {0}" -f ($resolved.Candidates -join '; '))
    }

    $vhdx = $resolved.Path
    Write-Log ("Detected VHDX path: {0}" -f $vhdx)

    if (Test-OptimizeVhdAvailable) {
        try {
            Write-Log 'Compact mode: trying Optimize-VHD first.'
            if ($PSCmdlet.ShouldProcess($vhdx, 'Optimize-VHD -Mode Full')) {
                Optimize-VHD -Path $vhdx -Mode Full -ErrorAction Stop
            }
            return
        }
        catch {
            Write-Log ("Optimize-VHD failed. Falling back to diskpart. Error: {0}" -f $_.Exception.Message) 'WARN'
        }
    }
    else {
        Write-Log 'Optimize-VHD not available. Using diskpart compact fallback.' 'WARN'
    }

    if ($PSCmdlet.ShouldProcess($vhdx, 'diskpart compact vdisk')) {
        Invoke-DiskPartCompact -VhdxPath $vhdx
    }
}

# -----------------------------
# Move mode
# -----------------------------
function Ensure-TargetDriveCapacity {
    param(
        [string]$DriveRoot,
        [int64]$RequiredBytes
    )

    $letter = Get-DriveLetterFromPath -Path $DriveRoot
    if (-not $letter) {
        throw "Invalid target drive path: $DriveRoot"
    }

    $drive = Get-PSDrive -Name $letter -ErrorAction SilentlyContinue
    if (-not $drive) {
        throw "Target drive not found: $DriveRoot"
    }

    if ($drive.Free -lt $RequiredBytes) {
        $need = Format-Bytes $RequiredBytes
        $free = Format-Bytes ([int64]$drive.Free)
        throw "Insufficient free space on ${letter}: required $need, available $free"
    }
}

function Invoke-MoveMode {
    $distros = Get-WslDistroList
    if ($distros -notcontains $DistroName) {
        throw "WSL distro '$DistroName' not found. Cannot move."
    }

    $distroInfo = Get-LxssDistroInfo -Name $DistroName
    if (-not $distroInfo -or -not $distroInfo.BasePath) {
        throw "Cannot resolve BasePath for distro '$DistroName' from registry."
    }

    $targetRoot = Join-Path $TargetDrive $TargetSubdir
    $targetInstallDir = Join-Path $targetRoot 'distro'
    $backupTar = Join-Path $targetRoot ("{0}-{1}.tar" -f $BackupNamePrefix, (Get-Date -Format 'yyyyMMdd-HHmmss'))

    # Idempotency: if already under target root, do nothing.
    if ($distroInfo.BasePath.ToLower().StartsWith($targetRoot.ToLower())) {
        Write-Log ("Distro already located at target path. No move needed. BasePath={0}" -f $distroInfo.BasePath)
        return
    }

    # Capacity check: estimate >= 2x source vhdx + 2GB buffer for export/import overhead.
    $resolved = Resolve-DockerVhdxPath
    if (-not $resolved.Found) {
        throw 'Cannot locate source VHDX to estimate required capacity for move mode.'
    }

    $srcVhdxBytes = (Get-Item -LiteralPath $resolved.Path).Length
    $required = [int64](($srcVhdxBytes * 2) + 2GB)

    Ensure-TargetDriveCapacity -DriveRoot $TargetDrive -RequiredBytes $required

    if ($PSCmdlet.ShouldProcess($targetRoot, 'Create move target directory')) {
        New-Item -ItemType Directory -Path $targetRoot -Force | Out-Null
    }

    Confirm-IfNeeded -Question ("Move mode will unregister and re-import distro '$DistroName'. Continue?") -Caption 'Move mode downtime'

    # Keep old base path for rollback attempt.
    $oldBasePath = $distroInfo.BasePath
    $unregistered = $false

    try {
        Write-Log ("Exporting backup tar to: {0}" -f $backupTar)
        if ($PSCmdlet.ShouldProcess($DistroName, 'wsl --export backup')) {
            & wsl --export $DistroName $backupTar
            if ($LASTEXITCODE -ne 0) {
                throw "wsl --export failed with exit code $LASTEXITCODE"
            }
        }

        if (-not (Test-Path -LiteralPath $backupTar)) {
            throw 'Backup tar file was not created.'
        }

        Write-Log ("Unregistering distro: {0}" -f $DistroName)
        if ($PSCmdlet.ShouldProcess($DistroName, 'wsl --unregister')) {
            & wsl --unregister $DistroName
            if ($LASTEXITCODE -ne 0) {
                throw "wsl --unregister failed with exit code $LASTEXITCODE"
            }
        }
        $unregistered = $true

        if ($PSCmdlet.ShouldProcess($targetInstallDir, 'Create import install directory')) {
            New-Item -ItemType Directory -Path $targetInstallDir -Force | Out-Null
        }

        Write-Log ("Importing distro into: {0}" -f $targetInstallDir)
        if ($PSCmdlet.ShouldProcess($DistroName, 'wsl --import to target drive')) {
            & wsl --import $DistroName $targetInstallDir $backupTar --version 2
            if ($LASTEXITCODE -ne 0) {
                throw "wsl --import failed with exit code $LASTEXITCODE"
            }
        }

        $after = Get-WslDistroList
        if ($after -notcontains $DistroName) {
            throw "Distro '$DistroName' missing after import."
        }

        Write-Log 'Move mode completed successfully.'
        Write-Log ("Backup retained at: {0}" -f $backupTar)
    }
    catch {
        Write-Log ("Move mode failed: {0}" -f $_.Exception.Message) 'ERROR'

        # Best-effort rollback: if unregistered, import back to original path from backup tar.
        if ($unregistered -and (Test-Path -LiteralPath $backupTar)) {
            Write-Log 'Attempting rollback: re-import distro to original base path...' 'WARN'
            try {
                if (-not (Test-Path -LiteralPath $oldBasePath)) {
                    New-Item -ItemType Directory -Path $oldBasePath -Force | Out-Null
                }

                & wsl --import $DistroName $oldBasePath $backupTar --version 2
                if ($LASTEXITCODE -eq 0) {
                    Write-Log 'Rollback succeeded.'
                }
                else {
                    Write-Log ("Rollback failed with exit code $LASTEXITCODE") 'ERROR'
                }
            }
            catch {
                Write-Log ("Rollback exception: {0}" -f $_.Exception.Message) 'ERROR'
            }
        }

        throw
    }
}

# -----------------------------
# Optional stack verify
# -----------------------------
function Invoke-OptionalStackVerify {
    if (-not $VerifyStack) {
        Write-Log 'Stack verification skipped.'
        return
    }

    $composePath = Join-Path $workspaceRoot $ComposeFile
    if (-not (Test-Path -LiteralPath $composePath)) {
        throw "Compose file for verification not found: $composePath"
    }

    Write-Log ("Verifying stack with compose file: {0}" -f $composePath)

    if ($PSCmdlet.ShouldProcess($composePath, 'docker compose config')) {
        & docker compose -f $composePath config > $null
        if ($LASTEXITCODE -ne 0) {
            throw 'docker compose config failed during verify step.'
        }
    }

    if ($PSCmdlet.ShouldProcess($composePath, 'docker compose up -d')) {
        & docker compose -f $composePath up -d
        if ($LASTEXITCODE -ne 0) {
            throw 'docker compose up -d failed during verify step.'
        }
    }

    if ($HealthCheckUrls.Count -gt 0) {
        foreach ($url in $HealthCheckUrls) {
            Write-Log ("Health check: {0}" -f $url)
            if ($PSCmdlet.ShouldProcess($url, 'Invoke-WebRequest health probe')) {
                try {
                    $null = Invoke-WebRequest -Uri $url -UseBasicParsing -TimeoutSec 5
                }
                catch {
                    throw ("Health check failed for {0}: {1}" -f $url, $_.Exception.Message)
                }
            }
        }
    }
}

# -----------------------------
# Main flow
# -----------------------------
try {
    Write-Log 'docker-real-cleanup starting.'
    Write-Log ("Mode={0}; WhatIf={1}; Force={2}; VerifyStack={3}" -f $Mode, [bool]$WhatIfPreference, [bool]$Force, [bool]$VerifyStack)

    if (-not $isWindowsPlatform) {
        throw 'This script supports Windows + Docker Desktop + WSL2 only.'
    }

    if (-not (Get-Command wsl -ErrorAction SilentlyContinue)) {
        throw 'wsl command was not found.'
    }

    if (-not (Get-Command docker -ErrorAction SilentlyContinue)) {
        throw 'docker command was not found.'
    }

    if (-not (Test-IsAdministrator)) {
        throw 'Administrator privileges are required. Open PowerShell with Run as Administrator.'
    }

    $targetLetter = Get-DriveLetterFromPath -Path $TargetDrive
    $before = Get-DriveSnapshot -DriveLetters @('C', $targetLetter)
    Write-DriveSnapshot -Label 'BEFORE' -Snapshot $before

    Confirm-IfNeeded -Question ("Proceed with mode '$Mode'?")

    # Pre-check requirements
    Ensure-DockerStopped
    Shutdown-WSL

    switch ($Mode) {
        'Compact' {
            Invoke-CompactMode
        }
        'Move' {
            Invoke-MoveMode
        }
    }

    if (-not $SkipRestart) {
        if ($PSCmdlet.ShouldProcess('Docker Desktop', 'Restart Docker Desktop')) {
            Start-DockerDesktop
        }

        $ready = Wait-DockerReady -TimeoutSeconds $DockerReadyTimeoutSeconds -IntervalSeconds $DockerPollIntervalSeconds
        if (-not $ready) {
            throw 'Docker did not become ready after restart.'
        }

        Write-Log 'Docker restart verification succeeded.'
        Invoke-OptionalStackVerify
    }
    else {
        Write-Log 'SkipRestart enabled. Docker restart was not attempted.'
    }

    $after = Get-DriveSnapshot -DriveLetters @('C', $targetLetter)
    Write-DriveSnapshot -Label 'AFTER' -Snapshot $after

    Write-Log 'docker-real-cleanup completed successfully.'
    Write-Log ("Log file: {0}" -f $logPath)
    exit 0
}
catch {
    Write-Log ("Fatal error: {0}" -f $_.Exception.Message) 'ERROR'
    Write-Log ("Log file: {0}" -f $logPath) 'ERROR'
    exit 1
}
