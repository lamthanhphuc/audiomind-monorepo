$ErrorActionPreference = "Stop"

Set-Location (Join-Path $PSScriptRoot '..')

$tmpRoot = 'E:\.tmp-runtime'
New-Item -Path $tmpRoot -ItemType Directory -Force | Out-Null
$env:TEMP = $tmpRoot
$env:TMP = $tmpRoot

function Invoke-Step {
	param(
		[Parameter(Mandatory = $true)]
		[string]$Name,
		[Parameter(Mandatory = $true)]
		[scriptblock]$Action
	)

	Write-Host "[dev:full] $Name"
	& $Action
	if ($LASTEXITCODE -ne 0) {
		throw "Step failed: $Name (exit code $LASTEXITCODE)"
	}
}

function Resolve-Executable {
	param(
		[Parameter(Mandatory = $true)]
		[string]$Name,
		[Parameter(Mandatory = $true)]
		[string[]]$Candidates
	)

	$cmd = Get-Command $Name -ErrorAction SilentlyContinue
	if ($cmd -and $cmd.Source) {
		return $cmd.Source
	}

	foreach ($candidate in $Candidates) {
		if (Test-Path $candidate) {
			return $candidate
		}
	}

	throw "Unable to locate executable '$Name'."
}

function Wait-DockerReady {
	param(
		[int]$TimeoutSeconds = 60,
		[int]$PollSeconds = 2
	)

	$deadline = (Get-Date).AddSeconds($TimeoutSeconds)
	$apiVersionCandidates = @($null, '1.50', '1.47', '1.45', '1.43')
	while ((Get-Date) -lt $deadline) {
		foreach ($apiVersion in $apiVersionCandidates) {
			if ($null -eq $apiVersion) {
				if (Test-Path Env:DOCKER_API_VERSION) {
					Remove-Item Env:DOCKER_API_VERSION -ErrorAction SilentlyContinue
				}
			}
			else {
				$env:DOCKER_API_VERSION = $apiVersion
			}

			$probeOutput = & docker info 2>&1
			if ($LASTEXITCODE -eq 0) {
				if ($apiVersion) {
					Write-Host "[dev:full] Docker API compatibility mode enabled: $apiVersion"
				}
				return
			}

			$probeText = ($probeOutput | Out-String)
			if ($probeText -notmatch 'requested API version|Internal Server Error for API route') {
				break
			}
		}
		Start-Sleep -Seconds $PollSeconds
	}

	throw "Docker daemon is not ready after $TimeoutSeconds seconds."
}

function Invoke-WithRetry {
	param(
		[Parameter(Mandatory = $true)]
		[string]$Name,
		[Parameter(Mandatory = $true)]
		[scriptblock]$Action,
		[int]$MaxAttempts = 3,
		[int]$DelaySeconds = 5
	)

	for ($attempt = 1; $attempt -le $MaxAttempts; $attempt++) {
		try {
			& $Action
			if ($LASTEXITCODE -eq 0) {
				if ($attempt -gt 1) {
					Write-Host "[dev:full] '$Name' succeeded on attempt $attempt/$MaxAttempts"
				}
				return
			}

			throw "'$Name' failed with exit code $LASTEXITCODE"
		}
		catch {
			if ($attempt -ge $MaxAttempts) {
				throw "'$Name' failed after $MaxAttempts attempts. Last error: $($_.Exception.Message)"
			}

			Write-Host "[dev:full] '$Name' failed on attempt $attempt/$MaxAttempts. Retrying in $DelaySeconds seconds..."
			Start-Sleep -Seconds $DelaySeconds
		}
	}
}

function Invoke-AutoFix {
	try {
		Wait-DockerReady -TimeoutSeconds 20 -PollSeconds 2
		Write-Host "[dev:full] Auto-fix: Docker daemon is already ready, skipping hard reset"
		return
	}
	catch {
		Write-Host "[dev:full] Auto-fix: Docker not ready, performing hard reset"
	}

	Write-Host "[dev:full] Auto-fix: stopping Docker processes"
	Get-Process -Name 'Docker Desktop', 'com.docker.backend', 'com.docker.proxy' -ErrorAction SilentlyContinue |
		Stop-Process -Force -ErrorAction SilentlyContinue

	Write-Host "[dev:full] Auto-fix: shutting down WSL"
	try {
		wsl --shutdown
	}
	catch {
		Write-Warning "[dev:full] wsl --shutdown failed: $($_.Exception.Message)"
	}

	try {
		$dockerService = Get-Service -Name 'com.docker.service' -ErrorAction SilentlyContinue
		if ($dockerService -and $dockerService.Status -ne 'Running') {
			Write-Host "[dev:full] Auto-fix: starting com.docker.service"
			Start-Service -Name 'com.docker.service'
		}
	}
	catch {
		Write-Warning "[dev:full] Unable to start com.docker.service: $($_.Exception.Message)"
	}

	$dockerDesktopCandidates = @(
		(Join-Path $env:ProgramFiles 'Docker\Docker\Docker Desktop.exe'),
		(Join-Path $env:LocalAppData 'Programs\Docker\Docker\Docker Desktop.exe')
	)
	foreach ($dockerDesktopExe in $dockerDesktopCandidates) {
		if (Test-Path $dockerDesktopExe) {
			Write-Host "[dev:full] Auto-fix: starting Docker Desktop ($dockerDesktopExe)"
			if (Test-Path Env:DOCKER_HOST) {
				Remove-Item Env:DOCKER_HOST -ErrorAction SilentlyContinue
			}
			$env:DOCKER_CONTEXT = 'desktop-linux'
			Start-Process -FilePath $dockerDesktopExe | Out-Null
			break
		}
	}

	Write-Host "[dev:full] Auto-fix: waiting for Docker readiness"
	Wait-DockerReady -TimeoutSeconds 300
}

function Invoke-DockerCleanupFinal {
	Write-Host "==> FINAL STEP: Docker cleanup"
	$cleanScript = Join-Path $PSScriptRoot 'docker-clean-deep.ps1'
	try {
		& powershell -ExecutionPolicy Bypass -File $cleanScript
		if ($LASTEXITCODE -ne 0) {
			Write-Warning "Final Docker cleanup failed (exit code $LASTEXITCODE)"
		}
	}
	catch {
		Write-Warning "Final Docker cleanup failed: $($_.Exception.Message)"
	}
}

$kindExe = Resolve-Executable -Name 'kind' -Candidates @(
	'C:\Users\ADMIN\AppData\Local\Microsoft\WinGet\Packages\Kubernetes.kind_Microsoft.Winget.Source_8wekyb3d8bbwe\kind.exe'
)
$istioctlExe = Resolve-Executable -Name 'istioctl' -Candidates @(
	'C:\Users\ADMIN\AppData\Local\Microsoft\WinGet\Links\istioctl.exe',
	'C:\Users\ADMIN\AppData\Local\Temp\istioctl\istioctl.exe'
)
$k6Exe = Resolve-Executable -Name 'k6' -Candidates @(
	'C:\Program Files\k6\k6.exe'
)

$env:PATH = "$([System.IO.Path]::GetDirectoryName($kindExe));$([System.IO.Path]::GetDirectoryName($istioctlExe));$([System.IO.Path]::GetDirectoryName($k6Exe));$env:PATH"

$clusterName = 'audiomind-local'
$namespace = 'audiomind'
$images = @(
	'audiomind/meeting-api:0.1.0',
	'audiomind/processing-api:0.1.0',
	'audiomind/ai-api:0.1.0',
	'audiomind/ai-processing-service:0.1.0',
	'audiomind/whisper-service:0.1.0',
	'audiomind/diarization-service:0.1.0'
)

Write-Host "[dev:full] Starting full local pipeline"

$maxPipelineAttempts = 3
$pipelineSucceeded = $false
$lastPipelineError = $null

try {
	for ($pipelineAttempt = 1; $pipelineAttempt -le $maxPipelineAttempts; $pipelineAttempt++) {
		Write-Host "[dev:full] Pipeline attempt $pipelineAttempt/$maxPipelineAttempts"

		try {
			Invoke-Step -Name 'Wait Docker ready' -Action {
				Wait-DockerReady -TimeoutSeconds 60
			}

			Invoke-Step -Name 'build:images (retry up to 3x)' -Action {
				Invoke-WithRetry -Name 'docker build' -MaxAttempts 3 -DelaySeconds 10 -Action {
					npm run build:images
				}
			}

			Invoke-Step -Name 'Ensure kind cluster' -Action {
				$clusterExists = (& $kindExe get clusters) -contains $clusterName
				if (-not $clusterExists) {
					& $kindExe create cluster --name $clusterName --wait 120s
					if ($LASTEXITCODE -ne 0) { throw "kind create cluster failed with exit code $LASTEXITCODE" }
				}
				kubectl cluster-info
				if ($LASTEXITCODE -ne 0) { throw "kubectl cluster-info failed with exit code $LASTEXITCODE" }
			}

			Invoke-Step -Name 'Load local images into kind' -Action {
				$env:TMP = 'E:\.tmp-runtime'
				$env:TEMP = 'E:\.tmp-runtime'
				New-Item -ItemType Directory -Force -Path $env:TMP | Out-Null
				foreach ($image in $images) {
					Invoke-WithRetry -Name "kind load $image" -MaxAttempts 3 -DelaySeconds 5 -Action {
						& $kindExe load docker-image $image --name $clusterName
						if ($LASTEXITCODE -ne 0) {
							throw "kind load docker-image failed for $image with exit code $LASTEXITCODE"
						}
					}
				}
			}

			Invoke-Step -Name 'k8s:apply' -Action {
				Invoke-WithRetry -Name 'kubectl apply core manifests' -MaxAttempts 3 -DelaySeconds 5 -Action {
					npm run k8s:apply
					if ($LASTEXITCODE -ne 0) {
						throw "k8s:apply failed with exit code $LASTEXITCODE"
					}
				}
			}

			Invoke-Step -Name 'Apply Istio' -Action {
				Invoke-WithRetry -Name 'ensure Istio CRD exists' -MaxAttempts 3 -DelaySeconds 15 -Action {
					kubectl get crd virtualservices.networking.istio.io 1>$null 2>$null
					if ($LASTEXITCODE -ne 0) {
						& $istioctlExe install --set profile=minimal -y
						if ($LASTEXITCODE -ne 0) { throw "istioctl install failed with exit code $LASTEXITCODE" }
					}

					kubectl get crd virtualservices.networking.istio.io 1>$null 2>$null
					if ($LASTEXITCODE -ne 0) { throw "Istio CRD virtualservices.networking.istio.io still missing after install" }
				}

				Invoke-WithRetry -Name 'wait Istio CRD Established' -MaxAttempts 3 -DelaySeconds 10 -Action {
					kubectl wait --for=condition=Established crd/virtualservices.networking.istio.io --timeout=120s
					if ($LASTEXITCODE -ne 0) { throw "Istio CRD virtualservices.networking.istio.io was not established in time" }
				}

				Invoke-WithRetry -Name 'wait Istio control plane' -MaxAttempts 3 -DelaySeconds 10 -Action {
					kubectl wait --for=condition=available deployment/istiod -n istio-system --timeout=180s
					if ($LASTEXITCODE -ne 0) { throw "Istio control plane (istiod) is not available in time" }
				}

				kubectl create namespace istio-ingress 1>$null 2>$null
				if ($LASTEXITCODE -ne 0) {
					kubectl get namespace istio-ingress 1>$null 2>$null
					if ($LASTEXITCODE -ne 0) { throw "Unable to create or verify namespace istio-ingress" }
				}

				$istioDir = Join-Path (Get-Location) 'k8s/istio'
				if (Test-Path $istioDir) {
					Invoke-WithRetry -Name 'kubectl apply istio manifests' -MaxAttempts 3 -DelaySeconds 5 -Action {
						kubectl apply -f $istioDir
						if ($LASTEXITCODE -ne 0) { throw "Istio manifest apply failed with exit code $LASTEXITCODE" }
					}
				}

				kubectl label namespace $namespace istio-injection=enabled --overwrite
				if ($LASTEXITCODE -ne 0) { throw "Namespace label update failed with exit code $LASTEXITCODE" }
			}

			Invoke-Step -Name 'k8s:wait' -Action {
				npm run k8s:wait
			}

			Invoke-Step -Name 'stress:k6' -Action {
				Push-Location (Join-Path (Get-Location) 'stress-tests')
				try {
					& $k6Exe run k6-10-jobs.js
					if ($LASTEXITCODE -ne 0) { throw "k6 failed with exit code $LASTEXITCODE" }
				}
				finally {
					Pop-Location
				}
			}

			$pipelineSucceeded = $true
			Write-Host "[dev:full] Full pipeline completed"
			break
		}
		catch {
			$lastPipelineError = $_
			Write-Host "[dev:full] Pipeline attempt $pipelineAttempt/$maxPipelineAttempts failed: $($_.Exception.Message)"

			if ($pipelineAttempt -ge $maxPipelineAttempts) {
				break
			}

			try {
				Invoke-AutoFix
			}
			catch {
				Write-Warning "[dev:full] Auto-fix failed before retry: $($_.Exception.Message)"
			}
		}
	}

	if (-not $pipelineSucceeded) {
		throw "Pipeline failed after $maxPipelineAttempts attempts. Last error: $($lastPipelineError.Exception.Message)"
	}
}
finally {
	Invoke-DockerCleanupFinal
}
