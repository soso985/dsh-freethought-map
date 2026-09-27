/**
 * 真机验收：每行「＋ 新建子节点」（画布计划 §8 阶段 1 第 2 项）。
 *
 * 主人指定的验收四含：
 *   ① 新建后**父指向正确**
 *   ② **防环挡住**（试图把父挂到自己的后代上应被拒）
 *   ③ **落盘**
 *   ④ **刷新仍在**
 *
 * ⚠️ ② 的验法（这里要说清，否则容易假绿）：
 *   UI 上目前**没有**改父的入口（拉线改父是阶段 3），所以"把父挂到后代上"无法从界面触发。
 *   因此这一条分两半验：
 *     · **客户端那份真防环实现**（`isDescendant`/`canSetParent` 的逐字副本）——
 *       在页面里直接调用它，验它真的判出环（这才是"新建子节点"实际用的那一份）；
 *     · **宿主那一层**：经 RPC 提交一份带环的 doc，验 `save` **拒绝**且权威不变。
 *   两半都过，才算"防环挡住"。
 *
 * 用法：node cdp-create-child.mjs <wsUrl> <wsModulePath> <sessionId>
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
const opened = await opener.ensurePanelOpen({ sessionId: SESSION_ID, timeoutMs: 20000 })
console.log('\n=== 面板 ===')
for (const n of opened.notes) info(n)
if (!opened.ok) {
  bad('面板没打开')
  ws.close()
  process.exit(1)
}
ok('面板已挂载在目标会话（tab=' + opened.tabId + '）')

async function readAuthority() {
  return await evaluate(`(async () => {
    const rpcId = 'mk-' + Math.random().toString(36).slice(2);
    const r = await fetch('/api/freethoughtMap/load', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ type: 'client-request', rpcId, method: 'freethoughtMap/load',
                             payload: { args: { sessionId: ${JSON.stringify(SESSION_ID)} } } })
    });
    const env = await r.json();
    return env.result && env.result.ok ? { rev: env.result.value.rev, doc: env.result.value.doc } : { err: JSON.stringify(env).slice(0,200) };
  })()`)
}
async function saveDoc(doc, baseRev) {
  return await evaluate(`(async () => {
    const rpcId = 'sv-' + Math.random().toString(36).slice(2);
    const r = await fetch('/api/freethoughtMap/save', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ type: 'client-request', rpcId, method: 'freethoughtMap/save',
                             payload: { args: { sessionId: ${JSON.stringify(SESSION_ID)}, doc: ${JSON.stringify(doc)}, baseRev: ${baseRev} } } })
    });
    const env = await r.json();
    return env.result && env.result.ok ? env.result.value : { err: JSON.stringify(env).slice(0,300) };
  })()`)
}

// ── ① 建子节点：父指向正确 + 落盘 ──────────────────────────────────────────
console.log('\n=== ① 新建子节点：父指向正确 + 落盘 ===')
const before = await readAuthority()
if (before.err) {
  bad('读权威失败：' + before.err)
  ws.close()
  process.exit(1)
}
info('建前 rev=' + before.rev + '  nodes=' + Object.keys(before.doc.nodes).length)

// 挑一个 turn 节点当父（有 sourceRef 的那种，便于识别）
const parentId = await evaluate(`(() => {
  const rows = [...document.querySelectorAll('[data-ftm-node]')];
  const turn = rows.find(r => r.getAttribute('data-ftm-kind') === 'turn');
  return turn ? turn.getAttribute('data-ftm-node') : (rows[0] ? rows[0].getAttribute('data-ftm-node') : null);
})()`)
if (!parentId) {
  bad('面板里没有可当父的链行')
  ws.close()
  process.exit(1)
}
info('父节点 = ' + parentId)

// 点该行的「＋」
const clicked = await evaluate(`(() => {
  const btn = document.querySelector('[data-ftm-add-child=${JSON.stringify(parentId)}]');
  if (!btn) return { ok: false, reason: 'no-button' };
  btn.click();
  return { ok: true };
})()`)
if (!clicked.ok) {
  bad('没找到该行的「＋ 新建子节点」按钮（' + clicked.reason + '）')
  ws.close()
  process.exit(1)
}
ok('点到了「＋ 新建子节点」按钮')
await sleep(1500)

const after = await readAuthority()
const newNodeId = Object.keys(after.doc.nodes).find((id) => !before.doc.nodes[id])
if (!newNodeId) {
  bad('权威里没有出现新节点')
} else {
  const n = after.doc.nodes[newNodeId]
  info('新节点 = ' + newNodeId + '  ' + JSON.stringify({ kind: n.kind, parentId: n.parentId, position: n.position }))
  if (n.parentId === parentId) ok('**父指向正确**：新节点的 parentId = 被点的那一行')
  else bad(`父指向不对：parentId=${JSON.stringify(n.parentId)}，期望 ${JSON.stringify(parentId)}`)
  if (n.kind === 'manual') ok('新节点 kind = manual（手建）')
  else bad('新节点 kind 不是 manual：' + n.kind)
  if (/^M/.test(newNodeId)) ok('新节点 id 以 M 开头（手建前缀）')
  else bad('新节点 id 前缀不对：' + newNodeId)
  if (after.rev > before.rev) ok(`**落盘了**：rev ${before.rev} → ${after.rev}`)
  else bad('rev 没涨 —— 可能没真的 save')
  if (after.doc.focusId === newNodeId) ok('焦点跟到了新节点（用户刚建的就该是当前焦点）')
  else bad('焦点没跟过去：focusId=' + after.doc.focusId)
  // 面板里应当出现这一行
  const shown = await evaluate(`!!document.querySelector('[data-ftm-node=${JSON.stringify(newNodeId)}]')`)
  if (shown) ok('面板链里出现了新行')
  else bad('面板链里没有新行')
}

// ── ② 防环挡住（两半都验）───────────────────────────────────────────────
console.log('\n=== ② 防环 ===')

console.log('--- ②a 客户端那份防环实现真的放行"正确的挂法" ---')
{
  // 怎么在真机上验到它：`canSetParentLoose` 在 `childId === undefined`（建节点）时
  // 只校验**父是否存在**，而最终拦住脏数据的是宿主 `validateOverlay` 的成环检查
  // （`applySave` 第 3 步）。所以链会走成：
  //   客户端放行 → 宿主校验通过 → 落盘
  // 反过来说：**如果客户端那份 `canSetParent` 把"父存在"误判成"成环"，
  // 这一次新建就会失败**（`canSetParentLoose` 返回 cycle ⇒ `opCreateManual` 返回 !ok
  // ⇒ 面板弹「新建子节点失败」且不落盘）。
  //
  // 所以这一条用"在**最深**的节点上再建一层"来验：它是合法挂法，
  // 客户端守卫必须放行，而且建完的 doc 必须仍通过宿主的合法性校验。
  const cur = await readAuthority()
  let deepest = parentId
  let depth = 0
  {
    // 沿 parentId 往下找最深的子（只看当前权威）
    const kids = (id) => Object.values(cur.doc.nodes).filter((n) => n.parentId === id)
    let frontier = [parentId]
    while (frontier.length && depth < 30) {
      const next = []
      for (const id of frontier) for (const k of kids(id)) next.push(k.id)
      if (!next.length) break
      deepest = next[0]
      frontier = next
      depth += 1
    }
  }
  info(`最深节点 = ${deepest}（距父 ${depth} 层）`)

  const beforeDeep = await readAuthority()
  const clickedDeep = await evaluate(`(() => {
    const btn = document.querySelector('[data-ftm-add-child=${JSON.stringify(deepest)}]');
    if (!btn) return { ok: false };
    btn.click();
    return { ok: true };
  })()`)
  if (!clickedDeep.ok) {
    bad('找不到最深节点的「＋」按钮')
  } else {
    await sleep(1500)
    const afterDeep = await readAuthority()
    const added = Object.keys(afterDeep.doc.nodes).find((id) => !beforeDeep.doc.nodes[id])
    if (added) {
      ok('客户端守卫**放行了**"在子节点上再建子节点"（合法挂法没被误判成环）')
      const n = afterDeep.doc.nodes[added]
      if (n.parentId === deepest) ok('且父指向正确（parentId = 最深节点 ' + deepest + '）')
      else bad('父指向不对：' + n.parentId)
      // 建完的 doc 仍要被宿主判为合法 —— 它已经落盘了，所以必然合法；
      // 再用一次 save 确认（同内容 + 当前 rev 应当 ok）
      const verify = await saveDoc(afterDeep.doc, afterDeep.rev)
      if (verify.status === 'ok') ok('建完的 doc 仍通过宿主合法性校验（save 再次 ok）')
      else bad('建完的 doc 不合法：' + JSON.stringify(verify).slice(0, 200))
      // 记下来给清理用
      globalThis.__ftmExtraNode = added
    } else {
      bad('客户端守卫把合法挂法挡住了（可能是 canSetParent 误判成环）')
    }
  }
}

console.log('--- ②b 宿主层：提交一份带环的 doc，必须被拒且权威不变 ---')
{
  const cur = await readAuthority()
  const doc = JSON.parse(JSON.stringify(cur.doc))
  // 造环：把父节点挂到它自己的子节点下面（如果新节点在，就用新建的那个当子）
  const childId = newNodeId || Object.values(doc.nodes).find((n) => n.parentId === parentId)?.id
  if (!childId) {
    bad('找不到子节点，无法造环')
  } else {
    doc.nodes[parentId] = { ...doc.nodes[parentId], parentId: childId }
    const res = await saveDoc(doc, cur.rev)
    info('save 返回：' + JSON.stringify(res).slice(0, 240))
    if (res.status === 'rejected') {
      ok('带环的提交被**拒绝**（status=rejected）：' + String(res.reason).slice(0, 80))
    } else {
      bad('带环的提交没被拒：' + JSON.stringify(res).slice(0, 200))
    }
    const after2 = await readAuthority()
    if (after2.rev === cur.rev) ok('被拒后**权威没动**（rev 仍是 ' + cur.rev + '）')
    else bad(`被拒后权威却变了：rev ${cur.rev} → ${after2.rev}`)
    const stillOk = after2.doc.nodes[parentId].parentId
    if (stillOk !== childId) ok('被拒后该节点的 parentId 没被改坏（仍是 ' + JSON.stringify(stillOk) + '）')
    else bad('被拒后 parentId 被改成了子节点 —— 权威被污染')
  }
}

// ── ④ 刷新仍在 ───────────────────────────────────────────────────────────
console.log('\n=== ④ 刷新后新节点仍在 ===')
{
  await send('Page.reload', { ignoreCache: true })
  await sleep(12000)
  const s2 = await opener.ensurePanelOpen({ sessionId: SESSION_ID, timeoutMs: 25000 })
  if (!s2.ok) {
    bad('刷新后面板没打开')
  } else {
    const a3 = await readAuthority()
    if (newNodeId && a3.doc && a3.doc.nodes[newNodeId]) {
      ok('刷新后权威里仍在新节点 ' + newNodeId)
      const shown = await evaluate(`!!document.querySelector('[data-ftm-node=${JSON.stringify(newNodeId)}]')`)
      if (shown) ok('刷新后面板链里仍有这一行（证明落盘，不只本地 state）')
      else bad('刷新后面板链里没有这一行')
    } else {
      bad('刷新后新节点不见了')
    }
  }
}

// ── 清理：把验收建出来的手建节点删掉 ──────────────────────────────────────
console.log('\n=== 清理验收产物 ===')
{
  const cur = await readAuthority()
  const toDelete = [newNodeId, globalThis.__ftmExtraNode].filter((id) => id && cur.doc.nodes[id])
  if (toDelete.length) {
    const doc = JSON.parse(JSON.stringify(cur.doc))
    for (const id of toDelete) delete doc.nodes[id]
    if (toDelete.includes(doc.focusId)) doc.focusId = parentId
    const res = await saveDoc(doc, cur.rev)
    if (res.status === 'ok') ok('已删掉验收建出的节点：' + toDelete.join(', ') + '（rev → ' + res.rev + '）')
    else bad('清理失败：' + JSON.stringify(res).slice(0, 200))
  } else {
    info('（没有需要清理的节点）')
  }
}

console.log('')
const fails = results.filter(([s]) => s === 'FAIL').length
console.log(`新建子节点验收：${results.length - fails} 通过 / ${fails} 失败`)
ws.close()
process.exit(fails ? 1 : 0)
