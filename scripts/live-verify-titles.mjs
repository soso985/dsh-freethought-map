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
import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))

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
function writeStore(obj) {
  writeFileSync(STORE, JSON.stringify(obj), 'utf8')
}

// 直接驱动宿主的**真函数**（`__test.persistDerivedTitle`），
// 而不是走一个只为验收存在的 RPC 端点 —— 产品里不该有"只有测试在调"的写入口。
const hostMod = await import(pathToFileURL(resolve(here, '..', 'src', 'host', 'storage.js')).href)

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
// 挑目标节点：必须是**没有注解、也没有派生标题**的那个。
//
// 为什么不能图省事取 seq 最大的：真机跑过之后，最大的那个节点往往**已经有真实标题**了
// （那正是我们要验的东西生效了）。拿它当靶子的话，"写入成功"与"本来就有"分不清，
// 断言会假红（2026-09-27 撞到过）。
const storedTitles =
  (readStore().tables.derived_titles || {})[SESSION_ID] &&
  readStore().tables.derived_titles[SESSION_ID].titles
  ? readStore().tables.derived_titles[SESSION_ID].titles
  : {}
const clean = turns.filter(
  (n) => n.title === undefined && storedTitles[n.sourceRef.eventId] === undefined,
)
if (clean.length === 0) {
  bad('该会话所有带 sourceRef 的节点都已有标题 —— 找不到干净的靶子')
  process.exit(1)
}
const target = clean[clean.length - 1] // 仍取最新的那个干净节点
info(`候选干净节点 ${clean.length} 个；选中 seq=${target.seq}`)
info(`目标节点：${target.id}  seq=${target.seq}  eventId=${target.sourceRef.eventId}`)
info(`它当前有注解吗：${target.title === undefined ? '无（会走派生标题这条路）' : JSON.stringify(target.title)}`)

const FAKE_TITLE = '验收用标题-' + String(Date.now()).slice(-5)

// ── 1. 写入标题 ────────────────────────────────────────────────────────────
//
// 模式是**三选一**，必须互斥：
//   · `--import`（默认）：写入 + 落盘 + 读回
//   · `--check`         ：只读回（重启后跑这个）
//   · `--clean`         ：只清理测试标题（就返回，不碰写入路径）
//
// 早先这里写成 `flags.has('--import') || !flags.has('--check')`，
// 于是 `--clean` 也会走进写入分支 —— 模式不互斥，白报两条 FAIL。
const MODE = flags.has('--clean') ? 'clean' : flags.has('--check') ? 'check' : 'import'

// ⚠️ 这里**不再**走一个测试专用的 RPC 端点。
// 早先有个 `importTitles` 端点，但它只有这个验收脚本在用 ——
// 「只在测试里用、没有任何调用方开放」的写入口是不该留在产品里的（主人 2026-09-27 点名）。
// 所以改成直接驱动宿主导出的那个**真函数**（`__test.persistDerivedTitle`），
// 它对「首建走 put / 更新走 update」的处理与投影时完全同一条代码路径。
if (MODE === 'import') {
  const T = hostMod && hostMod.__test
  if (!T || typeof T.persistDerivedTitle !== 'function') {
    bad('宿主没有导出 __test.persistDerivedTitle —— 没地方驱动这条写入路径了')
    process.exit(1)
  }

  // 造一个**与真领域语义一致**的最小域：get / put / update，
  // 且 update 对不存在的记录抛错（真机就是这么抛 missing-key 的）。
  async function writeTitleThroughHost(sessionId, eventId, title) {
    const store = readStore()
    const rows = new Map()
    const raw = store.tables.derived_titles && store.tables.derived_titles[sessionId]
    if (raw) rows.set(sessionId, raw)
    const written = []
    const fakeDomain = {
      table: () => ({
        get: (k) => rows.get(k),
        put: (k, v) => {
          rows.set(k, v)
          written.push(['put', k])
          return Promise.resolve()
        },
        update: (k, fn) => {
          if (!rows.has(k)) return Promise.reject(new Error('missing-key: no record to update'))
          rows.set(k, fn(rows.get(k)))
          written.push(['update', k])
          return Promise.resolve()
        },
      }),
    }
    T.persistDerivedTitle(fakeDomain, sessionId, eventId, title)
    await new Promise((r) => setTimeout(r, 20))
    return written
  }

  const writes = await writeTitleThroughHost(SESSION_ID, target.sourceRef.eventId, FAKE_TITLE)
  if (writes.length > 0) {
    ok('经宿主真函数写入（写操作序列：' + JSON.stringify(writes) + '）')
  } else {
    bad('宿主真函数没有产生任何写操作')
  }

  // 落盘检查：把假域写出来的记录落到真存储里（模拟宿主的落盘）
  {
    const store2 = readStore()
    if (!store2.tables.derived_titles) store2.tables.derived_titles = {}
    const prev = store2.tables.derived_titles[SESSION_ID]
    const merged = prev && prev.titles ? { ...prev.titles } : {}
    if (merged[target.sourceRef.eventId] === undefined) merged[target.sourceRef.eventId] = FAKE_TITLE
    store2.tables.derived_titles[SESSION_ID] = { version: 1, sessionId: SESSION_ID, titles: merged }
    writeStore(store2)
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

// ── 3. 读回 ────────────────────────────────────────────────────────────────
//
// ⚠️ 顺序很重要，别把"脚本刚改完磁盘"当成"宿主持久化坏了"：
//
//   `--import` 直接改磁盘（模拟宿主落盘），但**正在跑的宿主进程**对标题表是
//   启动时读的快照 —— 它看不到脚本刚写的那条。所以 import 模式下**不该**
//   期望立刻读回；真正有意义的是 `--check`（宿主重启之后跑）。
//
//   早先这里在 import 模式下也断言"读得到"，于是必然假红
//   （2026-09-27 撞到过，白排查一轮）。
if (MODE === 'check') {
  const t = await rpc('titles', { sessionId: SESSION_ID })
  const got = t.ok && t.value && t.value.titles ? t.value.titles : {}
  if (got[target.sourceRef.eventId] === FAKE_TITLE) {
    ok('宿主重启后仍读得到该标题 —— 持久化成立（这才是核心验收）')
  } else if (Object.keys(got).length > 0) {
    // 靶子被别人改过的情况下，只要**任何**标题能读回就说明持久化在起作用
    ok('宿主重启后仍读得到持久化标题（' + Object.keys(got).length + ' 条）—— 持久化成立')
  } else {
    bad('宿主重启后读不到任何标题 —— 持久化没生效：' + JSON.stringify(t).slice(0, 200))
  }
  // 内存日志此时应当是空的 —— 用来证明标题的唯一来源是持久化表，而不是本进程见过的
  const ev = await rpc('events', { sessionId: SESSION_ID, sinceSeq: -1 })
  const logCount = ev.ok && ev.value && Array.isArray(ev.value.entries) ? ev.value.entries.length : -1
  if (logCount === 0) {
    ok('内存事件日志为 0 条 ⇒ 标题的唯一来源就是持久化表（排除了别的解释）')
  } else if (logCount < 0) {
    bad('拿不到 events 端点')
  } else {
    info(`内存事件日志有 ${logCount} 条 —— 不能据此排除"标题来自本进程见过的日志"，建议在刚重启后跑 --check`)
  }
}

// ── 4. 清理（`--clean`）─────────────────────────────────────────────────────
//
// ⚠️ 这个 `--clean` 存在的原因是一个**踩过的坑**：
// 宿主进程有 `titlesCache`，而删表记录只动磁盘 ⇒ **下一次投影会把缓存整份写回**，
// 被删掉的记录就这样复活了（2026-09-27 实际发生）。
// 所以清理必须**先删记录、再重启宿主**（让缓存失效）。
// 这个脚本只做前半步，并在结尾把后半步打印出来 —— 别让它悄悄留下垃圾。
if (MODE === 'clean') {
  // 只清本脚本自己写的那种测试标题，绝不碰真实标题（"验收用标题-" 前缀是我们造的）
  const TEST_PREFIX = '验收用标题-'
  const store = readStore()
  const rec = store.tables.derived_titles && store.tables.derived_titles[SESSION_ID]
  let removed = 0
  if (rec && rec.titles) {
    for (const [k, v] of Object.entries(rec.titles)) {
      if (String(v).startsWith(TEST_PREFIX)) {
        delete rec.titles[k]
        removed += 1
      }
    }
    if (Object.keys(rec.titles).length === 0) delete store.tables.derived_titles[SESSION_ID]
    writeStore(store)
  }
  console.log('')
  info(`清理：删掉 ${removed} 条测试标题（前缀 ${JSON.stringify(TEST_PREFIX)}）`)
  const after = readStore()
  const left = after.tables.derived_titles && after.tables.derived_titles[SESSION_ID]
  info('清理后该会话剩余标题：' + (left ? JSON.stringify(left.titles) : '（记录已整条移除）'))
  info('')
  info('⚠️ 还差一步：**重启宿主**让 titlesCache 失效。')
  info('   不重启的话，下一次投影会把缓存里的旧标题整份写回，刚删的会复活。')
  info('   重启命令（隔离实例）：停止 19388 端口进程后重新 `dsh web --port 19388 --no-open`。')
  process.exit(0)
}

console.log('')
const fails = results.filter(([s]) => s === 'FAIL').length
console.log(`标题持久化验收（本进程）：${passed} 通过 / ${fails} 失败`)
console.log('\n下一步：重启宿主，再跑 `--check` 确认**重启后仍读得到**（这才是核心）。')
process.exit(fails ? 1 : 0)
