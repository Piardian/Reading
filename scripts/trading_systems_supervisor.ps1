$ErrorActionPreference = "Stop"

$PythonExe = "C:\Users\piard\AppData\Local\Programs\Python\Python312\python.exe"
$BegonyaRoot = "C:\Users\piard\.gemini\antigravity\scratch\Begonya"
$Begonya00Root = "C:\Users\piard\Desktop\Begonya00"
$PragmaRoot = "C:\Users\piard\Desktop\PragmaProject"
$TrawmaRoot = "C:\Users\piard\Desktop\TrawmaProject"
$StigmaRoot = "C:\Users\piard\Desktop\StigmaProject"
$MegalordRoot = "C:\Users\piard\Desktop\MegalordProject"
$ChecklistRoot = "C:\Users\piard\.gemini\antigravity\scratch\swing-bos-core"
$LogDir = Join-Path $PSScriptRoot "supervisor_logs"
$LogFile = Join-Path $LogDir "trading_systems_supervisor.log"

New-Item -ItemType Directory -Path $LogDir -Force | Out-Null

function Write-SupervisorLog {
    param([string]$Message)
    $line = "{0} | {1}" -f (Get-Date -Format "yyyy-MM-dd HH:mm:ss"), $Message
    Add-Content -LiteralPath $LogFile -Value $line -Encoding UTF8
}

function Get-MatchingProcesses {
    param([string[]]$Needles)
    $matches = @()
    foreach ($process in @(Get-CimInstance Win32_Process -ErrorAction SilentlyContinue)) {
        $isMatch = $true
        $cmd = [string]$process.CommandLine
        if (-not $cmd) { continue }
        foreach ($needle in $Needles) {
            if ($cmd.IndexOf($needle, [System.StringComparison]::OrdinalIgnoreCase) -lt 0) {
                $isMatch = $false
                break
            }
        }
        if ($isMatch) { $matches += $process }
    }
    return $matches
}

function Test-LockedOrchestrator {
    param([string]$LockPath)
    if (-not (Test-Path -LiteralPath $LockPath)) { return $false }
    try {
        $pidValue = [int](Get-Content -Raw -LiteralPath $LockPath).Trim()
        $proc = Get-CimInstance Win32_Process -Filter "ProcessId=$pidValue" -ErrorAction Stop
        return $proc.Name -ieq "python.exe" -and ([string]$proc.CommandLine) -match "start_begonya\.py"
    } catch {
        return $false
    }
}

function Ensure-PythonProcess {
    param(
        [string]$Name,
        [string]$WorkingDirectory,
        [string[]]$Arguments,
        [string[]]$Needles
    )
    $existing = @(Get-MatchingProcesses -Needles $Needles | Where-Object { $_.Name -in @("python.exe", "pythonw.exe") })
    if ($existing.Count -gt 0) {
        $status = if ($existing.Count -eq 1) { 'PROCESS_PRESENT' } else { 'DUPLICATE_PROCESSES' }
        Write-SupervisorLog "$Name $status pid=$($existing[0].ProcessId) count=$($existing.Count)"
        return
    }

    Start-Process -FilePath $PythonExe -ArgumentList $Arguments -WorkingDirectory $WorkingDirectory -WindowStyle Hidden
    Start-Sleep -Seconds 3
    $started = @(Get-MatchingProcesses -Needles $Needles | Where-Object { $_.Name -in @("python.exe", "pythonw.exe") })
    if ($started.Count -gt 0) {
        Write-SupervisorLog "$Name STARTED pid=$($started[0].ProcessId)"
    } else {
        Write-SupervisorLog "$Name START_REQUESTED_BUT_NOT_CONFIRMED"
    }
}

function Ensure-Orchestrator {
    param(
        [string]$Name,
        [string]$Root,
        [string]$LockPath
    )
    if (Test-LockedOrchestrator -LockPath $LockPath) {
        $pidValue = (Get-Content -Raw -LiteralPath $LockPath).Trim()
        Write-SupervisorLog "$Name HEALTHY pid=$pidValue"
        return
    }

    Start-Process -FilePath $PythonExe -ArgumentList @("orchestrator\start_begonya.py") -WorkingDirectory $Root -WindowStyle Hidden
    Start-Sleep -Seconds 5
    if (Test-LockedOrchestrator -LockPath $LockPath) {
        $pidValue = (Get-Content -Raw -LiteralPath $LockPath).Trim()
        Write-SupervisorLog "$Name STARTED pid=$pidValue"
    } else {
        Write-SupervisorLog "$Name START_REQUESTED_BUT_NOT_CONFIRMED"
    }
}

Write-SupervisorLog "SUPERVISOR_CYCLE_BEGIN"

Ensure-Orchestrator -Name "Begonya" -Root $BegonyaRoot `
    -LockPath (Join-Path $BegonyaRoot "orchestrator\begonya_orchestrator.lock")

Ensure-Orchestrator -Name "Begonya00" -Root $Begonya00Root `
    -LockPath (Join-Path $Begonya00Root "orchestrator\begonya00_orchestrator.lock")

Ensure-PythonProcess -Name "PragmaShadow" -WorkingDirectory $PragmaRoot `
    -Arguments @("-m", "pragma.shadow_trader", "--poll-seconds", "10", "--bars", "3000", "--heartbeat-minutes", "0") `
    -Needles @("-m pragma.shadow_trader", "--poll-seconds 10")

Ensure-PythonProcess -Name "PragmaWatcher" -WorkingDirectory $PragmaRoot `
    -Arguments @("-u", "-m", "pragma.run_pipeline", "--scan-begonya", "--refresh-macro", "--watch", "--interval-sec", "15") `
    -Needles @("-m pragma.run_pipeline", "--scan-begonya", "--watch")

Ensure-PythonProcess -Name "TrawmaPaper" -WorkingDirectory $TrawmaRoot `
    -Arguments @("-u", "run_pipeline.py", "--scan-all", "--watch", "--interval-sec", "15", "--execute-mode", "paper") `
    -Needles @("run_pipeline.py", "--execute-mode paper")

Ensure-PythonProcess -Name "Stigma" -WorkingDirectory $StigmaRoot `
    -Arguments @("-u", "run_pipeline.py", "--scan-whitelist", "--watch", "--interval-sec", "30") `
    -Needles @("run_pipeline.py", "--scan-whitelist", "--watch")

Ensure-PythonProcess -Name "MegalordShadow" -WorkingDirectory $MegalordRoot `
    -Arguments @("-u", "-m", "megalord.megalord_daemon", "--mode", "shadow", "--watch", "--interval-sec", "15") `
    -Needles @("megalord", "megalord_daemon", "--mode shadow", "--watch")

# ChecklistTrigger is owned and continuously restarted by the normal Begonya
# orchestrator. Starting a second standalone copy would collide on its port and
# runtime.lock, so the central supervisor only verifies it here.
Start-Sleep -Seconds 3
$checklist = @(Get-MatchingProcesses -Needles @("swing-bos-core\dist\server\index.js") | Where-Object { $_.Name -eq "node.exe" })
if ($checklist.Count -gt 0) {
    Write-SupervisorLog "ChecklistTrigger HEALTHY pid=$($checklist[0].ProcessId) count=$($checklist.Count)"
} else {
    Write-SupervisorLog "ChecklistTrigger NOT_CONFIRMED; Begonya orchestrator will retry it"
}

Write-SupervisorLog "SUPERVISOR_CYCLE_END"
