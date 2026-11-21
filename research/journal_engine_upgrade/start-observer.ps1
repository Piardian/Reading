param([string]$RunDirectory)
$ErrorActionPreference = 'Stop'
$upgradeRoot = $PSScriptRoot
$variantRoot = Join-Path $upgradeRoot 'v1.3\smc_engine'
$entryFile = Join-Path $variantRoot 'dist\server\journalUpgradeObserver.js'
if (!(Test-Path -LiteralPath $entryFile)) { throw 'Compile the v1.3 workspace before starting its observer.' }
$measurementRoot = [IO.Path]::GetFullPath((Join-Path $upgradeRoot 'measurements'))
if (!$RunDirectory) { $RunDirectory = Join-Path $measurementRoot ('journal-v13-' + [DateTime]::UtcNow.ToString('yyyyMMddTHHmmssfffZ')) }
$runPath = [IO.Path]::GetFullPath($RunDirectory)
if (!$runPath.StartsWith($measurementRoot + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)) {
    throw 'The run directory must be inside journal_engine_upgrade\measurements.'
}
New-Item -ItemType Directory -Path $runPath -Force | Out-Null
$nodePath = (Get-Command node -ErrorAction Stop).Source
$stdoutPath = Join-Path $runPath 'stdout.log'
$stderrPath = Join-Path $runPath 'stderr.log'
$observerProcess = Start-Process -FilePath $nodePath -ArgumentList @('"' + $entryFile + '"', '--run-dir', '"' + $runPath + '"') -WorkingDirectory $variantRoot -WindowStyle Hidden -RedirectStandardOutput $stdoutPath -RedirectStandardError $stderrPath -PassThru
$statusPath = Join-Path $runPath 'status.json'
$ready = $false
for ($attempt = 0; $attempt -lt 120; $attempt++) {
    $observerProcess.Refresh()
    if ($observerProcess.HasExited) { throw "Observer exited. Read $stderrPath" }
    if (Test-Path -LiteralPath $statusPath) {
        $current = Get-Content -LiteralPath $statusPath -Raw | ConvertFrom-Json
        if ($current.pid -eq $observerProcess.Id -and (Test-Path -LiteralPath (Join-Path $runPath 'journal-summary.json'))) {
            $ready = $true; break
        }
    }
    Start-Sleep -Milliseconds 250
}
if (!$ready) { throw "Observer readiness was not confirmed. Inspect PID $($observerProcess.Id) and $stderrPath before retrying." }
$activation = [ordered]@{ runDirectory=$runPath; pid=$observerProcess.Id; startedAt=[DateTime]::UtcNow.ToString('o'); stdout=$stdoutPath; stderr=$stderrPath }
$activation | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $upgradeRoot 'active-observer.json') -Encoding utf8
$activation | ConvertTo-Json
