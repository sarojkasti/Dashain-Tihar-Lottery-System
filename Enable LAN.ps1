#Requires -RunAsAdministrator
param([string]$CredentialOwnerSid = [System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value)
$ErrorActionPreference = 'Stop'
$appRoot = $PSScriptRoot
$node = (Get-Command node.exe -ErrorAction Stop).Source
$nssm = (Get-Command nssm.exe -ErrorAction Stop).Source
$serviceName = 'FestivalLottery'
$log = Join-Path $appRoot 'logs\lan-setup.log'
Start-Transcript -Path $log -Force | Out-Null
try {
    $service = Get-Service -Name $serviceName -ErrorAction Stop
    if ($service.Status -ne 'Stopped') { Stop-Service -Name $serviceName; $service.WaitForStatus('Stopped', [TimeSpan]::FromSeconds(30)) }
    $backup = Join-Path $appRoot ('backups\before-access-control-' + (Get-Date -Format 'yyyyMMdd-HHmmss'))
    New-Item -ItemType Directory -Path $backup -Force | Out-Null
    Get-ChildItem -LiteralPath (Join-Path $appRoot 'data') -Filter 'lottery.sqlite*' | Copy-Item -Destination $backup
    $credentialFile = Join-Path $appRoot 'data\initial-admin.txt'
    if (!(Test-Path -LiteralPath $credentialFile)) {
        New-Item -ItemType File -Path $credentialFile | Out-Null
    }
    & icacls.exe $credentialFile /inheritance:r /grant:r "*${CredentialOwnerSid}:(F)" '*S-1-5-18:(F)' '*S-1-5-32-544:(F)' | Out-Null
    if ($LASTEXITCODE -ne 0) { throw 'Could not protect the initial credential file.' }
    & $node (Join-Path $appRoot 'scripts\bootstrap-admin.js') $credentialFile
    if ($LASTEXITCODE -ne 0) { throw 'Administrator initialization failed.' }
    & $nssm set $serviceName AppEnvironmentExtra 'NODE_ENV=production' 'PORT=3010' 'HOST=0.0.0.0' "LOTTERY_DB=$appRoot\data\lottery.sqlite"
    if ($LASTEXITCODE -ne 0) { throw 'Could not configure LAN listening.' }
    $ruleName = 'FestivalLottery-LAN-3010'
    $rule = Get-NetFirewallRule -Name $ruleName -ErrorAction SilentlyContinue
    if ($rule) { Remove-NetFirewallRule -Name $ruleName }
    New-NetFirewallRule -Name $ruleName -DisplayName 'Festival Lottery - trusted LAN' -Direction Inbound -Action Allow -Protocol TCP -LocalPort 3010 -Program $node -Profile Private,Domain -RemoteAddress LocalSubnet | Out-Null
    Start-Service -Name $serviceName
    $ready = $false
    for ($attempt = 0; $attempt -lt 20; $attempt++) {
        try {
            $response = Invoke-WebRequest 'http://localhost:3010/api/session' -UseBasicParsing -TimeoutSec 2
            if ($response.StatusCode -eq 200) { $ready = $true; break }
        } catch { Start-Sleep -Seconds 1 }
    }
    if (!$ready) { throw 'Service did not become ready. Check logs\service-error.log.' }
    Get-Service -Name $serviceName
    Get-NetTCPConnection -LocalPort 3010 -State Listen | Select-Object LocalAddress,LocalPort
    Write-Host "Backup: $backup"
    Write-Host "Initial credentials: $credentialFile"
    Write-Host 'LAN setup completed successfully.'
} finally { Stop-Transcript | Out-Null }
