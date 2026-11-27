#requires -version 5
# Mantem o bot local e o tunel SSH reverso (site na AWS) online.
# Executado pelo Agendador de Tarefas no logon e a cada 5 minutos.
$ErrorActionPreference = "SilentlyContinue"

$Root = "C:\Users\starfield\mds-bot"
$Node = "C:\Program Files\nodejs\node.exe"
$LogDir = Join-Path $Root "logs"
$Log = Join-Path $LogDir "keep-online.log"
$MaxLogBytes = 1MB

New-Item -ItemType Directory -Force -Path $LogDir | Out-Null

function Write-Log([string]$msg) {
  $line = "{0} {1}" -f (Get-Date -Format "yyyy-MM-dd HH:mm:ss"), $msg
  Add-Content -Path $Log -Value $line -Encoding UTF8
}

if ((Test-Path $Log) -and ((Get-Item $Log).Length -gt $MaxLogBytes)) {
  Move-Item -Path $Log -Destination "$Log.old" -Force
}

$Ssh = "C:\Windows\System32\OpenSSH\ssh.exe"
if (-not (Test-Path $Ssh)) {
  $cmd = Get-Command ssh.exe -ErrorAction SilentlyContinue
  if ($cmd) { $Ssh = $cmd.Source }
}

function Test-BotRunning {
  $conn = Get-NetTCPConnection -LocalPort 3000 -State Listen -ErrorAction SilentlyContinue
  return [bool]$conn
}

function Test-TunnelRunning {
  $procs = Get-CimInstance Win32_Process -Filter "Name='ssh.exe'" -ErrorAction SilentlyContinue
  foreach ($p in $procs) {
    if ($p.CommandLine -and $p.CommandLine -match "127\.0\.0\.1:3000:127\.0\.0\.1:3000") { return $true }
  }
  return $false
}

if (-not (Test-BotRunning)) {
  Write-Log "Bot offline na porta 3000. Iniciando..."
  $stamp = Get-Date -Format "yyyyMMdd-HHmmss"
  Start-Process -FilePath $Node -ArgumentList "." -WorkingDirectory $Root -WindowStyle Hidden `
    -RedirectStandardOutput (Join-Path $LogDir "bot-$stamp.out.log") `
    -RedirectStandardError (Join-Path $LogDir "bot-$stamp.err.log")
  Start-Sleep -Seconds 25
  if (Test-BotRunning) { Write-Log "Bot iniciado com sucesso." } else { Write-Log "ERRO: bot nao subiu na porta 3000." }
}

if (-not (Test-TunnelRunning)) {
  Write-Log "Tunel SSH offline. Iniciando..."
  $sshArgs = @(
    "-N",
    "-o", "ExitOnForwardFailure=yes",
    "-o", "ServerAliveInterval=20",
    "-o", "ServerAliveCountMax=3",
    "-o", "TCPKeepAlive=yes",
    "-o", "BatchMode=yes",
    "-o", "StrictHostKeyChecking=accept-new",
    "-R", "127.0.0.1:3000:127.0.0.1:3000",
    "3.12.169.220"
  )
  Start-Process -FilePath $Ssh -ArgumentList $sshArgs -WindowStyle Hidden
  Start-Sleep -Seconds 6
  if (Test-TunnelRunning) { Write-Log "Tunel iniciado com sucesso." } else { Write-Log "ERRO: tunel nao iniciou." }
}
