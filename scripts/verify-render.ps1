# 探针 P1 验收脚本 —— 用真实浏览器（Edge/Chromium）打开隔离实例，判定插件**是否真的渲染**。
#
# 为什么需要它：官方 skill 明确写了「安装与 slot 注册成立，不等于用户看得见」
# （cordis-plugin-development/SKILL.md:21）。verify-boot.mjs 只能证明 bundle 送到了，
# 证明不了 DOM 里长出了东西。这个脚本用 CDP 直接读渲染后的 DOM。
#
# 判定三件事：
#   1. 页面里出现本插件的根节点 [data-freethought-map-root]（= slot 注册真的渲染了）
#   2. 控制台没有 error 级消息（尤其是 client-modules: / slot entry crashed）
#   3. 右侧停靠列的 tab 类型已注册（用官方 slot 目录或页面文本核对）
#
# 用法：
#   pwsh -File scripts/verify-render.ps1 -Token <token> [-Port 19388] [-KeepOpen]
#
# 注意：面板正文只有在**选中会话界面**时才会渲染（官方右列按会话挂载）。
#       若页面停在 hero（无会话），本脚本会如实报「根节点未出现（可能是无会话）」。

param(
  [Parameter(Mandatory = $true)][string]$Token,
  [int]$Port = 19388,
  [switch]$KeepOpen,
  [int]$WaitSeconds = 18
)

$ErrorActionPreference = 'Stop'
$origin = "http://127.0.0.1:$Port"
$originEsc = [uri]::EscapeDataString($origin)

# ── 找浏览器 ──────────────────────────────────────────────────────────────
$candidates = @(
  "$env:ProgramFiles\Microsoft\Edge\Application\msedge.exe",
  "${env:ProgramFiles(x86)}\Microsoft\Edge\Application\msedge.exe",
  "$env:ProgramFiles\Google\Chrome\Application\chrome.exe",
  "${env:ProgramFiles(x86)}\Google\Chrome\Application\chrome.exe",
  "$env:LOCALAPPDATA\Google\Chrome\Application\chrome.exe"
)
$browser = $candidates | Where-Object { Test-Path $_ } | Select-Object -First 1
if (-not $browser) { Write-Error "找不到 Edge/Chrome 可执行文件"; exit 2 }
Write-Host "浏览器: $browser"

# ── 独立 user-data-dir（不碰用户真实浏览器配置） ───────────────────────────
$profileDir = Join-Path $env:TEMP "ftm-verify-profile-$Port"
if (Test-Path $profileDir) { Remove-Item -Recurse -Force $profileDir -ErrorAction SilentlyContinue }
New-Item -ItemType Directory -Force -Path $profileDir | Out-Null

$debugPort = $Port + 1000
Write-Host "CDP 端口: $debugPort   用户目录: $profileDir"

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
Write-Host "浏览器 PID: $($proc.Id)"

try {
  # ── 等 CDP 就绪 ─────────────────────────────────────────────────────────
  $version = $null
  for ($i = 0; $i -lt 40; $i++) {
    Start-Sleep -Milliseconds 500
    try { $version = Invoke-RestMethod -Uri "http://127.0.0.1:$debugPort/json/version" -TimeoutSec 3; break } catch { }
  }
  if (-not $version) { Write-Error "CDP 未就绪"; exit 3 }
  Write-Host "CDP 就绪: $($version.Browser)"

  # ── 开新标签页 ──────────────────────────────────────────────────────────
  # 先把 token 换成 cookie：token 端点会 303，浏览器自己会跟；直接开带 token 的 URL 即可。
  $target = Invoke-RestMethod -Method Put -Uri "http://127.0.0.1:$debugPort/json/new?$originEsc%2F%3Ftoken%3D$Token" -TimeoutSec 10
  $wsUrl = $target.webSocketDebuggerUrl
  if (-not $wsUrl) { Write-Error "拿不到 webSocketDebuggerUrl"; exit 4 }
  Write-Host "标签页: $($target.id)"

  # ── 用 Node + ws 跑 CDP ─────────────────────────────────────────────────
  $node = 'E:\Harness\resources\runtime\primary-runtime\dependencies\node\bin\node.exe'
  $wsModule = Join-Path $env:TEMP 'dsh-asar-extract\dsh\node_modules\ws'
  if (-not (Test-Path $wsModule)) { Write-Error "找不到 ws 模块：$wsModule（需要先解包 app.asar）"; exit 5 }

  $driver = Join-Path $PSScriptRoot 'cdp-drive.mjs'
  & $node $driver $wsUrl $origin $Token $WaitSeconds $wsModule
  $exit = $LASTEXITCODE
  exit $exit
}
finally {
  if (-not $KeepOpen) {
    try { Stop-Process -Id $proc.Id -Force -ErrorAction SilentlyContinue } catch { }
    Start-Sleep -Milliseconds 400
    Get-Process msedge, chrome -ErrorAction SilentlyContinue |
      Where-Object { $_.Path -and $_.StartTime -gt (Get-Date).AddMinutes(-5) } |
      ForEach-Object { try { Stop-Process -Id $_.Id -Force -ErrorAction SilentlyContinue } catch { } }
  }
}
