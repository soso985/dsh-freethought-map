# 卡 1 / D1-1 验收脚本 —— 进到会话画面，确认插件面板真的渲染出来。
#
# 为什么单独一个脚本：官方右列是**按会话挂载**的，hero（未选会话）画面下插件正文
# 永远不会渲染。所以「插件到底出不出来」必须在**已选中会话**的页面上判定。
#
# 本脚本只使用**已存在的会话**（点一下侧栏里的会话行），不新建会话、不发消息，
# 因此不会产生 token 成本。
#
# 用法：
#   pwsh -File scripts/verify-session.ps1 -Token <token> [-Port 19388] [-WaitSeconds 25]

param(
  [Parameter(Mandatory = $true)][string]$Token,
  [int]$Port = 19388,
  [int]$WaitSeconds = 25,
  [switch]$KeepOpen
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

$profileDir = Join-Path $env:TEMP "ftm-session-profile-$Port"
if (Test-Path $profileDir) { Remove-Item -Recurse -Force $profileDir -ErrorAction SilentlyContinue }
New-Item -ItemType Directory -Force -Path $profileDir | Out-Null

$debugPort = $Port + 1000
$before = @(Get-Process msedge, chrome -ErrorAction SilentlyContinue | Select-Object -ExpandProperty Id)

$args = @(
  "--headless=new",
  "--disable-gpu",
  "--no-first-run",
  "--no-default-browser-check",
  "--remote-debugging-port=$debugPort",
  "--user-data-dir=`"$profileDir`"",
  "--window-size=1600,1000",
  "about:blank"
)
$proc = Start-Process -FilePath $browser -ArgumentList $args -PassThru
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

  & $node (Join-Path $PSScriptRoot 'cdp-session.mjs') $wsUrl $origin $Token $wsModule $WaitSeconds
  exit $LASTEXITCODE
}
finally {
  if (-not $KeepOpen) {
    $new = @(Get-Process msedge, chrome -ErrorAction SilentlyContinue | Where-Object { $before -notcontains $_.Id })
    foreach ($p in $new) { try { Stop-Process -Id $p.Id -Force -ErrorAction SilentlyContinue } catch { } }
    if ($new.Count -gt 0) { Write-Host "已清理本次测试的浏览器进程：$($new.Count) 个" }
    Start-Sleep -Milliseconds 500
    Remove-Item -Recurse -Force $profileDir -ErrorAction SilentlyContinue
  }
}
