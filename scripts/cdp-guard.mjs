/**
 * 护栏验收：`cdp-panel.mjs` 的 `openSession` / `ensurePanelOpen` 不再「静默跑错会话」。
 *
 * 为什么值得专门验：摘除（阶段 1 第 3 项）是**首个破坏性操作**，验收脚本会写盘；
 * 而「跑错会话会真的写坏数据」已经有实证 —— `verify-session` 曾把测试节点写进
 * 两个**不该碰**的空白会话（`session-a203d4d1`、`session-be2bdabc`），
 * 因为那时的早退判据是「页面上有没有气泡」（与目标会话**无关**）。
 *
 * 三条要验的：
 *   a) 面板挂在**错的**会话上、且那个会话**有气泡**时 → 必须真的切过去
 *      （这是旧代码失效的确切场景：有气泡 ⇒ 直接 alreadyOpen ⇒ 根本没点）
 *   b) 目标会话不存在时 → 必须报 `ok:false`，**不许假装成功**
 *   c) 已经在正确会话 → `alreadyOpen`，不白点
 *
 * 用法：node cdp-guard.mjs <wsUrl> <wsModulePath> <sessionId>
 */
import { createRequire } from 'node:module'

const [, , WS_URL, WS_MODULE, SESSION_ID] = process.argv
const require = createRequire(WS_MODULE + '/')
const WebSocket = require(WS_MODULE)

let nextId = 1
const pending = new Map()
const ws = new WebSocket(WS_URL)
ws.on('message', (raw) => {
  let m
  try {
    m = JSON.parse(raw.toString())
  } catch {
    return
  }
  if (m.id && pending.has(m.id)) {
    const { resolve } = pending.get(m.id)
    pending.delete(m.id)
    resolve(m.result)
  }
})
function send(method, params = {}) {
  const id = nextId++
  return new Promise((resolve) => {
    pending.set(id, { resolve })
    ws.send(JSON.stringify({ id, method, params }))
    setTimeout(() => resolve(undefined), 20000)
  })
}
async function evaluate(expression) {
  const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })
  if (r && r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text)
  return r && r.result ? r.result.value : undefined
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const results = []
const ok = (m) => {
  results.push(['PASS', m])
  console.log('  PASS  ' + m)
}
const bad = (m) => {
  results.push(['FAIL', m])
  console.log('  FAIL  ' + m)
}
const info = (m) => console.log('  INFO  ' + m)

await new Promise((r) => ws.on('open', r))
await send('Runtime.enable')
await send('Page.enable')

const { createPanelOpener } = await import('./cdp-panel.mjs')
const opener = createPanelOpener(evaluate, send)

// 先随便进一个会话并确保面板挂上（用来制造"挂在错会话"的起点）
console.log('\n=== 准备：先让面板挂到一个会话上 ===')
const first = await opener.ensurePanelOpen({ sessionId: SESSION_ID, timeoutMs: 20000 })
for (const n of first.notes) info(n)
if (!first.ok) {
  bad('准备阶段就没打开面板')
  ws.close()
  process.exit(1)
}
const inSession = await opener.conversationSession()
info('当前会话 = ' + inSession)
ok('面板已挂载（how=' + first.how + '）')

// ── c) 已经在正确会话 → alreadyOpen，不白点 ─────────────────────────────
console.log('\n=== c) 会话已正确：应当 alreadyOpen（不白点）===')
{
  const r = await opener.openSession(SESSION_ID)
  info('openSession 返回：' + JSON.stringify(r))
  if (r.ok && r.alreadyOpen === true && r.switched === false) {
    ok('会话对的 → alreadyOpen，没有多余的点击')
  } else {
    bad('会话已对却还去点了（或没报 alreadyOpen）：' + JSON.stringify(r))
  }
  const r2 = await opener.ensurePanelOpen({ sessionId: SESSION_ID, timeoutMs: 8000 })
  if (r2.ok && r2.how === 'already-mounted') ok('ensurePanelOpen → already-mounted（也不白点）')
  else bad('ensurePanelOpen 没有走 already-mounted：' + JSON.stringify({ ok: r2.ok, how: r2.how }))
}

// ── a) 挂在**有气泡的**错会话上 → 必须真的切过去 ─────────────────────────
console.log('\n=== a) 制造"挂在错会话且那个会话有气泡"的场景 ===')
{
  // 找一个**有聊天记录**、且不是目标会话的会话行
  const target = await evaluate(`(() => {
    const want = ${JSON.stringify(SESSION_ID)};
    const rows = [...document.querySelectorAll('[data-row-key^="session:"]')].filter(e => e.offsetParent !== null);
    const other = rows.find(e => !(e.getAttribute('data-row-key') || '').includes(want));
    if (!other) return null;
    other.scrollIntoView({ block: 'center' });
    other.click();
    return other.getAttribute('data-row-key');
  })()`)
  if (!target) {
    info('（只有一个会话行，无法制造"错会话"场景 —— 跳过 a 的实测）')
  } else {
    info('切到另一个会话：' + target)
    // 等页面落到那个会话
    let landed = null
    for (let i = 0; i < 20; i += 1) {
      await sleep(1000)
      landed = await opener.conversationSession()
      if (landed && !String(target).includes(landed)) break // 落到了别的会话（不是目标）
      if (landed && !landed.includes(SESSION_ID.replace('session-', ''))) break
    }
    const nowSession = await opener.conversationSession()
    const bub = await opener.bubbles()
    info('现在会话 = ' + nowSession + '   气泡数 = ' + bub)
    if (nowSession === SESSION_ID) {
      info('（没能落到别的会话 —— 可能那个也行不通，跳过 a 的实测）')
    } else {
      // 关键：这时页面**有气泡**（如果那个会话有内容），旧代码会直接 alreadyOpen 不点
      const r = await opener.openSession(SESSION_ID)
      info('openSession(want) 返回：' + JSON.stringify(r))
      if (r.ok && r.switched === true && r.now === SESSION_ID) {
        ok('**真的切过去了**（旧代码在这个场景下会 alreadyOpen 不点）—— 气泡数=' + bub)
      } else if (r.ok && r.now === SESSION_ID) {
        ok('切到了目标会话（now=' + r.now + '）')
      } else {
        bad('没切到目标会话：' + JSON.stringify(r))
      }
    }
  }
}

// ── b) 目标会话不存在 → 必须 ok:false ─────────────────────────────────────
console.log('\n=== b) 目标会话不存在：必须报 ok:false（不许假装成功）===')
{
  const r = await opener.openSession('session-00000000-0000-0000-0000-000000000000', 6000)
  info('openSession(不存在的会话) 返回：' + JSON.stringify(r))
  if (r.ok === false) {
    ok('报了 ok:false（没假装成功）')
  } else {
    bad('对不存在的会话返回了 ok:true —— 正是"假装成功"的老毛病')
  }
  const r2 = await opener.ensurePanelOpen({ sessionId: 'session-00000000-0000-0000-0000-000000000000', timeoutMs: 6000 })
  info('ensurePanelOpen(不存在的会话) 返回：ok=' + r2.ok + ' how=' + r2.how)
  info('  尾部 notes：' + r2.notes.slice(-3).join(' | '))
  if (r2.ok === false) ok('ensurePanelOpen 也报 ok:false')
  else bad('ensurePanelOpen 对不存在的会话返回 ok:true')
}

// ── 收尾：切回目标会话（后面的验收要用）─────────────────────────────────
console.log('\n=== 收尾：切回目标会话 ===')
{
  const r = await opener.ensurePanelOpen({ sessionId: SESSION_ID, timeoutMs: 25000 })
  for (const n of r.notes.slice(-4)) info(n)
  if (r.ok && (await opener.panelSession()) === SESSION_ID) {
    ok('已回到目标会话，面板可用（' + r.how + '）')
  } else {
    bad('没能回到目标会话：panelSession=' + (await opener.panelSession()))
  }
}

console.log('')
const fails = results.filter(([s]) => s === 'FAIL').length
console.log(`护栏验收：${results.length - fails} 通过 / ${fails} 失败`)
ws.close()
process.exit(fails ? 1 : 0)
