<#
  # 起 headless 浏览器进应用，跑一个指定的 CDP 验收脚本。
  #
  # 与 verify-session.ps1 的分工：
  #   · verify-session.ps1 —— 跑固定的 cdp-session.mjs（会话内渲染的回归验收）
  #   · 本脚本           —— 跑**任意** CDP 脚本，给每个阶段的真机验收用
  #                        （画布阶段 1 用 cdp-annotate.mjs，以后每步一个）
  #
  # 用法：
  #   pwsh -File scripts/verify-live.ps1 -Token <token> -Script cdp-annotate.mjs `
  #        [-Port 19388] [-SessionId session-...] [-WaitSeconds 25]
  #
  # 环境变量约定（脚本自己读）：
  #   FTM_SESSION_ID —— 要打开的会话；`cdp-panel.mjs` 的 ensurePanelOpen 会用它
#>
param(
  [Parameter(Mandatory = $true)][string]$Token,
  [Parameter(Mandatory = $true)][string]$Script,
  [int]$Port = 19388,
  [string]$SessionId = '',
  [int]$WaitSeconds = 25
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

# 每个端口一个独立 profile，免得并发跑时互相踩 localStorage（autopen 标记就在那儿）
$profileDir = Join-Path $env:TEMP "ftm-live-profile-$Port"
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
  if ($SessionId) { $env:FTM_SESSION_ID = $SessionId }

  Start-Sleep -Seconds 8
  & $node (Join-Path $PSScriptRoot $Script) $wsUrl $wsModule $SessionId
  exit $LASTEXITCODE
}
finally {
  Remove-Item Env:\FTM_SESSION_ID -ErrorAction SilentlyContinue
  $new = @(Get-Process msedge, chrome -ErrorAction SilentlyContinue | Where-Object { $before -notcontains $_.Id })
  foreach ($p in $new) { try { Stop-Process -Id $p.Id -Force -ErrorAction SilentlyContinue } catch { } }
  if ($new.Count -gt 0) { Write-Host "已清理本次测试的浏览器进程：$($new.Count) 个" }
  Start-Sleep -Milliseconds 500
  Remove-Item -Recurse -Force $profileDir -ErrorAction SilentlyContinue
}
