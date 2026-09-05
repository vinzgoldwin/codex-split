$ErrorActionPreference = 'Stop'

$Server = if ($env:CODEX_SPLIT_SERVER) { $env:CODEX_SPLIT_SERVER.TrimEnd('/') } else { 'https://codex-split.pages.dev' }
$CollectorVersion = '0.2.0'
$Architecture = switch ([System.Runtime.InteropServices.RuntimeInformation]::OSArchitecture.ToString()) {
    'X64' { 'x86_64' }
    'Arm64' { 'aarch64' }
    default { throw 'Codex Split supports x86_64 and ARM64 Windows devices.' }
}

$Asset = "codex-split-windows-$Architecture-$CollectorVersion.exe"
$InstallDirectory = Join-Path $env:LOCALAPPDATA 'CodexSplit'
$Binary = Join-Path $InstallDirectory 'codex-split.exe'
$TemporaryDirectory = Join-Path ([System.IO.Path]::GetTempPath()) ("codex-split-" + [guid]::NewGuid())

try {
    New-Item -ItemType Directory -Force -Path $TemporaryDirectory, $InstallDirectory | Out-Null
    $Download = Join-Path $TemporaryDirectory 'codex-split.exe'
    $Checksum = Join-Path $TemporaryDirectory 'codex-split.sha256'

    Write-Host 'Installing Codex Split...'
    Invoke-WebRequest "$Server/downloads/$Asset" -OutFile $Download
    Invoke-WebRequest "$Server/downloads/$Asset.sha256" -OutFile $Checksum

    $Signature = [System.IO.File]::ReadAllBytes($Download)[0..1]
    if ($Signature[0] -ne 0x4d -or $Signature[1] -ne 0x5a) {
        throw "No published Codex Split build for Windows $Architecture."
    }

    $Expected = (Get-Content $Checksum).Split(' ', [System.StringSplitOptions]::RemoveEmptyEntries)[0]
    if ($Expected -notmatch '^[0-9a-fA-F]{64}$') { throw 'The published collector checksum is invalid.' }
    $Actual = (Get-FileHash -Algorithm SHA256 $Download).Hash
    if ($Expected -ne $Actual) { throw 'Collector checksum did not match.' }

    $ExistingTask = Get-ScheduledTask -TaskName 'Codex Split Collector' -ErrorAction SilentlyContinue
    if ($ExistingTask) {
        Stop-ScheduledTask -TaskName 'Codex Split Collector'
        Start-Sleep -Seconds 2
    }
    # Stop only this installed collector, not other applications.
    Get-Process -Name 'codex-split' -ErrorAction SilentlyContinue | Where-Object { $_.Path -eq $Binary } | Stop-Process -Force
    Move-Item -Force $Download $Binary
    & $Binary setup --server $Server
    if ($LASTEXITCODE -ne 0) { throw 'Device setup failed.' }

    $Launcher = Join-Path $InstallDirectory 'launcher.ps1'
    @'
$ErrorActionPreference = 'Continue'
$Binary = Join-Path $PSScriptRoot 'codex-split.exe'
while ($true) {
    & $Binary stage-update
    $Staged = "$Binary.next.exe"
    if (Test-Path $Staged) {
        try {
            Copy-Item -Force $Binary "$Binary.previous"
            Move-Item -Force $Staged $Binary -ErrorAction Stop
            & $Binary version
            if ($LASTEXITCODE -ne 0) { Move-Item -Force "$Binary.previous" $Binary }
        } catch { Write-Warning $_ }
    }
    & $Binary tick
    Start-Sleep -Seconds 60
}
'@ | Set-Content -Encoding UTF8 $Launcher
    $Action = New-ScheduledTaskAction -Execute 'powershell.exe' -Argument "-NoProfile -NonInteractive -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$Launcher`""
    $Trigger = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME
    $Settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable -ExecutionTimeLimit ([TimeSpan]::Zero) -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1)
    Register-ScheduledTask -TaskName 'Codex Split Collector' -Action $Action -Trigger $Trigger -Settings $Settings -Force | Out-Null
    Start-ScheduledTask -TaskName 'Codex Split Collector'

    Write-Host 'Codex Split is installed, registered, and running.'
} finally {
    Remove-Item -Recurse -Force $TemporaryDirectory -ErrorAction SilentlyContinue
}
