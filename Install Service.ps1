#Requires -RunAsAdministrator
$ErrorActionPreference = 'Stop'
$serviceName = 'FestivalLottery'
$appRoot = $PSScriptRoot
$node = (Get-Command node.exe -ErrorAction Stop).Source
$nssm = (Get-Command nssm.exe -ErrorAction Stop).Source
$major = [int]((& $node --version).TrimStart('v').Split('.')[0])
if ($major -lt 24) { throw 'Node.js 24 or later is required.' }
if (!(Test-Path -LiteralPath "$appRoot\node_modules\exceljs")) { throw 'Run npm.cmd install first.' }
if (Get-Service -Name $serviceName -ErrorAction SilentlyContinue) {
    throw "Service $serviceName already exists. Use nssm edit $serviceName to change it."
}
$listener = [System.Net.Sockets.TcpListener]::new([System.Net.IPAddress]::Loopback, 3010)
try { $listener.Start() } finally { $listener.Stop() }
New-Item -ItemType Directory -Path "$appRoot\logs" -Force | Out-Null
function Invoke-Nssm {
    & $nssm @args
    if ($LASTEXITCODE -ne 0) { throw "NSSM failed: $args (exit $LASTEXITCODE)" }
}
Invoke-Nssm install $serviceName $node server.js
Invoke-Nssm set $serviceName AppDirectory $appRoot
Invoke-Nssm set $serviceName DisplayName 'Dashain Tihar Festival Lottery'
Invoke-Nssm set $serviceName Description 'Festival Lottery web app at http://localhost:3010'
Invoke-Nssm set $serviceName Start SERVICE_AUTO_START
Invoke-Nssm set $serviceName AppEnvironmentExtra 'NODE_ENV=production' 'PORT=3010' "LOTTERY_DB=$appRoot\data\lottery.sqlite"
Invoke-Nssm set $serviceName AppExit Default Restart
Invoke-Nssm set $serviceName AppRestartDelay 5000
Invoke-Nssm set $serviceName AppStdout "$appRoot\logs\service-out.log"
Invoke-Nssm set $serviceName AppStderr "$appRoot\logs\service-error.log"
Invoke-Nssm set $serviceName AppRotateFiles 1
Invoke-Nssm set $serviceName AppRotateOnline 1
Invoke-Nssm set $serviceName AppRotateBytes 10485760
Invoke-Nssm start $serviceName
$ready = $false
for ($attempt = 0; $attempt -lt 15; $attempt++) {
    try {
        $response = Invoke-WebRequest -Uri 'http://localhost:3010/api/session' -UseBasicParsing -TimeoutSec 2
        if ($response.StatusCode -eq 200) { $ready = $true; break }
    } catch { Start-Sleep -Seconds 1 }
}
if (!$ready) { throw 'Service did not become ready. Check logs\service-error.log.' }
Get-Service -Name $serviceName
Write-Host 'Festival Lottery is running at http://localhost:3010 and will start automatically with Windows.'
