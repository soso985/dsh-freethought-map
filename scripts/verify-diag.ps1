<#
  # 起 headless 浏览器进应用，跑一个 CDP 诊断脚本。只读，不发消息、不改状态。
  # 用法：pwsh -File scripts/verify-diag.ps1 -Token <token> -Script <脚本名> [-Port 19388]
#>
param(
  [Parameter(Mandatory = $true)][string]$Token,
  [Parameter(Mandatory = $true)][string]$Script,
  [int]$Port = 19388
)

$ErrorActionPreference = 'Stop'
$origin = "http://127.0.0.1:$Port"
$originEsc = [uri]::EscapeDataString($origin)

$candidates = @(
  "$env:ProgramFiles\Microsoft\Edge\Application\msedge.exe",
  "${env:ProgramFiles(x86)}\Microsoft\Edge\Application\msedge.exe",
  "$env:ProgramFiles\Google\Chrome\Application\chrome.exe",
  "${env:ProgramFiles(x86)}\Google\Chrome\Application\chrome.exe",
  "$env:LOCALAPPDATA\Google\Chrome\Application\chrome.exe"
)
$browser = $candidates | Where-Object { Test-Path $_ } | Select-Object -First 1
if (-not $browser) { Write-Error "找不到 Edge/Chrome"; exit 2 }

$profileDir = Join-Path $env:TEMP "ftm-diag-profile-$Port"
if (Test-Path $profileDir) { Remove-Item -Recurse -Force $profileDir -ErrorAction SilentlyContinue }
New-Item -ItemType Directory -Force -Path $profileDir | Out-Null

$debugPort = $Port + 4000
$before = @(Get-Process msedge, chrome -ErrorAction SilentlyContinue | Select-Object -ExpandProperty Id)

$proc = Start-Process -FilePath $browser -PassThru -ArgumentList @(
  "--headless=new", "--disable-gpu", "--no-first-run", "--no-default-browser-check",
  "--remote-debugging-port=$debugPort", "--user-data-dir=`"$profileDir`"",
  "--window-size=1600,1000", "about:blank"
)
Write-Host "浏览器 PID: $($proc.Id)   CDP 端口: $debugPort"

try {
  $version = $null
  for ($i = 0; $i -lt 40; $i++) {
    Start-Sleep -Milliseconds 500
    try { $version = Invoke-RestMethod -Uri "http://127.0.0.1:$debugPort/json/version" -TimeoutSec 3; break } catch { }
  }
  if (-not $version) { Write-Error "CDP 未就绪"; exit 3 }
  Write-Host "CDP 就绪: $($version.Browser)"

  $target = Invoke-RestMethod -Method Put -Uri "http://127.0.0.1:$debugPort/json/new?$originEsc%2F%3Ftoken%3D$Token" -TimeoutSec 10
  $wsUrl = $target.webSocketDebuggerUrl
  if (-not $wsUrl) { Write-Error "拿不到 webSocketDebuggerUrl"; exit 4 }

  $node = 'E:\Harness\resources\runtime\primary-runtime\dependencies\node\bin\node.exe'
  $wsModule = Join-Path $env:TEMP 'dsh-asar-extract\dsh\node_modules\ws'
  if (-not (Test-Path $wsModule)) { Write-Error "找不到 ws 模块：$wsModule"; exit 5 }

  Start-Sleep -Seconds 8
  & $node (Join-Path $PSScriptRoot $Script) $wsUrl $wsModule
  exit $LASTEXITCODE
}
finally {
  $new = @(Get-Process msedge, chrome -ErrorAction SilentlyContinue | Where-Object { $before -notcontains $_.Id })
  foreach ($p in $new) { try { Stop-Process -Id $p.Id -Force -ErrorAction SilentlyContinue } catch { } }
  if ($new.Count -gt 0) { Write-Host "已清理本次测试的浏览器进程：$($new.Count) 个" }
  Start-Sleep -Milliseconds 500
  Remove-Item -Recurse -Force $profileDir -ErrorAction SilentlyContinue
}
