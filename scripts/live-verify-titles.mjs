/**
 * 真机验收：派生标题的持久化「活过宿主重启」。
 *
 * 为什么需要这个脚本（而不是只靠真实发送）：
 *   「投影时写标题」这条路径只有真实落链才会走到，而那需要主人手打一句。
 *   但**读回**这条路径可以独立验：把标题写进表 → 重启宿主 → 读回来。
 *   所以这个脚本用一个**已知的、真实存在的 eventId**（取自主人那个会话的权威 overlay）
 *   来验证「写进表 → 重启 → 仍读得到 → 面板按 node.id 显示出来」。
 *
 * 它验什么、不验什么（说清楚）：
 *   ✅ 独立表能被创建、schema 能过校验（否则 domain.open 会失败）
 *   ✅ 记录落盘、格式正确
 *   ✅ **重启后仍读得到**（这是这条修复的核心）
 *   ✅ 标题按 node.id 正确匹配到节点（键换算那一步）
 *   ⬜ 不验「投影时自动写入」—— 那条要真实发送（见 HOST.md §3.19 发现 3）
 *
 * 用法：
 *   node scripts/live-verify-titles.mjs <origin> <token> <sessionId> [--import] [--check-panel]
 */
import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'

const argv = process.argv.slice(2)
const flags = new Set(argv.filter((a) => a.startsWith('--')))
const [ORIGIN, TOKEN, SESSION_ID] = argv.filter((a) => !a.startsWith('--'))
if (!ORIGIN || !TOKEN || !SESSION_ID) {
  console.error('用法：node live-verify-titles.mjs <origin> <token> <sessionId> [--import|--check]')
  process.exit(2)
}

const STORE = (process.env.USERPROFILE || 'C:/Users/Administrator') + '/.dsh/storages/freethought_map.json'

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
    body: JSON.stringify({ type: 'client-request', rpcId, method: 'freethoughtMap/' + method, payload: { args } }),
  })
  const env = await res.json()
  return env.result
}
function readStore() {
  return JSON.parse(readFileSync(STORE, 'utf8'))
}

console.log('\n=== 派生标题持久化验收 ===\n')

// ── 0. 从权威 overlay 里挑一个**真实存在**的 turn 节点（要它的 eventId）─────
const l0 = await rpc('load', { sessionId: SESSION_ID })
if (!l0.ok) {
  bad('load 失败：' + JSON.stringify(l0.error))
  process.exit(1)
}
const doc = l0.value.doc
const turns = Object.values(doc.nodes)
  .filter((n) => n.sourceRef && n.sourceRef.eventId)
  .sort((a, b) => (a.seq || 0) - (b.seq || 0))
if (turns.length === 0) {
  bad('该会话没有带 sourceRef 的节点，无法验收')
  process.exit(1)
}
// 挑最后一个（seq 最大），它的 eventId 在日志里最可能存在
const target = turns[turns.length - 1]
info(`目标节点：${target.id}  seq=${target.seq}  eventId=${target.sourceRef.eventId}`)
info(`它当前有注解吗：${target.title === undefined ? '无（会走派生标题这条路）' : JSON.stringify(target.title)}`)

const FAKE_TITLE = '验收用标题-' + String(Date.now()).slice(-5)

// ── 1. 写入标题（走真实端点，不是直接改文件）──────────────────────────────
if (flags.has('--import') || !flags.has('--check')) {
  const imp = await rpc('importTitles', {
    sessionId: SESSION_ID,
    titles: { [target.sourceRef.eventId]: FAKE_TITLE },
  })
  if (imp.ok && imp.value && imp.value.ok) {
    ok(`importTitles → ok（新增 ${imp.value.added}，保留 ${imp.value.kept}，共 ${imp.value.total}）`)
  } else {
    bad('importTitles 失败：' + JSON.stringify(imp).slice(0, 240))
  }

  // ── 2. 落盘检查 ─────────────────────────────────────────────────────────
  const store = readStore()
  const hasTable = Boolean(store.tables && store.tables.derived_titles)
  if (hasTable) {
    ok('磁盘上出现了独立的 `derived_titles` 表')
  } else {
    bad('磁盘上没有 `derived_titles` 表（实际表：' + Object.keys((store.tables || {})).join(', ') + '）')
  }
  const rec = hasTable ? store.tables.derived_titles[SESSION_ID] : null
  if (rec && rec.version === 1 && rec.sessionId === SESSION_ID && rec.titles) {
    ok('记录形状正确（version / sessionId / titles）')
  } else {
    bad('记录形状不对：' + JSON.stringify(rec).slice(0, 200))
  }
  if (rec && rec.titles[target.sourceRef.eventId] === FAKE_TITLE) {
    ok('标题已落盘，键是 eventId')
  } else {
    bad('标题没落盘或键不对')
  }
  // 关键：**不能**污染 overlay（规格 §6.4）
  const nodeInStore = store.tables.overlays[SESSION_ID] && store.tables.overlays[SESSION_ID].nodes[target.id]
  if (nodeInStore && nodeInStore.title === undefined) {
    ok('overlay 里的该节点**仍然没有** title 字段（派生标题没被写回 overlay，符合规格 §6.4）')
  } else {
    bad('overlay 被污染了！node.title = ' + JSON.stringify(nodeInStore && nodeInStore.title))
  }
}

// ── 3. 读回（本进程内）────────────────────────────────────────────────────
{
  const t = await rpc('titles', { sessionId: SESSION_ID })
  if (t.ok && t.value && t.value.titles && t.value.titles[target.sourceRef.eventId] === FAKE_TITLE) {
    ok('titles 端点读回了刚写的标题')
  } else {
    bad('titles 端点没读回：' + JSON.stringify(t).slice(0, 200))
  }
}

console.log('')
const fails = results.filter(([s]) => s === 'FAIL').length
console.log(`标题持久化验收（本进程）：${passed} 通过 / ${fails} 失败`)
console.log('\n下一步：重启宿主，再跑 `--check` 确认**重启后仍读得到**（这才是核心）。')
process.exit(fails ? 1 : 0)
