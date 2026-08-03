[CmdletBinding()]
param(
    [ValidateSet("", "transient", "auth", "notfound", "invalid")]
    [string]$FailMode = "",
    [string]$FailTool = ""
)

$ErrorActionPreference = "Stop"

$repositoryRoot = Split-Path -Parent $PSScriptRoot
$backendRoot = Join-Path $repositoryRoot "backend"
$frontendRoot = Join-Path $repositoryRoot "frontend"
$logRoot = Join-Path $repositoryRoot ".demo-logs"
New-Item -ItemType Directory -Force -Path $logRoot | Out-Null

$env:APP_ENV = "development"
$env:APP_HOST = "127.0.0.1"
$env:APP_PORT = "8080"
$env:FRONTEND_URL = "http://127.0.0.1:5173"
$env:MCP_MODE = "remote"
$env:MCP_BASE_URL = "http://127.0.0.1:9000"
$env:MOCK_ERP_PORT = "9000"
$env:MOCK_ERP_MIN_LATENCY_MS = "80"
$env:MOCK_ERP_MAX_LATENCY_MS = "250"
$env:MOCK_ERP_FAIL_TOOL = $FailTool
$env:MOCK_ERP_FAIL_MODE = $FailMode

function Start-DemoProcess {
    param(
        [string]$Name,
        [string]$FilePath,
        [string[]]$Arguments,
        [string]$WorkingDirectory
    )

    $stdoutPath = Join-Path $logRoot "$Name.stdout.log"
    $stderrPath = Join-Path $logRoot "$Name.stderr.log"
    return Start-Process `
        -FilePath $FilePath `
        -ArgumentList $Arguments `
        -WorkingDirectory $WorkingDirectory `
        -WindowStyle Hidden `
        -RedirectStandardOutput $stdoutPath `
        -RedirectStandardError $stderrPath `
        -PassThru
}

function Wait-ForHealth {
    param(
        [string]$URL,
        [int]$Attempts = 80
    )

    for ($attempt = 1; $attempt -le $Attempts; $attempt++) {
        try {
            $response = Invoke-RestMethod -Uri $URL -TimeoutSec 1
            $serviceStatus = $response.status
            if ($null -ne $response.data) {
                $serviceStatus = $response.data.status
            }
            if ($serviceStatus -eq "healthy") {
                return
            }
        } catch {
            Start-Sleep -Milliseconds 250
        }
    }
    throw "Timed out waiting for $URL. Inspect $logRoot."
}

$mockERP = Start-DemoProcess `
    -Name "mock-erp" `
    -FilePath "go" `
    -Arguments @("run", "-buildvcs=false", "./cmd/mock-erp") `
    -WorkingDirectory $backendRoot
Wait-ForHealth -URL "http://127.0.0.1:9000/healthz"

$backend = Start-DemoProcess `
    -Name "backend" `
    -FilePath "go" `
    -Arguments @("run", "-buildvcs=false", "./cmd/server") `
    -WorkingDirectory $backendRoot
Wait-ForHealth -URL "http://127.0.0.1:8080/healthz"

$frontend = Start-DemoProcess `
    -Name "frontend" `
    -FilePath "npm.cmd" `
    -Arguments @("run", "dev", "--", "--host", "127.0.0.1") `
    -WorkingDirectory $frontendRoot

Write-Host "Mock ERP : http://127.0.0.1:9000 (PID $($mockERP.Id))"
Write-Host "Backend  : http://127.0.0.1:8080 (PID $($backend.Id))"
Write-Host "Frontend : http://127.0.0.1:5173 (PID $($frontend.Id))"
Write-Host "Logs     : $logRoot"
