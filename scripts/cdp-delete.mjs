/**
 * 真机验收：每行「✕ 摘除」（画布计划 §8 阶段 1 第 3 项；规格 §6.6 唯一规则）。
 *
 * ⚠️ 这是**首个破坏性操作**，本脚本会写盘造结构，所以按三条规矩写：
 *   1. 开始时整份快照权威 doc；
 *   2. 只在一个**受控小块**上做（挂点 turn 下造 M + 两个子 + 一条粉线），不碰真实链；
 *   3. 恢复逻辑放在 **`finally`** 里无条件执行，并**逐字段比对**验收前的快照。
 *
 * 为什么写这么小心（两次教训）：
 *   · 第一次：清理写在流程末尾 ⇒ 中途一个 TypeError 就跳过清理，留下 3 个测试节点。
 *   · 第二次：`finally` 里读权威那次 `evaluate` 返回 `undefined`（页面导航竞态）
 *     ⇒ 清理空转，又留下 3 个。
 *   所以本版**所有页面求值都带重试**（`evalRetry`），且**删完之后会确认真的删掉了**。
 *
 * 验四条（规格 §6.6）：
 *   ① 子节点**上提**（parentId ← 被删节点的 parentId）
 *   ② 与它相连的**粉线删除**
 *   ③ 手建节点**不写 hidden**；turn 节点则 `hidden` 加入其 sourceRef
 *   ④ 焦点回退（被删的是焦点时 → 它的父）＋ 落盘 ＋ 破坏性操作先问一次
 *
 * 用法：node cdp-delete.mjs <wsUrl> <wsModulePath> <sessionId>
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
  // ⚠️ 真实的 `window.confirm` 会**阻塞渲染进程** —— 一旦它弹出来，
  // 后续所有 `Runtime.evaluate` 都拿不到结果（表现为 "no result"）。
  // 所以监听对话框事件并立刻处理掉（这是**兜底**；主路径靠注入的 confirm 替身）。
  if (m.method === 'Page.javascriptDialogOpening') {
    dialogs.push(m.params.message)
    ws.send(JSON.stringify({ id: nextId++, method: 'Page.handleJavaScriptDialog', params: { accept: true } }))
    return
  }
  if (m.id && pending.has(m.id)) {
    const { resolve } = pending.get(m.id)
    pending.delete(m.id)
    resolve(m.result)
  }
})
const dialogs = []
function send(method, params = {}) {
  const id = nextId++
  return new Promise((resolve) => {
    pending.set(id, { resolve })
    ws.send(JSON.stringify({ id, method, params }))
    setTimeout(() => resolve(undefined), 20000)
  })
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/**
 * 页面求值 + **重试**。
 *
 * 为什么必须重试：页面导航（`Page.reload`）期间 `Runtime.evaluate` 可能返回
 * `undefined` 或抛异常。早先直接用它读权威，一次竞态就让整个验收脚本崩在
 * `cur.doc` 上 —— 连 `finally` 里的清理都空转了。
 */
async function evaluate(expression, { tries = 4, gapMs = 1500 } = {}) {
  let lastErr = null
  for (let i = 0; i < tries; i += 1) {
    try {
      const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })
      if (r && r.exceptionDetails) {
        lastErr = r.exceptionDetails.exception?.description || r.exceptionDetails.text
      } else if (r && r.result) {
        const v = r.result.value
        // 拿到 undefined 也可能是竞态（上下文刚换）—— 除非表达式本身就该返回 undefined
        if (v !== undefined) return v
        lastErr = 'result undefined'
      } else {
        lastErr = 'no result'
      }
    } catch (e) {
      lastErr = String(e && e.message)
    }
    await sleep(gapMs)
  }
  return { __unavailable: true, __err: String(lastErr) }
}

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

// 受控测试结构的 id（恢复现场时要按这些 id 清）
const M = 'M-deltest-parent'
const C1 = 'M-deltest-child-1'
const C2 = 'M-deltest-child-2'
const T = 'T-deltest-turn'
const LINK = 'L-deltest'
const EVT = 'deltest-evt-1'
const ALL_TEST_IDS = [M, C1, C2, T]

async function readAuthority() {
  const r = await evaluate(`(async () => {
    const rpcId = 'dl-' + Math.random().toString(36).slice(2);
    const r = await fetch('/api/freethoughtMap/load', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ type: 'client-request', rpcId, method: 'freethoughtMap/load',
                             payload: { args: { sessionId: ${JSON.stringify(SESSION_ID)} } } })
    });
    const env = await r.json();
    return env.result && env.result.ok ? { rev: env.result.value.rev, doc: env.result.value.doc } : { err: JSON.stringify(env).slice(0,200) };
  })()`)
  if (!r || r.__unavailable) return { err: 'evaluate 不可用：' + (r && r.__err) }
  if (r.err || !r.doc) return { err: r.err || 'load 没有 doc' }
  return r
}

async function saveDoc(doc, baseRev) {
  const r = await evaluate(`(async () => {
    const rpcId = 'ds-' + Math.random().toString(36).slice(2);
    const r = await fetch('/api/freethoughtMap/save', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ type: 'client-request', rpcId, method: 'freethoughtMap/save',
                             payload: { args: { sessionId: ${JSON.stringify(SESSION_ID)}, doc: ${JSON.stringify(doc)}, baseRev: ${baseRev} } } })
    });
    const env = await r.json();
    return env.result && env.result.ok ? env.result.value : { err: JSON.stringify(env).slice(0,300) };
  })()`)
  if (!r || r.__unavailable) return { err: 'evaluate 不可用：' + (r && r.__err) }
  return r
}

/** 轮询等待某个元素出现。 */
async function waitFor(selector, timeoutMs = 20000) {
  const dl = Date.now() + timeoutMs
  while (Date.now() < dl) {
    const has = await evaluate(`!!document.querySelector(${JSON.stringify(selector)})`)
    if (has === true) return true
    await sleep(1200)
  }
  return false
}

/** 强制刷新页面并重新把面板开到目标会话，然后等到指定选择器出现。 */
async function forceReloadAndOpen(expectSelector) {
  await send('Page.enable')
  await send('Page.reload', { ignoreCache: true })
  await sleep(12000)
  const r = await opener.ensurePanelOpen({ sessionId: SESSION_ID, timeoutMs: 25000 })
  if (!r.ok) return r
  if (expectSelector) {
    const got = await waitFor(expectSelector, 20000)
    if (!got) return { ok: false, notes: (r.notes || []).concat(['等不到 ' + expectSelector]) }
  }
  return r
}

/**
 * 接管 `window.confirm`（记下问了什么、返回 true）。
 *
 * ⚠️ **每次导航之后都必须重新装** —— 页面刷新会把注入的替身一起冲掉，
 * 于是下一次点「✕」弹的是**真对话框**，它会阻塞渲染进程，
 * 后续所有 `Runtime.evaluate` 都变成 "no result"，整个验收脚本卡死。
 * （第 3 版就是栽在这里：第 2 段装了替身、第 3 段刷新后就失效了。）
 */
async function installConfirmSpy() {
  const r = await evaluate(`(() => {
    window.__ftmConfirm = [];
    window.confirm = (msg) => { window.__ftmConfirm.push(String(msg)); return true; };
    return true;
  })()`)
  return r === true
}

/** 点某个节点的「✕」（window.confirm 需已被接管）。 */
async function clickDelete(nodeId) {
  const r = await evaluate(`(() => {
    const btn = document.querySelector('[data-ftm-delete=${JSON.stringify(nodeId)}]');
    if (!btn) return { ok: false, reason: 'no-button' };
    btn.click();
    return { ok: true };
  })()`)
  if (!r || r.__unavailable) return { ok: false, reason: 'evaluate 不可用：' + (r && r.__err) }
  return r
}

/**
 * 恢复现场：清掉测试结构 → **逐字段比对**验收前的快照。
 * 放在 `finally` 里无条件执行。
 */
async function restoreSite(tag) {
  console.log(`\n=== 4. 恢复现场（${tag}）===`)
  const cur = await readAuthority()
  if (cur.err) {
    bad('恢复失败：读不到权威（' + cur.err + '）')
    return
  }
  const doc = JSON.parse(JSON.stringify(cur.doc))
  for (const id of ALL_TEST_IDS) delete doc.nodes[id]
  doc.freeLinks = doc.freeLinks.filter((l) => l.id !== LINK)
  doc.hidden = doc.hidden.filter((h) => h.eventId !== EVT)
  if (!doc.nodes[ORIG.doc.focusId]) doc.focusId = ORIG.doc.focusId
  const r = await saveDoc(doc, cur.rev)
  if (!r || r.status !== 'ok') {
    bad('恢复提交失败：' + JSON.stringify(r).slice(0, 240))
    return
  }
  const final = await readAuthority()
  if (final.err) {
    bad('恢复后读不回权威：' + final.err)
    return
  }
  const diffs = []
  const a = ORIG.doc
  const b = final.doc
  const ka = Object.keys(a.nodes).sort()
  const kb = Object.keys(b.nodes).sort()
  if (JSON.stringify(ka) !== JSON.stringify(kb)) {
    diffs.push('节点集合不同：缺 ' + ka.filter((x) => !kb.includes(x)).join(',') + ' 多 ' + kb.filter((x) => !ka.includes(x)).join(','))
  }
  for (const id of ka) {
    if (!b.nodes[id]) continue
    if ((a.nodes[id].parentId ?? null) !== (b.nodes[id].parentId ?? null)) {
      diffs.push(`${id} 的 parentId 变了：${a.nodes[id].parentId} → ${b.nodes[id].parentId}`)
    }
    if (JSON.stringify(a.nodes[id].title) !== JSON.stringify(b.nodes[id].title)) diffs.push(`${id} 的 title 变了`)
  }
  if (JSON.stringify(a.freeLinks) !== JSON.stringify(b.freeLinks)) diffs.push('freeLinks 不同')
  if (JSON.stringify(a.hidden) !== JSON.stringify(b.hidden)) diffs.push('hidden 不同')
  if ((a.focusId ?? null) !== (b.focusId ?? null)) diffs.push(`focusId 不同：${a.focusId} → ${b.focusId}`)
  const leftover = ALL_TEST_IDS.filter((id) => b.nodes[id])
  if (leftover.length) diffs.push('测试节点残留：' + leftover.join(','))
  if (diffs.length === 0) ok('现场已**逐字段恢复**（节点集合/父链/注解/粉线/hidden/焦点 + 无残留）')
  else bad('恢复不干净，差异：' + diffs.slice(0, 5).join('；'))
}

// ── 0. 快照原始权威 ────────────────────────────────────────────────────────
console.log('\n=== 0. 快照 ===')
const opened0 = await forceReloadAndOpen(null)
for (const n of (opened0.notes || []).slice(-2)) info(n)
if (!opened0.ok) {
  bad('面板没打开，验收无法进行')
  ws.close()
  process.exit(1)
}
const panelSid = await opener.panelSession()
const convSid = await opener.conversationSession()
if (panelSid === SESSION_ID && convSid === SESSION_ID) {
  ok('面板与正文容器都在目标会话（护栏生效，不会误写别的会话）')
} else {
  bad(`会话不对！panel=${panelSid} conv=${convSid} 期望=${SESSION_ID}`)
  ws.close()
  process.exit(1)
}

const ORIG = await readAuthority()
if (ORIG.err) {
  bad('读权威失败：' + ORIG.err)
  ws.close()
  process.exit(1)
}
const origJson = JSON.stringify(ORIG.doc)
info(`原始权威：rev=${ORIG.rev}  nodes=${Object.keys(ORIG.doc.nodes).length}  freeLinks=${ORIG.doc.freeLinks.length}  hidden=${ORIG.doc.hidden.length}  focus=${ORIG.doc.focusId}`)
const anchorTurn = Object.values(ORIG.doc.nodes).find((n) => n.kind === 'turn')
if (!anchorTurn) {
  bad('没有 turn 节点，无法造受控结构')
  ws.close()
  process.exit(1)
}

try {
  // ── 1. 造受控结构 ───────────────────────────────────────────────────────
  console.log('\n=== 1. 造受控结构（只动这一小块）===')
  info('挂点 turn = ' + anchorTurn.id)
  const setup = JSON.parse(origJson)
  setup.nodes[M] = { id: M, kind: 'manual', parentId: anchorTurn.id, position: { x: 400, y: 400 }, title: '受控测试-父' }
  setup.nodes[C1] = { id: C1, kind: 'manual', parentId: M, position: { x: 440, y: 440 } }
  setup.nodes[C2] = { id: C2, kind: 'manual', parentId: M, position: { x: 480, y: 480 } }
  setup.freeLinks = [...setup.freeLinks, { id: LINK, a: M, b: C2 }]
  setup.focusId = M
  {
    const r = await saveDoc(setup, ORIG.rev)
    if (!r || r.status !== 'ok') throw new Error('造受控结构失败：' + JSON.stringify(r).slice(0, 240))
    ok(`受控结构已建：${M}（焦点）挂 ${anchorTurn.id} 下，${C1}/${C2} 挂它下面，粉线 ${LINK}`)
  }

  // ── 2. 摘除 M，验 §6.6 ─────────────────────────────────────────────────
  console.log('\n=== 2. 点「✕ 摘除」M，验 §6.6 ===')
  {
    const opened = await forceReloadAndOpen(`[data-ftm-delete="${M}"]`)
    if (!opened.ok) {
      bad('刷新后等不到 M 的「✕」按钮：' + JSON.stringify((opened.notes || []).slice(-2)))
    } else {
      ok('面板链里出现了受控节点 M 的「✕」按钮')
      const before = await readAuthority()
      // 装 confirm 替身（刷新刚把页面换过，必须在这里装）
      if (await installConfirmSpy()) info('已接管 window.confirm（记下问话内容）')
      else bad('装不上 window.confirm 替身 —— 真对话框会阻塞页面')
      const clicked = await clickDelete(M)
      if (!clicked.ok) {
        bad('点不到 M 的「✕」：' + String(clicked.reason))
      } else {
        await sleep(2500)
        const asked = await evaluate(`window.__ftmConfirm`)
        if (Array.isArray(asked) && asked.length === 1 && /摘除/.test(asked[0])) {
          ok('破坏性操作**先问了一次**（文案：' + JSON.stringify(String(asked[0]).slice(0, 36)) + '…）')
        } else {
          bad('没有先问一次（或问了不止一次）：' + JSON.stringify(asked))
        }
        const after = await readAuthority()
        if (after.err) {
          bad('删后读不到权威：' + after.err)
        } else {
          const d = after.doc
          info(`删后：rev=${after.rev}  nodes=${Object.keys(d.nodes).length}  freeLinks=${d.freeLinks.length}  hidden=${d.hidden.length}  focus=${d.focusId}`)
          if (!d.nodes[M]) ok('① M 已从 nodes 里移除')
          else bad('① M 还在 nodes 里')
          if (d.nodes[C1] && d.nodes[C1].parentId === anchorTurn.id && d.nodes[C2] && d.nodes[C2].parentId === anchorTurn.id) {
            ok(`① 两个子节点都**上提**到 M 的父（${anchorTurn.id}）`)
          } else {
            bad(`① 子节点上提不对：C1=${d.nodes[C1] && d.nodes[C1].parentId} C2=${d.nodes[C2] && d.nodes[C2].parentId}`)
          }
          if (!d.freeLinks.some((l) => l.id === LINK)) ok('② 与 M 相连的粉线已删除')
          else bad('② 粉线还在')
          if (d.focusId === anchorTurn.id) ok(`④ 焦点从被删的 M 回退到它的父（${anchorTurn.id}）`)
          else bad(`④ 焦点回退不对：${d.focusId}`)
          if (after.rev > before.rev) ok(`落盘了：rev ${before.rev} → ${after.rev}`)
          else bad('rev 没涨')
          if (d.hidden.length === ORIG.doc.hidden.length) {
            ok('③ 手建节点摘除**不写 hidden**（它没有 sourceRef）—— 与规格一致')
          } else {
            bad('③ hidden 不该变，却变了')
          }
        }
      }
    }
  }

  // ── 3. turn 节点摘除 ⇒ hidden 写入 ─────────────────────────────────────
  console.log('\n=== 3. 摘除一个 turn 节点 ⇒ hidden 加入其 sourceRef ===')
  {
    const cur = await readAuthority()
    if (cur.err) {
      bad('读权威失败：' + cur.err)
    } else {
      const doc = JSON.parse(JSON.stringify(cur.doc))
      doc.nodes[T] = {
        id: T,
        kind: 'turn',
        parentId: null,
        position: { x: 600, y: 600 },
        sourceRef: { kind: 'user-message', eventId: EVT },
        seq: 99999,
      }
      const sr = await saveDoc(doc, cur.rev)
      if (!sr || sr.status !== 'ok') {
        bad('造 turn 测试节点失败：' + JSON.stringify(sr).slice(0, 200))
      } else {
        const hiddenBefore = (await readAuthority()).doc.hidden.length
        const opened = await forceReloadAndOpen(`[data-ftm-delete="${T}"]`)
        if (!opened.ok) {
          bad('刷新后等不到 turn 测试节点的「✕」：' + JSON.stringify((opened.notes || []).slice(-2)))
        } else {
          // ⚠️ 必须**再装一次**：上面这次刷新把第 2 段装的替身冲掉了。
          // 不装的话这里弹的是**真** confirm，会阻塞渲染进程、后面全变 "no result"。
          if (!(await installConfirmSpy())) bad('刷新后装不上 confirm 替身')
          const clicked = await clickDelete(T)
          if (!clicked.ok) {
            bad('点不到 turn 测试节点的「✕」：' + String(clicked.reason))
          } else {
            await sleep(2500)
            const after = await readAuthority()
            if (after.err) {
              bad('读权威失败：' + after.err)
            } else {
              const grew = after.doc.hidden.length - hiddenBefore
              const hasRef = after.doc.hidden.some((h) => h.eventId === EVT)
              if (grew === 1 && hasRef) ok(`③ turn 摘除后 hidden 加入其 sourceRef（+${grew}，含 ${EVT}）—— 补链不会立刻建回`)
              else bad(`③ hidden 没写对：+${grew}，含目标 ref=${hasRef}`)
              if (!after.doc.nodes[T]) ok('③ turn 节点记录已删除（规格推荐：删 node + hidden 留 sourceRef）')
              else bad('③ turn 节点记录还在')
            }
          }
        }
      }
    }
  }
} finally {
  // **无条件执行** —— 上面任何一步抛错都不能把测试结构留在权威里。
  await restoreSite('无条件执行（finally）')
}

console.log('')
const fails = results.filter(([s]) => s === 'FAIL').length
console.log(`摘除验收：${results.length - fails} 通过 / ${fails} 失败`)
ws.close()
process.exit(fails ? 1 : 0)
