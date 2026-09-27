<#
  # 真机验证「发送前注入」—— 起一个隔离的 headless 浏览器，进会话，发一句话，读回注入内容。
  #
  # ⚠️ 本脚本会**真实发送一条消息**，因而消耗 token。不进任何自动回归。
  #
  # 用法：
  #   pwsh -File scripts/verify-inject-live.ps1 -SessionId <id> -Token <token> [-Port 19388] [-WaitSeconds 120]
#>
param(
  [Parameter(Mandatory = $true)][string]$SessionId,
  [Parameter(Mandatory = $true)][string]$Token,
  [int]$Port = 19388,
  [int]$WaitSeconds = 120
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

$profileDir = Join-Path $env:TEMP "ftm-inject-profile-$Port"
if (Test-Path $profileDir) { Remove-Item -Recurse -Force $profileDir -ErrorAction SilentlyContinue }
New-Item -ItemType Directory -Force -Path $profileDir | Out-Null

$debugPort = $Port + 2000
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

  # 进会话画面（插件面板要挂载出来，输入框才会在会话上下文里）
  #
  # ⚠️ cdp-drive.mjs 的参数顺序是：wsUrl origin token 等待秒数 ws模块目录
  #    （五个都要给；少给一个会让「等待秒数」被当成模块目录，报 MODULE_NOT_FOUND）
  Write-Host "`n=== 先进入会话画面 ==="
  & $node (Join-Path $PSScriptRoot 'cdp-drive.mjs') $wsUrl $origin $Token 15 $wsModule 2>&1 | Select-Object -Last 8

  $env:FTM_ORIGIN = $origin
  $env:FTM_TOKEN = $Token
  $env:FTM_WAIT_MS = [string]($WaitSeconds * 1000)

  # ⚠️ 自动「打字 + 提交」这一步**已被放弃**（原因见 docs/HOST.md §3.18 的实测记录）：
  # 官方 composer 是 Lexical 编辑器，自动化输入与提交极难做对，
  # 而做不对时是**静默失败**（按钮看起来可点、disabled=false，但 onClick 不触发，
  # 输入框也不清空）—— 排查成本远高于收益。
  #
  # 所以本脚本只负责「起浏览器 + 进会话」。发送请人工完成：
  #   1. 打开 http://127.0.0.1:<Port>/?token=<Token>（或让本脚本 -KeepOpen）
  #   2. 在官方输入框里手打一句话并发送
  #   3. 运行：node scripts/live-inject-prep.mjs <origin> <token> read
  #      → 即可看到宿主记录的「这一轮注入了什么」
  Write-Host ""
  Write-Host "浏览器已就绪。请在界面里手打一句话并发送，然后运行："
  Write-Host "  node scripts/live-inject-prep.mjs $origin $Token read"
  Write-Host ""
  Write-Host "（本脚本不自动发送：自动化提交在 Lexical 上不可靠，会静默失败）"
  exit 0
}
finally {
  $new = @(Get-Process msedge, chrome -ErrorAction SilentlyContinue | Where-Object { $before -notcontains $_.Id })
  foreach ($p in $new) { try { Stop-Process -Id $p.Id -Force -ErrorAction SilentlyContinue } catch { } }
  if ($new.Count -gt 0) { Write-Host "已清理本次测试的浏览器进程：$($new.Count) 个" }
  Start-Sleep -Milliseconds 500
  Remove-Item -Recurse -Force $profileDir -ErrorAction SilentlyContinue
}
