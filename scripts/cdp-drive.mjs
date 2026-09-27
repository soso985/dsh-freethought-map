/**
 * CDP 驱动 —— 被 verify-render.ps1 调用，不直接手跑。
 *
 * 目标：回答「插件在真实浏览器里到底渲染了没有」。官方 skill 的原话是
 * 「installation and slot registration alone do not establish what the user can see」，
 * 所以这里只认**渲染后的 DOM**，不认注册成功。
 *
 * 参数：
 *   argv[2] = CDP webSocketDebuggerUrl
 *   argv[3] = origin，如 http://127.0.0.1:19388
 *   argv[4] = token
 *   argv[5] = 等待秒数
 *   argv[6] = ws 模块所在目录（宿主解包目录里有 ws，不额外装依赖）
 */
import { createRequire } from 'node:module'
import { join } from 'node:path'

const [, , wsUrl, origin, token, waitSecArg, wsModuleDir] = process.argv
const WAIT_MS = Number(waitSecArg || 18) * 1000
const PKG_NAME = 'dsh-freethought-map'
const ROOT_ATTR = 'data-freethought-map-root'
const TAB_KIND = 'freethoughtmap'

const require = createRequire(join(wsModuleDir, 'noop.js'))
const WebSocket = require('ws')

const results = []
const ok = (m) => results.push(['PASS', m])
const bad = (m) => results.push(['FAIL', m])
const info = (m) => results.push(['INFO', m])

const ws = new WebSocket(wsUrl, { perMessageDeflate: false, maxPayload: 64 * 1024 * 1024 })
let nextId = 1
const pending = new Map()

function send(method, params = {}) {
  const id = nextId++
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject })
    ws.send(JSON.stringify({ id, method, params }))
  })
}

const consoleMsgs = []
const pageErrors = []

ws.on('message', (raw) => {
  let msg
  try {
    msg = JSON.parse(raw.toString())
  } catch {
    return
  }
  if (msg.id && pending.has(msg.id)) {
    const { resolve, reject } = pending.get(msg.id)
    pending.delete(msg.id)
    if (msg.error) reject(new Error(msg.error.message))
    else resolve(msg.result)
    return
  }
  if (msg.method === 'Runtime.consoleAPICalled') {
    const text = (msg.params.args ?? [])
      .map((a) => a.value ?? a.description ?? a.unserializableValue ?? '')
      .join(' ')
    consoleMsgs.push({ type: msg.params.type, text })
  }
  if (msg.method === 'Runtime.exceptionThrown') {
    pageErrors.push(msg.params.exceptionDetails?.exception?.description ?? 'unknown exception')
  }
  if (msg.method === 'Log.entryAdded' && msg.params.entry.level === 'error') {
    pageErrors.push(msg.params.entry.text)
  }
})

const done = new Promise((resolve) => ws.on('open', resolve))
await done

await send('Runtime.enable')
await send('Log.enable')
await send('Page.enable')

// 导航（带 token，让浏览器自己完成 303 → cookie 的握手）
await send('Page.navigate', { url: `${origin}/?token=${encodeURIComponent(token)}` })

// 等界面起来：轮询直到根节点出现或超时
const deadline = Date.now() + WAIT_MS
let sawRoot = false
let probe = null

async function evaluate(expression) {
  const r = await send('Runtime.evaluate', {
    expression,
    returnByValue: true,
    awaitPromise: true,
  })
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? 'eval failed')
  return r.result?.value
}

while (Date.now() < deadline) {
  await new Promise((r) => setTimeout(r, 1000))
  try {
    probe = await evaluate(`(() => {
      const boot = globalThis.__DSH_BOOT__;
      const entries = (boot && boot.entries) || [];
      const html = document.documentElement.outerHTML || '';
      return {
        href: location.href,
        title: document.title,
        readyState: document.readyState,
        rootCount: document.querySelectorAll('[${ROOT_ATTR}]').length,
        hasLoader: typeof globalThis.__ModuleLoader__ === 'object',
        loaderMode: globalThis.__ModuleLoader__ && globalThis.__ModuleLoader__.mode,
        bootEntry: entries.some(e => e.id === ${JSON.stringify(PKG_NAME)}),
        bootCount: entries.length,
        sessionHeaders: document.querySelectorAll('[data-chat-node-key]').length,
        loginWall: html.includes('authentication required'),
      };
    })()`)
  } catch (e) {
    info(`轮询出错（继续）：${e.message}`)
    continue
  }
  if (probe.rootCount > 0) {
    sawRoot = true
    break
  }
}

if (!probe) {
  bad('页面探测始终失败')
} else {
  info(`URL: ${probe.href}`)
  info(`标题: ${probe.title}   readyState=${probe.readyState}`)
  info(`__ModuleLoader__ mode = ${probe.loaderMode}`)
  info(`__DSH_BOOT__ entries = ${probe.bootCount}`)
  info(`转录区气泡节点数 = ${probe.sessionHeaders}`)

  if (probe.loginWall) bad('页面命中登录墙（authentication required）')
  else ok('已通过门禁进入应用')

  if (probe.bootEntry) ok(`__DSH_BOOT__ 里含 ${PKG_NAME}`)
  else bad(`__DSH_BOOT__ 里不含 ${PKG_NAME}`)

  if (probe.loaderMode === undefined || probe.loaderMode === null) {
    info('__ModuleLoader__ 处于已启动状态（mode 字段已被模块系统接管）')
  } else {
    info(`__ModuleLoader__.mode = ${probe.loaderMode}`)
  }

  if (sawRoot) ok(`渲染出插件根节点 [${ROOT_ATTR}] × ${probe.rootCount} —— 探针 P1 通过`)
  else bad(`页面上没有 [${ROOT_ATTR}]（可能是无会话停在 hero，或 slot 注册没渲染）`)
}

// 控制台洁净度
const errs = consoleMsgs.filter((m) => m.type === 'error')
const clientModuleErrs = errs.filter((m) => /client-modules:|slot entry crashed|not declared/i.test(m.text))
if (errs.length === 0 && pageErrors.length === 0) {
  ok('控制台无 error')
} else {
  if (clientModuleErrs.length) {
    for (const m of clientModuleErrs.slice(0, 5)) bad(`控制台致命错误：${m.text.slice(0, 300)}`)
  }
  if (pageErrors.length) {
    for (const e of pageErrors.slice(0, 5)) bad(`未捕获异常：${String(e).slice(0, 300)}`)
  }
  const other = errs.filter((m) => !clientModuleErrs.includes(m))
  if (other.length) info(`其它 console.error ${other.length} 条（多为宿主自身/网络，非本插件）`)
}

// 注册证据：页面文本里能否看到官方右列 tab（只能在有会话时验证）
if (probe && probe.sessionHeaders > 0) {
  const tabKnown = await evaluate(`(() => {
    const t = document.body.innerText || '';
    return { hasMapTitle: t.includes('FreeThought Map'), kindInDom: !!document.querySelector('[data-sidebar-right-tab="${TAB_KIND}"]') };
  })()`)
  if (tabKnown?.hasMapTitle) ok('页面文本里出现「FreeThought Map」—— tab 已渲染')
  else info('页面文本里暂无「FreeThought Map」（tab 可能未打开；需要在会话里点一下右列入口）')
} else {
  info('当前无会话（hero 画面）：官方右列按会话挂载，插件正文不会渲染 —— 这是预期的')
}

const fails = results.filter(([s]) => s === 'FAIL')
const pad = Math.max(...results.map(([, m]) => m.length))
console.log('')
for (const [s, m] of results) console.log(`  ${s.padEnd(4)}  ${m}`)
console.log('')
console.log(`探针 P1（渲染/隔离）：${results.filter(([s]) => s === 'PASS').length} 通过 / ${fails.length} 失败`)
ws.close()
process.exit(fails.length ? 1 : 0)
