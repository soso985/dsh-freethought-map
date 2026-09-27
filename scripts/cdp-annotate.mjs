/**
 * 真机验收：行内编辑注解（画布计划 §8 的最小第一步）。
 *
 * 主人指定的**两条必须验的边界**：
 *   ① 空串不去回退派生标题（规格 §10.1 三态里的 `""` 那一态）
 *   ② 刷新后仍在 —— 证明真落盘到 `save`，不只是本地 state
 *
 * 为什么必须真浏览器：这两条都是**接线**性质（UI → save → 落盘 → 重载后仍读得到），
 * 纯函数断言再密也覆盖不到「React 有没有把值交出去」和「重载后宿主那份还在不在」。
 *
 * ⚠️ 输入用 CDP 的 `Input.insertText` / `Input.dispatchKeyEvent`，
 * **不是** `execCommand` 或直接改 `input.value` —— 后者绕不过 React 的受控输入管线
 * （`onChange` 不会被触发，看着像成功其实什么都没提交）。这个坑在官方编辑器上踩过。
 *
 * 用法：node cdp-annotate.mjs <wsUrl> <wsModulePath> <sessionId>
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

// ── 打开面板（用封好的助手：踩过的两个坑都在里面）──────────────────────────
const { createPanelOpener } = await import('./cdp-panel.mjs')
const opener = createPanelOpener(evaluate, send)
const opened = await opener.ensurePanelOpen({ sessionId: SESSION_ID, timeoutMs: 20000 })
console.log('\n=== 面板 ===')
for (const n of opened.notes) info(n)
if (!opened.ok) {
  bad('面板没打开，验收无法进行')
  ws.close()
  process.exit(1)
}
ok('面板已挂载（tab=' + opened.tabId + '）')

// ── 挑一个**带 sourceRef** 的行（turn 节点；手建节点没有气泡但也能写注解，这里取 turn）──
const target = await evaluate(`(() => {
  const rows = [...document.querySelectorAll('[data-ftm-node]')];
  if (!rows.length) return null;
  // 优先挑最后一个（最新节点），它的派生标题最可能有值，便于验"空串不回退"
  const el = rows[rows.length - 1];
  return { id: el.getAttribute('data-ftm-node'), kind: el.getAttribute('data-ftm-kind'),
           title: (el.querySelector('.ftm-chain-title') || {}).textContent || '' };
})()`)
if (!target) {
  bad('面板里没有任何链行')
  ws.close()
  process.exit(1)
}
info(`目标节点 ${target.id}（${target.kind}）当前显示：${JSON.stringify(target.title)}`)
const derivedBefore = target.title
if (!derivedBefore || derivedBefore === '（无标题）') {
  info('⚠️ 该节点当前没有派生标题 —— ①「空串不回退」那一条会因为"本来就没得回退"而失去意义')
}

// 通过 RPC 读权威（用来证明真落盘，而不是只看 DOM）
async function readAuthority() {
  return await evaluate(`(async () => {
    const rpcId = 'annot-' + Math.random().toString(36).slice(2);
    const r = await fetch('/api/freethoughtMap/load', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ type: 'client-request', rpcId, method: 'freethoughtMap/load',
                             payload: { args: { sessionId: ${JSON.stringify(SESSION_ID)} } } })
    });
    const env = await r.json();
    const doc = env.result && env.result.ok ? env.result.value.doc : null;
    if (!doc) return { err: JSON.stringify(env).slice(0, 200) };
    const n = doc.nodes[${JSON.stringify(target.id)}];
    return { rev: env.result.value.rev, hasTitle: n ? Object.prototype.hasOwnProperty.call(n, 'title') : null,
             title: n ? n.title : null };
  })()`)
}

/** 双击指定行进入编辑态，返回编辑框是否出现 */
async function openEditor(nodeId) {
  const box = await evaluate(`(() => {
    const el = document.querySelector('[data-ftm-node=${JSON.stringify(nodeId)}]');
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
  })()`)
  if (!box) return false
  // 真双击：两次 press/release，clickCount 递增（React 的 onDblClick 靠这个）
  for (const clickCount of [1, 2]) {
    await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: box.x, y: box.y, button: 'left', clickCount })
    await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: box.x, y: box.y, button: 'left', clickCount })
  }
  for (let i = 0; i < 12; i += 1) {
    await sleep(250)
    const has = await evaluate(`!!document.querySelector('[data-ftm-annotate-input]')`)
    if (has) return true
  }
  return false
}

async function typeText(text) {
  await send('Input.insertText', { text })
  await sleep(200)
}
async function pressKey(key, code, windowsVirtualKeyCode) {
  const base = { key, code, windowsVirtualKeyCode, nativeVirtualKeyCode: windowsVirtualKeyCode }
  await send('Input.dispatchKeyEvent', { type: 'keyDown', ...base })
  await send('Input.dispatchKeyEvent', { type: 'keyUp', ...base })
  await sleep(500)
}

// ═════════════════════ ① 写入注解 → 真落盘 ═════════════════════
console.log('\n=== ① 写注解并确认真的落盘 ===')
const ANNOTATION = '验收注解-' + String(Date.now()).slice(-5)
{
  const opened2 = await openEditor(target.id)
  if (!opened2) {
    bad('双击没有让该行进入编辑态（编辑框没出现）')
  } else {
    ok('双击进入编辑态（编辑框出现）')
    await typeText(ANNOTATION)
    await pressKey('Enter', 'Enter', 13)
    await sleep(1200)
    const a = await readAuthority()
    if (a && a.hasTitle === true && a.title === ANNOTATION) {
      ok(`注解真的落盘了（宿主权威里 node.title = ${JSON.stringify(a.title)}，rev=${a.rev}）`)
    } else {
      bad('注解没有落盘到宿主：' + JSON.stringify(a))
    }
    const shown = await evaluate(`(() => {
      const el = document.querySelector('[data-ftm-node=${JSON.stringify(target.id)}] .ftm-chain-title');
      return el ? el.textContent : null;
    })()`)
    if (shown === ANNOTATION) ok('面板立刻显示注解：' + JSON.stringify(shown))
    else bad('面板显示的不是注解：' + JSON.stringify(shown))
    // 不能重复提交（Enter 后卸载会触发 blur）
    const revAfter = a && a.rev
    await sleep(800)
    const a2 = await readAuthority()
    if (a2 && a2.rev === revAfter) ok('没有重复提交（rev 稳定在 ' + revAfter + '）')
    else bad(`疑似重复提交：rev ${revAfter} → ${a2 && a2.rev}`)
  }
}

// ═════════════════════ ② 刷新后仍在（真落盘的硬证据）═════════════════════
console.log('\n=== ② 刷新后注解仍在 ===')
{
  await send('Page.reload', { ignoreCache: true })
  await sleep(12000)
  const s2 = await opener.ensurePanelOpen({ sessionId: SESSION_ID, timeoutMs: 25000 })
  for (const n of s2.notes) info(n)
  if (!s2.ok) {
    bad('刷新后面板没打开')
  } else {
    const shown = await evaluate(`(() => {
      const el = document.querySelector('[data-ftm-node=${JSON.stringify(target.id)}] .ftm-chain-title');
      return el ? el.textContent : null;
    })()`)
    if (shown === ANNOTATION) ok('刷新后面板仍显示注解：' + JSON.stringify(shown) + '（证明落盘，不只是本地 state）')
    else bad('刷新后注解不见了：' + JSON.stringify(shown))
  }
}

// ═════════════════════ ③ 空串不回退派生标题 ═════════════════════
console.log('\n=== ③ 清空（提交空串）后显示空，**不回退**派生标题 ===')
{
  const opened3 = await openEditor(target.id)
  if (!opened3) {
    bad('第二次双击没有进入编辑态')
  } else {
    ok('再次进入编辑态')
    // 全选 + 删除 → 提交空串
    const cleared = await evaluate(`(() => {
      const el = document.querySelector('[data-ftm-annotate-input]');
      if (!el) return false;
      el.focus();
      el.setSelectionRange(0, el.value.length);
      return true;
    })()`)
    if (!cleared) {
      bad('拿不到编辑框、无法全选')
    } else {
      await pressKey('Backspace', 'Backspace', 8)
      await sleep(200)
      await pressKey('Enter', 'Enter', 13)
      await sleep(1200)
      const a = await readAuthority()
      if (a && a.hasTitle === true && a.title === '') {
        ok('空串已落盘（node.title 存在且为 ""，不是被删掉）')
      } else {
        bad('空串没有按"合法值"落盘：' + JSON.stringify(a))
      }
      const shown = await evaluate(`(() => {
        const el = document.querySelector('[data-ftm-node=${JSON.stringify(target.id)}] .ftm-chain-title');
        return el ? el.textContent : null;
      })()`)
      if (shown === '（已清空）') {
        ok('显示「（已清空）」占位，**不回退**派生标题（规格 §10.1 的 "" 那一态成立）')
      } else if (shown === derivedBefore) {
        bad('清空后**回退成了派生标题** ' + JSON.stringify(shown) + ' —— 违反规格 §10.1')
      } else {
        bad('清空后显示异常：' + JSON.stringify(shown))
      }
      if (derivedBefore && shown !== derivedBefore) {
        ok(`确实没有回退：清空前显示 ${JSON.stringify(derivedBefore)}，清空后 ${JSON.stringify(shown)}`)
      }
    }
  }
}

console.log('')
const fails = results.filter(([s]) => s === 'FAIL').length
console.log(`行内编辑注解验收：${results.length - fails} 通过 / ${fails} 失败`)
ws.close()
process.exit(fails ? 1 : 0)
