/**
 * 诊断：面板的派生标题为什么是空的。只读，不发送、不改状态。
 *
 * 用法：node cdp-panel-diag.mjs <wsUrl> <wsModulePath>
 */
import { createRequire } from 'node:module'

const [, , WS_URL, WS_MODULE] = process.argv
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

await new Promise((r) => ws.on('open', r))
await send('Runtime.enable')
await send('Log.enable')

// 进会话
let bubbles = await evaluate(`document.querySelectorAll('[data-chat-node-key]').length`)
if (bubbles === 0) {
  await evaluate(`(() => {
    const rows = [...document.querySelectorAll('[data-row-key^="session:"]')].filter(e => e.offsetParent !== null);
    const row = rows.find(e => (e.getAttribute('data-row-key')||'').includes('4f108796')) || rows[0];
    if (row) { row.scrollIntoView({block:'center'}); row.click(); }
    return true;
  })()`)
  const dl = Date.now() + 30000
  while (Date.now() < dl) {
    await sleep(1000)
    bubbles = await evaluate(`document.querySelectorAll('[data-chat-node-key]').length`)
    if (bubbles > 0) break
  }
}
console.log('气泡数: ' + bubbles)

// 打开我们的 tab（如果没挂载）
await sleep(1500)

// ── 1. 面板里每行显示的标题 ────────────────────────────────────────────────
const rows = await evaluate(`(() => {
  const root = document.querySelector('[data-freethought-map-root]');
  if (!root) return { hasRoot: false };
  const items = [...root.querySelectorAll('[data-ftm-node]')].map(li => ({
    node: li.getAttribute('data-ftm-node'),
    kind: li.getAttribute('data-ftm-kind'),
    title: (li.querySelector('.ftm-chain-title')||{}).textContent || '',
    indent: li.style.paddingLeft || '',
  }));
  return { hasRoot: true, chainCount: root.getAttribute('data-ftm-chain'), items };
})()`)
console.log('\n面板链行：' + JSON.stringify(rows, null, 2))

// ── 2. 直接打宿主两个端点，看数据源本身有没有 ──────────────────────────────
const probe = await evaluate(`(async () => {
  const root = document.querySelector('[data-freethought-map-root]');
  const sid = (root ? root.innerText : '').match(/session-[0-9a-f-]{8,}/i);
  if (!sid) return { err: 'no-session-id-in-panel' };
  const post = async (method, args) => {
    const rpcId = 'diag-' + Math.random().toString(36).slice(2);
    const r = await fetch('/api/freethoughtMap/' + method, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ type: 'client-request', rpcId, method: 'freethoughtMap/' + method, payload: { args } })
    });
    return await r.json();
  };
  const ev = await post('events', { sessionId: sid[0], sinceSeq: -1 });
  const ld = await post('load', { sessionId: sid[0] });
  const entries = (ev.result && ev.result.ok && ev.result.value && ev.result.value.entries) || [];
  const doc = (ld.result && ld.result.ok && ld.result.value && ld.result.value.doc) || null;
  return {
    sessionId: sid[0],
    eventsCount: entries.length,
    eventsWithTitle: entries.filter(e => e.title).length,
    eventsSample: entries.slice(-4).map(e => ({ eventId: e.eventId, title: e.title })),
    docNodes: doc ? Object.keys(doc.nodes).length : null,
    docFocus: doc ? doc.focusId : null,
    nodeRefsSample: doc ? Object.values(doc.nodes).slice(-4).map(n => ({ id: n.id, ref: n.sourceRef ? n.sourceRef.eventId : null })) : null,
  };
})()`)
console.log('\n数据源探测：' + JSON.stringify(probe, null, 2))

// ── 3. 面板是否拿到了非空的 derivedTitles（侧面：看有没有渲染出任何非占位标题）
const anyRealTitle = (rows.items || []).some((r) => r.title && r.title !== '（无标题）' && r.title !== '（已清空）')
console.log('\n是否有任何一行显示了真实标题: ' + anyRealTitle)

ws.close()
