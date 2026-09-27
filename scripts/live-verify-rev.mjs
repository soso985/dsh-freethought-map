/**
 * 真机验证 P0 的**保护面**：拿着 stale baseRev 提交，会不会覆盖投影？
 *
 * 这是规格 §9.0 的两条配套约束的实测：
 *   1. 权威变了之后，stale 提交必须被 **conflict** 挡住（否则全量替换会覆盖投影）
 *   2. 按权威 rev 重放意图后再提交，必须**成功**且**不丢投影节点**
 *
 * 不烧 token（纯 RPC）。不改产品代码。
 *
 * 用法：
 *   node scripts/live-verify-rev.mjs <origin> <token> <sessionId>
 */
import { randomUUID } from 'node:crypto'

const [, , ORIGIN, TOKEN, SESSION_ID] = process.argv
if (!ORIGIN || !TOKEN || !SESSION_ID) {
  console.error('用法：node live-verify-rev.mjs <origin> <token> <sessionId>')
  process.exit(2)
}

const results = []
let passed = 0
const ok = (m) => {
  passed += 1
  results.push(['PASS', m])
  console.log('  PASS  ' + m)
}
const bad = (m) => {
  results.push(['FAIL', m])
  console.log('  FAIL  ' + m)
}
const info = (m) => console.log('  INFO  ' + m)

let cookie = null
async function ensureCookie() {
  if (cookie) return cookie
  const res = await fetch(`${ORIGIN}/?token=${encodeURIComponent(TOKEN)}`, { redirect: 'manual' })
  const sc = res.headers.getSetCookie ? res.headers.getSetCookie() : []
  const raw = sc.length ? sc : [res.headers.get('set-cookie')].filter(Boolean)
  cookie = raw.map((c) => String(c).split(';')[0]).join('; ')
  if (!cookie) throw new Error('拿不到认证 cookie（HTTP ' + res.status + '）')
  return cookie
}
async function rpc(method, args = {}) {
  const c = await ensureCookie()
  const rpcId = randomUUID()
  const res = await fetch(`${ORIGIN}/api/freethoughtMap/${method}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie: c },
    body: JSON.stringify({
      type: 'client-request',
      rpcId,
      method: 'freethoughtMap/' + method,
      payload: { args },
    }),
  })
  const env = await res.json()
  return env.result
}

console.log('\n=== P0 保护面真机验证 ===\n')

// ── 0. 读当前权威 ──────────────────────────────────────────────────────────
const l0 = await rpc('load', { sessionId: SESSION_ID })
if (!l0.ok) {
  bad('load 失败：' + JSON.stringify(l0.error))
  process.exit(1)
}
const doc0 = l0.value.doc
const rev0 = l0.value.rev
const nodes0 = Object.keys(doc0.nodes).length
info(`当前权威：rev=${rev0}  nodes=${nodes0}  focus=${doc0.focusId}`)

// ── 1. 模拟"面板加载了旧版本"：把 rev 往前退一格的状态当成客户端的 baseRev ──
//
// 做法：用 baseRev = rev0 - 1 提交一份**故意的旧 doc**（只含前若干节点），
// 这精确模拟"投影刚落链、面板还拿着旧 doc"的那次提交。
const staleBaseRev = rev0 - 1
if (staleBaseRev < 0) {
  bad(`rev0=${rev0}，没法构造 stale 场景（需要至少 1 次投影）`)
  process.exit(1)
}

// 构造一份"少一个节点"的旧 doc（模拟面板没看到最新投影）
const ids = Object.keys(doc0.nodes)
const droppedId = ids[ids.length - 1]
const staleNodes = { ...doc0.nodes }
delete staleNodes[droppedId]
const staleDoc = { ...doc0, nodes: staleNodes }

info(`构造 stale 提交：baseRev=${staleBaseRev}（当前 ${rev0}），少一个节点 ${droppedId}`)

const r1 = await rpc('save', { sessionId: SESSION_ID, doc: staleDoc, baseRev: staleBaseRev })
if (!r1.ok) {
  bad('save RPC 本身失败：' + JSON.stringify(r1.error))
} else if (r1.value.status === 'conflict') {
  ok(`stale 提交被 **conflict** 挡住（返回权威 rev=${r1.value.rev}）—— 投影不会被覆盖`)
} else if (r1.value.status === 'ok') {
  bad(
    `**stale 提交被接受了**（status=ok）—— 投影已被覆盖！` +
      `rev 现在是 ${r1.value.rev}，节点数 ${Object.keys(r1.value.doc.nodes).length}`,
  )
} else {
  bad('stale 提交返回了非预期状态：' + JSON.stringify(r1.value).slice(0, 200))
}

// ── 2. 确认权威**没有**被那一次 stale 提交改动 ─────────────────────────────
const l1 = await rpc('load', { sessionId: SESSION_ID })
const nodesAfterStale = Object.keys(l1.value.doc.nodes).length
if (l1.value.rev === rev0 && nodesAfterStale === nodes0) {
  ok(`被拒之后权威原封不动（rev=${l1.value.rev}  nodes=${nodesAfterStale}）`)
} else {
  bad(`权威被动了！rev ${rev0}→${l1.value.rev}，nodes ${nodes0}→${nodesAfterStale}`)
}

// ── 3. 按权威 rev 重放意图后再提交 —— 必须成功，且**一个投影都不丢** ────────
const targetNode = ids.find((id) => id !== doc0.focusId) || ids[0]
const rebased = { ...l1.value.doc, focusId: targetNode }
const r2 = await rpc('save', { sessionId: SESSION_ID, doc: rebased, baseRev: l1.value.rev })
if (r2.ok && r2.value.status === 'ok') {
  ok(`按权威 rev 重放后再提交 → ok（rev=${r2.value.rev}）`)
} else {
  bad('重放提交失败：' + JSON.stringify(r2.value || r2.error).slice(0, 240))
}

const l2 = await rpc('load', { sessionId: SESSION_ID })
const finalNodes = Object.keys(l2.value.doc.nodes)
const lost = ids.filter((id) => !finalNodes.includes(id))
if (lost.length === 0) {
  ok(`**投影一个都没丢**（${finalNodes.length} 个节点全在；焦点已改成 ${l2.value.doc.focusId}）`)
} else {
  bad(`丢了 ${lost.length} 个节点：${lost.join(', ')}`)
}
if (l2.value.doc.focusId === targetNode) {
  ok('重放的意图生效了（focusId = ' + targetNode + '）')
} else {
  bad(`意图没生效：focusId=${l2.value.doc.focusId}，期望 ${targetNode}`)
}

// ── 4. rev 单调性：两次成功写入之后 rev 应当比开始时大 ──────────────────────
if (l2.value.rev > rev0) {
  ok(`rev 单调递增：${rev0} → ${l2.value.rev}（两次成功写入）`)
} else {
  bad(`rev 没有递增：${rev0} → ${l2.value.rev}`)
}

console.log('')
const fails = results.filter(([s]) => s === 'FAIL').length
console.log(`P0 保护面验证：${passed} 通过 / ${fails} 失败`)
process.exit(fails ? 1 : 0)
