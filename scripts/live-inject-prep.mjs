/**
 * 真机验证「发送前注入」的准备 + 读取工具（不发消息，只布置与读取）。
 *
 * 用法：
 *   node scripts/live-inject-prep.mjs <origin> <token> [action]
 *     action = prep   布置焦点节点 + 粉线 + pendingLinkIds（默认）
 *     action = read   只读 injections / events / 权威快照
 *     action = status 读权威概览
 *
 * 认证：先带 token 请求 `/?token=…` 拿到 HttpOnly cookie，再调 `/api/...`。
 * RPC 信封（从 dsh-client-connection 源码核对）：
 *   POST /api/<ns>/<method>
 *   { type:'client-request', rpcId:<string>, method:'<ns>/<method>', payload:{ args:{…命名参数…} } }
 */
import { randomUUID } from 'node:crypto'

const [, , ORIGIN, TOKEN, ACTION = 'prep'] = process.argv
if (!ORIGIN || !TOKEN) {
  console.error('用法：node live-inject-prep.mjs <origin> <token> [prep|read|status]')
  process.exit(2)
}

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
  if (!env || env.rpcId !== rpcId) throw new Error('rpcId 不匹配')
  return env.result // { ok:true, value } | { ok:false, error }
}

async function findSessionId() {
  // 权威存储按 sessionId 分表，但我们没有「列全部键」的端点。
  // 已知的测试会话 id 从部署记录里拿；换会话时用参数传。
  const known = process.env.FTM_SESSION_ID
  if (known) return known
  // 退化：从 storages 文件里读最后一个写入的键（本地实例，可读盘）
  const { readFileSync } = await import('node:fs')
  const file = 'C:/Users/Administrator/.dsh/storages/freethought_map.json'
  try {
    const j = JSON.parse(readFileSync(file, 'utf8'))
    const tables = j.tables || j.data || j
    const keys = Object.keys(tables.overlays || tables || {})
    if (keys.length) return keys[keys.length - 1]
  } catch (e) {
    throw new Error('读不到 storages 文件来推断会话 id：' + e.message)
  }
  throw new Error('推断不出会话 id')
}

const FOCUS_TITLE = '注入验证-焦点'
const LINK_TITLE = '注入验证-联想'
const FOCUS_BODY = '这是焦点正文，用来验证焦点摘要是否真的被注入。'
const LINK_ID = 'LINK-INJ'

const sessionId = await findSessionId()
console.log('会话：' + sessionId)

if (ACTION === 'status' || ACTION === 'prep') {
  const r = await rpc('load', { sessionId })
  if (!r.ok) {
    console.error('load 失败：' + JSON.stringify(r.error))
    process.exit(1)
  }
  const doc = r.value.doc
  console.log(
    `权威：rev=${r.value.rev}  节点=${Object.keys(doc.nodes).length}  粉线=${doc.freeLinks.length}  焦点=${doc.focusId}`,
  )
  console.log('  节点：' + Object.values(doc.nodes).map((n) => `${n.id}(${n.title || '无注解'})`).join(', '))
  console.log('  粉线：' + doc.freeLinks.map((l) => `${l.id}:${l.a}-${l.b}`).join(', ') || '（无）')

  if (ACTION === 'prep') {
    const nodes = { ...doc.nodes }
    nodes.F1 = {
      id: 'F1',
      kind: 'manual',
      parentId: null,
      position: { x: 0, y: 0 },
      title: FOCUS_TITLE,
      body: FOCUS_BODY,
    }
    nodes.F2 = { id: 'F2', kind: 'manual', parentId: null, position: { x: 0, y: 200 }, title: LINK_TITLE }
    const freeLinks = doc.freeLinks.filter((l) => l.id !== LINK_ID)
    freeLinks.push({ id: LINK_ID, a: 'F1', b: 'F2' })
    const nextDoc = { ...doc, nodes, freeLinks, focusId: 'F1' }

    const saved = await rpc('save', { sessionId, doc: nextDoc, baseRev: r.value.rev })
    if (!saved.ok || saved.value.ok !== true) {
      console.error('save 失败：' + JSON.stringify(saved).slice(0, 400))
      process.exit(1)
    }
    console.log(`已布置：焦点 F1（注解 + 正文）+ 粉线 ${LINK_ID} → 新 rev=${saved.value.rev}`)

    const pend = await rpc('setPendingLinks', { sessionId, payload: { add: [LINK_ID] } })
    console.log('setPendingLinks → ' + JSON.stringify(pend).slice(0, 200))
  }
}

if (ACTION === 'read') {
  const inj = await rpc('injections', { sessionId, sinceSeq: -1 })
  const entries = inj.ok && inj.value ? inj.value.entries : []
  console.log(`\ninjections 共 ${entries.length} 条：`)
  for (const e of entries) {
    console.log(`  [${e.type}] outcome=${e.outcome} eventId=${e.eventId}`)
    if (e.text) {
      console.log('    注入文本：')
      for (const line of String(e.text).split('\n')) console.log('      │ ' + line)
    }
    if (e.messageId) {
      console.log(
        `    messageId=${e.messageId} linkCount=${e.linkCount} skipped=${e.skippedLinks} ` +
          `insertedAt=${e.insertedAt}/${e.messageCount} snapshotKey=${e.snapshotKey}`,
      )
    }
  }
  const ev = await rpc('events', { sessionId, sinceSeq: -1 })
  const evs = ev.ok && ev.value ? ev.value.entries : []
  console.log(`\nevents 共 ${evs.length} 条：`)
  for (const e of evs.slice(-8)) {
    console.log(`  [${e.type}] eventId=${e.eventId} seq=${e.seq} outcome=${e.outcome} title=${e.title || ''}`)
  }
}
