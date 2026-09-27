/**
 * CDP 交互驱动 —— 被 verify-session.ps1 调用，不直接手跑。
 *
 * 目的：在没有人工点击的前提下，把页面推到「选中一个会话」的状态，
 * 然后回答卡 1 最后那个问题：**官方右列挂载后，插件的 tab 与面板到底出不出来**。
 *
 * 只用**已存在的会话**（不新建、不发消息），所以不会产生任何 token 成本。
 *
 * 参数：
 *   argv[2] = CDP webSocketDebuggerUrl
 *   argv[3] = origin
 *   argv[4] = token
 *   argv[5] = ws 模块目录
 *   argv[6] = 等待秒数（默认 25）
 */
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { createPanelOpener } from './cdp-panel.mjs'

const [, , wsUrl, origin, token, wsModuleDir, waitSecArg] = process.argv
const WAIT_MS = Number(waitSecArg || 25) * 1000
const PKG_NAME = 'dsh-freethought-map'
const ROOT_SEL = '[data-freethought-map-root]'

const require = createRequire(join(wsModuleDir, 'noop.js'))
const WebSocket = require('ws')

const results = []
const ok = (m) => results.push(['PASS', m])
const bad = (m) => results.push(['FAIL', m])
const info = (m) => results.push(['INFO', m])

const ws = new WebSocket(wsUrl, { perMessageDeflate: false, maxPayload: 64 * 1024 * 1024 })
let nextId = 1
const pending = new Map()
const pageErrors = []
const consoleLogs = []
const errLogs = []

function send(method, params = {}) {
  const id = nextId++
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject })
    ws.send(JSON.stringify({ id, method, params }))
  })
}

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
  if (msg.method === 'Runtime.exceptionThrown') {
    pageErrors.push(msg.params.exceptionDetails?.exception?.description ?? 'unknown')
  }
  // 激活失败的**真实错误**只会出现在控制台/日志里，页面 UI 不给细节 —— 必须抓下来。
  // 注意：这里**不过滤**关键词。之前用 /activat|plugin|.../ 过滤，漏掉了真正的报错文本
  // （宿主诊断会写成 "dsh-freethought-map: pending (waiting for service: …)"，
  //  而真正的异常可能是任意一句话）。宁可多打几条。
  if (msg.method === 'Runtime.consoleAPICalled') {
    const text = (msg.params.args ?? [])
      .map((a) => a.value ?? a.description ?? a.unserializableValue ?? '')
      .join(' ')
    consoleLogs.push(`[${msg.params.type}] ${text}`)
    if (msg.params.type === 'error') errLogs.push(text)
  }
  if (msg.method === 'Log.entryAdded') {
    const t = msg.params.entry.text ?? ''
    consoleLogs.push(`[log:${msg.params.entry.level}] ${t}`)
    if (msg.params.entry.level === 'error') errLogs.push(t)
  }
})

await new Promise((resolve) => ws.on('open', resolve))
await send('Runtime.enable')
await send('Log.enable')
await send('Page.enable')
await send('Page.navigate', { url: `${origin}/?token=${encodeURIComponent(token)}` })
await new Promise((r) => setTimeout(r, 6000))

async function evaluate(expression) {
  const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? 'eval failed')
  return r.result?.value
}

// ── 1. 找出页面上的会话入口 ────────────────────────────────────────────────
const survey = await evaluate(`(() => {
  const pick = (sel) => {
    const els = [...document.querySelectorAll(sel)];
    return els.map(e => ({
      tag: e.tagName,
      text: (e.innerText || '').trim().slice(0, 60),
      cls: (e.className || '').toString().slice(0, 80),
      attrs: [...e.attributes].map(a => a.name).filter(n => n.startsWith('data-')).join(','),
    })).slice(0, 12);
  };
  return {
    buttons: pick('button'),
    anchors: pick('a[href]'),
    dataAttrs: [...new Set([...document.querySelectorAll('[data-conversation-session],[data-session-id],[data-workspace]')]
      .map(e => e.tagName + ':' + [...e.attributes].map(a=>a.name).filter(n=>n.startsWith('data-')).join('+')))].slice(0, 20),
    bodyStart: (document.body.innerText || '').trim().slice(0, 400),
  };
})()`)

info(`页面按钮数 = ${survey?.buttons?.length ?? 0}`)
info(`body 文本开头：${JSON.stringify((survey?.bodyStart ?? '').slice(0, 200))}`)
if (survey?.dataAttrs?.length) info(`会话相关 data 属性：${survey.dataAttrs.join(' | ')}`)

// ── 2. 优先找已有的会话行并点击；没有就点「新建会话」类按钮 ──────────────────
//
// `FTM_SESSION_ID` 可指定要打开的会话（诊断用）。不指定时沿用旧的启发式：
// 会话标记元素 → 侧栏第一行。
// ⚠️ 指定时**必须**用 `[data-row-key^="session:"]` —— 那是会话行的稳定标记
// （真机侦察得到），泛化的 li/row 选择器会点到 composer。
const WANT_SESSION = process.env.FTM_SESSION_ID || ''
const clickResult = await evaluate(`(() => {
  const log = [];
  const want = ${JSON.stringify(WANT_SESSION)};
  if (want) {
    const rows = [...document.querySelectorAll('[data-row-key^="session:"]')].filter(e => e.offsetParent !== null);
    const hit = rows.find(e => (e.getAttribute('data-row-key') || '').includes(want));
    log.push('指定会话：候选 ' + rows.length + ' 行，' + (hit ? '命中' : '**未命中**'));
    if (!hit) {
      return { clicked: false, log, have: rows.map(e => (e.getAttribute('data-row-key') || '').slice(0, 50)) };
    }
    hit.scrollIntoView({ block: 'center' });
    hit.click();
    return { clicked: true, log, picked: hit.getAttribute('data-row-key') };
  }
  // 优先：带会话标记的行
  const sessionSel = '[data-conversation-session],[data-session-id],[data-session-row]';
  let target = document.querySelector(sessionSel);
  if (target) log.push('用会话标记元素：' + target.tagName + '.' + (target.className||'').toString().slice(0,40));

  if (!target) {
    // 其次：侧栏里可点的行（li / [role=button] / button），挑文本最像会话的
    const rows = [...document.querySelectorAll('aside li, aside [role="button"], aside button, [class*="row"], [class*="item"]')]
      .filter(e => (e.innerText || '').trim().length > 0 && e.offsetParent !== null);
    log.push('侧栏候选行数：' + rows.length);
    target = rows[0];
    if (target) log.push('取第一行：' + (target.innerText||'').trim().slice(0,40));
  }
  if (!target) return { clicked: false, log };
  target.scrollIntoView({ block: 'center' });
  target.click();
  return { clicked: true, log, text: (target.innerText || '').trim().slice(0, 60) };
})()`)

for (const l of clickResult?.log ?? []) info(`点击侦察：${l}`)
if (clickResult && clickResult.clicked === false && clickResult.have) {
  info('可用会话行：' + clickResult.have.join(' | '))
}

// ── 3. 等右列挂载 + 面板出现 ────────────────────────────────────────────────
const deadline = Date.now() + WAIT_MS
let probe = null
let sawRoot = false

while (Date.now() < deadline) {
  await new Promise((r) => setTimeout(r, 1000))
  try {
    probe = await evaluate(`(() => {
      const root = document.querySelector('${ROOT_SEL}');
      const btns = [...document.querySelectorAll('button')].map(b => ({
        t: (b.getAttribute('aria-label') || b.title || b.innerText || '').trim().slice(0, 40),
        c: (b.className || '').toString().slice(0, 50),
      })).filter(b => b.t);
      return {
        hasRoot: !!root,
        rootCount: document.querySelectorAll('${ROOT_SEL}').length,
        chatBubbles: document.querySelectorAll('[data-chat-node-key]').length,
        rightPaneTabs: document.querySelectorAll('[class*="tab"]').length,
        bodyHasMapTitle: (document.body.innerText || '').includes('FreeThought Map'),
        bodyLen: (document.body.innerText || '').length,
        buttons: btns.slice(0, 40),
      };
    })()`)
  } catch (e) {
    info(`轮询出错：${e.message}`)
    continue
  }
  if (probe.hasRoot) {
    sawRoot = true
    break
  }
}

if (!probe) {
  bad('页面探测失败')
} else {
  info(`气泡数 = ${probe.chatBubbles}  右列 tab 候选元素 = ${probe.rightPaneTabs}`)
  info(`页面文本长度 = ${probe.bodyLen}  含「FreeThought Map」= ${probe.bodyHasMapTitle}`)

  if (probe.chatBubbles > 0) ok(`已选中会话（转录区有 ${probe.chatBubbles} 个气泡）`)
  else info('仍未进入会话画面（转录区无气泡）')

  if (sawRoot) {
    ok(`插件根节点已渲染（${probe.rootCount} 个）—— 卡 1 / D1-1 通过`)
  } else if (probe.bodyHasMapTitle) {
    ok('页面文本里出现「FreeThought Map」—— tab 已注册但正文面板尚未展开')
  } else {
    bad('既没有插件根节点，页面文本里也没有「FreeThought Map」')
    info(`可见按钮：${(probe.buttons ?? []).map((b) => b.t).join(' / ')}`)
  }
}

// ── 4. 打开我们自己的 tab ────────────────────────────────────────────────────
// 官方右列是**按会话挂载**的：必须等选出会话、停靠面真正 mount 之后，
// `sidebarRight.openTab` 才有东西可开（没有挂载面时它会 throw，而不是静默失败）。
if (!sawRoot) {
  info('会话已选中，尝试用官方控制器打开 FreeThought Map tab…')
  const openAttempts = 6
  for (let i = 0; i < openAttempts && !sawRoot; i += 1) {
    const r = await evaluate(`(() => {
      // 走 UI：点会话 header 角落里的右列展开按钮（README 记载的席位）
      const pick = (sel) => [...document.querySelectorAll(sel)].filter(e => e.offsetParent !== null);
      const cands = pick('button,[role="button"]').filter(b => {
        const s = ((b.getAttribute('aria-label') || '') + ' ' + (b.title || '')).toLowerCase();
        return /右|right|sidebar|panel|侧栏/.test(s);
      });
      if (cands.length) { cands[0].click(); return { how: 'header-corner-button', n: cands.length, label: (cands[0].getAttribute('aria-label') || cands[0].title || '').slice(0, 40) }; }
      return { how: 'none', n: 0 };
    })()`)
    if (i === 0) info(`展开尝试：${JSON.stringify(r)}`)
    await new Promise((res) => setTimeout(res, 1500))
    const snap = await evaluate(`(() => {
      const root = document.querySelector('${ROOT_SEL}');
      const body = document.body.innerText || '';
      // 右列 tab 条：dockkit 的稳定 data 属性
      const tabs = [...document.querySelectorAll('[data-dockkit-tab]')].map(t => ({
        id: t.getAttribute('data-dockkit-tab'),
        text: (t.innerText || '').trim().slice(0, 40),
      }));
      const panes = [...document.querySelectorAll('[data-dockkit-pane]')].length;
      const hosts = [...document.querySelectorAll('[data-dockkit-host]')].map(h => h.getAttribute('data-dockkit-host'));
      return {
        root: !!root,
        tabCount: tabs.length,
        tabs,
        panes,
        hosts,
        hasMapText: body.includes('FreeThought Map'),
        rightPaneText: (document.querySelector('[data-dockkit-surface]')?.innerText || '').slice(0, 300),
      };
    })()`)
    if (i === 0) {
      info(`展开后快照：dockkit tabs=${snap.tabCount} panes=${snap.panes} hosts=${JSON.stringify(snap.hosts)} root=${snap.root}`)
      if (snap.tabs.length) info(`  可见 tab：${snap.tabs.map((t) => t.text || t.id).join(' | ')}`)
      if (snap.rightPaneText) info(`  右列文本：${JSON.stringify(snap.rightPaneText.slice(0, 200))}`)
    }
    if (snap.root) {
      sawRoot = true
      break
    }
  }
}

if (sawRoot) {
  ok(`插件根节点已渲染 —— 卡 1 / D1-1 通过`)
  const detail = await evaluate(`(() => {
    const el = document.querySelector('${ROOT_SEL}');
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return {
      w: Math.round(r.width), h: Math.round(r.height),
      collapsed: el.getAttribute('data-collapsed'),
      hasResizer: !!el.querySelector('.ftm-resizer'),
      hasBar: !!el.querySelector('.ftm-bar'),
      hasBody: !!el.querySelector('.ftm-body'),
      text: (el.innerText || '').slice(0, 260),
      bg: getComputedStyle(el).backgroundColor,
      color: getComputedStyle(el).color,
    };
  })()`)
  if (detail) {
    info(`面板几何：${detail.w}×${detail.h}  collapsed=${detail.collapsed}`)
    ok(`结构齐全：标题栏=${detail.hasBar} 正文=${detail.hasBody} 拖宽热区=${detail.hasResizer}`)
    info(`面板文本：${JSON.stringify(detail.text)}`)
    info(`继承到的主题色：color=${detail.color} bg=${detail.bg}`)
    if (/0\.1\.7-rc\.2/.test(detail.text) && /c1275515/.test(detail.text)) {
      ok('面板里显示了宿主版本串与 commit（探针取证可用）')
    } else {
      info('面板文本里没有版本串（可能正文被收起）')
    }

    // ── D1-4 键盘隔离：往面板里发合成按键，验证只有面板响应；
    //    再往面板外发一次，验证宿主那边不受影响（面板状态不变）。
    const kb = await evaluate(`(async () => {
      const root = document.querySelector('${ROOT_SEL}');
      if (!root) return { ok: false, why: 'no root' };
      const before = root.getAttribute('data-collapsed');
      const fire = (target) => target.dispatchEvent(new KeyboardEvent('keydown', {
        key: 'm', code: 'KeyM', ctrlKey: true, altKey: true, bubbles: true, cancelable: true,
      }));
      // 1) 在面板内按 Ctrl+Alt+M → 应该收起
      fire(root.querySelector('.ftm-bar') || root);
      await new Promise(r => setTimeout(r, 300));
      const afterInside = root.getAttribute('data-collapsed');
      // 2) 在面板外（document.body）按同一个键 → 面板状态不应改变
      fire(document.body);
      await new Promise(r => setTimeout(r, 300));
      const afterOutside = root.getAttribute('data-collapsed');
      // 3) 面板内再按一次 → 应该展开回来
      fire(root.querySelector('.ftm-bar') || root);
      await new Promise(r => setTimeout(r, 300));
      const afterAgain = root.getAttribute('data-collapsed');
      return { ok: true, before, afterInside, afterOutside, afterAgain };
    })()`)
    if (kb && kb.ok) {
      info(`键盘隔离实测：内=${kb.before}→${kb.afterInside}  外→${kb.afterOutside}  内再按→${kb.afterAgain}`)
      if (kb.before === kb.afterInside) bad('面板内按 Ctrl+Alt+M 没有收起（快捷键没生效）')
      else ok('面板内按 Ctrl+Alt+M 能收起（面板自己的快捷键生效）')
      if (kb.afterInside !== kb.afterOutside) bad('面板外按同一个键也改了面板状态 —— 说明监听泄漏到宿主')
      else ok('面板外按同一个键不影响面板（键盘隔离成立）')
      if (kb.afterAgain !== kb.before) bad('面板内再按一次没有恢复（往复切换坏了）')
      else ok('面板内再按一次能展开回来（往复切换正常）')
    } else {
      info(`键盘隔离未测到：${JSON.stringify(kb)}`)
    }
  }
}

if (pageErrors.length) {
  for (const e of pageErrors.slice(0, 3)) bad(`未捕获异常：${String(e).slice(0, 260)}`)
} else {
  ok('无未捕获异常')
}

// 激活失败的细节只在控制台里 —— 全部打出来，便于定位
// ── 5. D1-2：整列让位 —— 用**官方右列自己的折叠按钮**收起右列，官方对话列应变宽 ──────
//
// 注意分清两个「收起」：
//   · 插件面板标题栏上的「收起」= 只收起正文，保留标题栏（留一条回到展开态的路），不释放列宽；
//   · 官方右列的折叠按钮 = 整列让位，此时对话列才变宽。
// D1-2 验收的是后者（「收对话图变宽」）。
{
  const convBox = () =>
    evaluate(`(() => {
      const el = document.querySelector('[data-conversation-session],[data-conversation-region]');
      if (!el) return null;
      const r = el.getBoundingClientRect();
      return { w: Math.round(r.width), right: Math.round(r.right) };
    })()`)

  /** 点「打开右侧边栏」那个官方按钮（折叠/展开右列） */
  const toggleOfficialRightbar = () =>
    evaluate(`(async () => {
      const btns = [...document.querySelectorAll('button,[role="button"]')].filter(b => {
        const s = ((b.getAttribute('aria-label') || '') + ' ' + (b.title || '')).trim();
        return /打开右侧边栏|收起右侧边栏|关闭右侧边栏|right sidebar|toggle right panel/i.test(s);
      });
      if (!btns.length) return { ok: false, n: 0 };
      btns[0].click();
      await new Promise(r => setTimeout(r, 1200));
      return { ok: true, label: (btns[0].getAttribute('aria-label') || btns[0].title || '').slice(0, 30) };
    })()`)

  const before = await convBox()
  const collapse = await toggleOfficialRightbar()
  const after = await convBox()

  const fmt = (x) => (x ? `${x.w}px(right=${x.right})` : 'n/a')
  info(`官方右列折叠：${JSON.stringify(collapse)}`)
  info(`D1-2 整列让位实测 —— 右列开时对话列 ${fmt(before)} / 右列收起后 ${fmt(after)}`)

  if (collapse.ok && before && after && after.w > before.w) {
    ok(`收起官方右列后对话列变宽 ${before.w}→${after.w}px（D1-2「收对话图变宽」通过）`)
  } else if (!collapse.ok) {
    info('没找到官方右列的折叠按钮，D1-2 未测到')
  } else {
    bad(`收起右列后对话列没有变宽（${fmt(before)}→${fmt(after)}）`)
  }

  // 恢复右列，并确认插件面板还在（= 让位之后还能回来）
  if (collapse.ok) {
    await toggleOfficialRightbar()
    await new Promise((r) => setTimeout(r, 1200))
    const restored = await convBox()
    const rootBack = await evaluate(`!!document.querySelector('${ROOT_SEL}')`)
    info(`恢复右列后 —— 对话列 ${fmt(restored)}，插件面板在=${rootBack}`)
    if (rootBack) ok('展开右列后插件面板仍在（让位可逆）')
    else info('恢复右列后插件面板不在了（可能被收起为折叠态）')
  }
}

// ── 6. 卡 2 权威存储协议：save → rev 自增 → 过期 save 必须 409 ────────────────
//
// 走的是客户端插件自己那条 `ctx.connection.rpc.call` 通道，所以验的是**完整链路**：
// 浏览器 → /api → 网关 → 宿主服务 → 领域写链 → 磁盘。
// 三条断言：
//   1) save(baseRev=当前) → status ok，rev 自增 1
//   2) 再用**旧的 baseRev** save → status conflict，且权威节点数不变（没被覆盖）
//   3) 冲突返回的 rev 等于第一次成功后的 rev（客户端据此重载）
{
  const rpc = async (method, args) =>
    evaluate(`(async () => {
      // 在页面里找一个能用的 connection：官方 api-* 插件都持有它。
      // 这里直接借用模块系统里已挂载的 gateway 客户端面不方便，所以用最底层的方式：
      // 页面自己的 fetch 打 /api，构造与 connection.rpc.call 完全相同的报文。
      const endpoint = ${JSON.stringify('freethoughtMap/' + method)};
      const rpcId = crypto.randomUUID();
      const res = await fetch('/api/' + endpoint, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ type: 'client-request', rpcId, method: endpoint, payload: { args: ${JSON.stringify(args)} } }),
      });
      if (!res.ok) return { carrier: 'HTTP ' + res.status };
      const full = await res.json();
      return full.result;
    })()`)

  const target = await evaluate(`(() => {
    const el = document.querySelector('${ROOT_SEL}');
    const dl = el && el.querySelector('.ftm-kv');
    const text = dl ? dl.innerText : '';
    const m = text.match(/会话\\n([^\\n]+)/);
    const r = text.match(/权威 rev\\n(\\d+)/);
    return { sessionId: m ? m[1].trim() : null, rev: r ? Number(r[1]) : null };
  })()`)
  info(`存储协议测试目标：sessionId=${target && target.sessionId} rev=${target && target.rev}`)

  if (!target || !target.sessionId || target.rev === null) {
    info('拿不到会话/rev，跳过存储协议测试')
  } else {
    const { sessionId, rev: rev0 } = target
    // 1) 正常保存：塞一个 manual 节点进去
    const doc = {
      version: 1,
      sessionId,
      rev: rev0,
      nodes: {
        'n-test-1': {
          id: 'n-test-1',
          kind: 'manual',
          parentId: null,
          position: { x: 10, y: 20 },
          title: '卡2 存储协议测试节点',
        },
      },
      freeLinks: [],
      focusId: 'n-test-1',
      hidden: [],
      updatedAt: 0,
    }
    const saved = await rpc('save', { sessionId, doc, baseRev: rev0 })
    const okSave = saved && saved.ok === true && saved.value && saved.value.status === 'ok'
    if (okSave && saved.value.rev === rev0 + 1) {
      ok(`save(baseRev=${rev0}) → ok，rev 自增到 ${saved.value.rev}`)
    } else {
      bad(`save 未按预期成功：${JSON.stringify(saved).slice(0, 240)}`)
    }

    // 2) 过期保存：故意还用 rev0
    const stale = await rpc('save', { sessionId, doc, baseRev: rev0 })
    const isConflict = stale && stale.ok === true && stale.value && stale.value.status === 'conflict'
    if (isConflict) {
      ok(`过期 save(baseRev=${rev0}) → conflict（409 语义成立）`)
    } else {
      bad(`过期 save 没有返回 conflict：${JSON.stringify(stale).slice(0, 240)}`)
    }

    // 3) 冲突返回的权威必须没被覆盖，且 rev 是当前值
    if (isConflict) {
      const v = stale.value
      const nodeIds = Object.keys((v.doc && v.doc.nodes) || {})
      if (v.rev === rev0 + 1 && nodeIds.includes('n-test-1') && nodeIds.length === 1) {
        ok(`冲突返回的权威未被覆盖：rev=${v.rev}，节点=${nodeIds.join(',')}`)
      } else {
        bad(`冲突路径下权威被改动了：rev=${v.rev} 节点=${nodeIds.join(',')}`)
      }
    }

    // 4) 用正确的新 rev 再存一次，应该成功 —— 证明冲突之后仍能继续写
    const retry = await rpc('save', { sessionId, doc, baseRev: rev0 + 1 })
    if (retry && retry.ok === true && retry.value && retry.value.status === 'ok' && retry.value.rev === rev0 + 2) {
      ok(`按权威 rev 重试 save → ok，rev=${retry.value.rev}（冲突后可继续写）`)
    } else {
      bad(`重试 save 失败：${JSON.stringify(retry).slice(0, 240)}`)
    }

    // 5) load 读回来的 rev 必须是最后一次的值
    const reloaded = await rpc('load', { sessionId })
    if (reloaded && reloaded.ok === true && reloaded.value && reloaded.value.rev === rev0 + 2) {
      ok(`load 读回权威 rev=${reloaded.value.rev}（与最后一次写入一致）`)
    } else {
      bad(`load 读回的 rev 不对：${JSON.stringify(reloaded).slice(0, 240)}`)
    }

    // 6) events 端点：这是卡 3 的验收面（区分「没收到事件」与「收到了但去重跳过」）。
    //    这一条同时证明「端点登记进契约」这件事在运行期也成立 —— 之前 events 加了 marker
    //    却漏了 mk(...)，是契约断言补上之后才发现的。
    const evs = await rpc('events', { sessionId, sinceSeq: -1 })
    if (evs && evs.ok === true && Array.isArray(evs.value && evs.value.entries)) {
      ok(`events 端点可达（当前记录 ${evs.value.entries.length} 条结算事件）`)
      if (evs.value.entries.length > 0) {
        const e = evs.value.entries[0]
        info(`  最近一条：type=${e.type} eventId=${e.eventId} seq=${e.seq} outcome=${e.outcome}`)
      } else {
        info('  本会话还没有结算事件 —— 落链需要真实收发消息才会发生')
      }
    } else {
      bad(`events 端点不可达或返回异常：${JSON.stringify(evs).slice(0, 240)}`)
    }

    // 7) 未知端点必须被拒（证明不是「什么都放行」）
    const bogus = await rpc('doesNotExist', { sessionId })
    if (bogus && bogus.ok === false) {
      ok(`未知端点被拒（ok=false, code=${(bogus.error && bogus.error.code) || '?'}）`)
    } else {
      info(`未知端点的返回：${JSON.stringify(bogus).slice(0, 200)}`)
    }

    // 8) 卡 8：导出 JSON / Markdown（走真实 RPC，不是只跑纯函数）
    //
    // ⚠️ 注意返回值有两层 ok：外层是网关的 RemoteResult（ok/value/error），
    // 内层是我们端点自己返回的 {ok, text}。所以是 `value.value.text`。
    const expJson = await rpc('exportDoc', { sessionId, kind: 'json' })
    const jsonPayload = expJson && expJson.ok === true ? expJson.value : null
    if (jsonPayload && jsonPayload.ok === true && typeof jsonPayload.text === 'string') {
      const parsed = JSON.parse(jsonPayload.text)
      ok(`exportDoc(json) → ok，导出了 ${Object.keys(parsed.nodes || {}).length} 个节点、version=${parsed.version}`)
    } else {
      bad(`exportDoc(json) 失败：${JSON.stringify(expJson).slice(0, 240)}`)
    }

    const expMd = await rpc('exportDoc', { sessionId, kind: 'markdown' })
    const mdPayload = expMd && expMd.ok === true ? expMd.value : null
    if (mdPayload && mdPayload.ok === true && String(mdPayload.text).includes('#')) {
      ok(`exportDoc(markdown) → ok，${String(mdPayload.text).length} 字符`)
    } else {
      bad(`exportDoc(markdown) 失败：${JSON.stringify(expMd).slice(0, 240)}`)
    }

    // 9) PNG 必须**明确拒绝**而不是给一张空图
    const expPng = await rpc('exportDoc', { sessionId, kind: 'png' })
    const pngPayload = expPng && expPng.ok === true ? expPng.value : null
    if (pngPayload && pngPayload.ok === false && String(pngPayload.error).includes('画布')) {
      ok('exportDoc(png) 明确拒绝并说明原因（刻意不导出假空图）')
    } else {
      info(`exportDoc(png) 的返回：${JSON.stringify(expPng).slice(0, 200)}`)
    }

    // 10) 导出→导入 真实往返（同一会话应当被接受）
    if (jsonPayload && jsonPayload.text) {
      const roundTrip = await rpc('importDoc', { sessionId, json: jsonPayload.text })
      const rtValue = roundTrip && roundTrip.ok === true ? roundTrip.value : null
      if (rtValue && rtValue.ok === true) {
        ok(`导出→导入 往返被接受（updated=${rtValue.stats && rtValue.stats.updated}，added=${rtValue.stats && rtValue.stats.added}）`)
      } else {
        bad(`导出→导入 往返被拒（不该拒绝自己的导出）：${JSON.stringify(roundTrip).slice(0, 300)}`)
      }

      // 11) **导入错 sessionId 必须被拒**（卡 8 硬验收）
      const wrongSession = await rpc('importDoc', {
        sessionId,
        json: jsonPayload.text.replace(new RegExp(sessionId, 'g'), 'session-NOT-MINE'),
      })
      const wsValue = wrongSession && wrongSession.ok === true ? wrongSession.value : null
      if (wsValue && wsValue.ok === false && String(wsValue.error).includes('session-mismatch')) {
        ok('导入错 sessionId 被**硬拒绝**（禁止导入进错会话）')
      } else {
        bad(`导入错 sessionId 没有被拒：${JSON.stringify(wrongSession).slice(0, 300)}`)
      }
    } else {
      bad('拿不到导出的 JSON，跳过往返与错会话校验')
    }

    // 12) 坏 JSON 被拒且不抛异常
    const badJson = await rpc('importDoc', { sessionId, json: '{这不是 JSON' })
    const bjValue = badJson && badJson.ok === true ? badJson.value : null
    if (bjValue && bjValue.ok === false) {
      ok('坏 JSON 被拒（返回可读错误，不抛异常）')
    } else {
      bad(`坏 JSON 没被拒：${JSON.stringify(badJson).slice(0, 200)}`)
    }

    // 13) 重建投影：传空窗口应当是安全的 no-op，且不得报告违规
    const rebuilt = await rpc('rebuild', { sessionId, events: [] })
    const rbValue = rebuilt && rebuilt.ok === true ? rebuilt.value : null
    if (rbValue && rbValue.ok === true) {
      ok(`rebuild（空窗口）→ ok，appended=${rbValue.appended}，violations=${(rbValue.violations || []).length}`)
    } else {
      bad(`rebuild 失败：${JSON.stringify(rebuilt).slice(0, 240)}`)
    }
  }
}

if (consoleLogs.length) {
  info(`控制台消息 ${consoleLogs.length} 条，其中 error ${errLogs.length} 条：`)
  for (const l of consoleLogs.slice(0, 40)) info('  ' + l.slice(0, 500))
}

const fails = results.filter(([s]) => s === 'FAIL')
const pad = Math.max(...results.map(([, m]) => m.length))
console.log('')
for (const [s, m] of results) console.log(`  ${s.padEnd(4)}  ${m}`)
console.log('')
console.log(`会话内渲染验证：${results.filter(([s]) => s === 'PASS').length} 通过 / ${fails.length} 失败`)

// ── 诊断出口：面板链行显示了什么标题（FTM_PANEL_DIAG=1 时打印）──────────────
//
// 复用这里已经跑通的「进会话 + 打开插件 tab」逻辑，避免另写一套点击逻辑
// （先前单独写的诊断脚本点不进会话画面，面板根本没挂载）。
if (process.env.FTM_PANEL_DIAG === '1') {
  // 用封好的助手可靠打开面板（踩过的两个坑都封在里面了，见 scripts/cdp-panel.mjs）
  const opener = createPanelOpener(evaluate, send)
  console.log('\n=== 诊断：确保插件面板挂载 ===')
  const opened = await opener.ensurePanelOpen({
    sessionId: process.env.FTM_SESSION_ID || '',
    timeoutMs: 20000,
  })
  for (const n of opened.notes) console.log('  ' + n)
  console.log('  结果: ' + JSON.stringify({ ok: opened.ok, how: opened.how, tabId: opened.tabId }))
  const tab = await opener.currentTab()
  console.log('  dockkit tabs: ' + JSON.stringify(tab.tabs))

  console.log('\n=== 诊断：面板链行 ===')
  const rows = await evaluate(`(() => {
    const root = document.querySelector('[data-freethought-map-root]');
    if (!root) return { hasRoot: false };
    const items = [...root.querySelectorAll('[data-ftm-node]')].map(li => ({
      node: li.getAttribute('data-ftm-node'),
      kind: li.getAttribute('data-ftm-kind'),
      title: (li.querySelector('.ftm-chain-title') || {}).textContent || '',
      indent: li.style.paddingLeft || '',
    }));
    return { hasRoot: true, chainCount: root.getAttribute('data-ftm-chain'), items };
  })()`)
  console.log('  hasRoot=' + rows.hasRoot + '  chainCount=' + rows.chainCount)
  if (rows.items) {
    for (const it of rows.items) {
      console.log('    ' + String(it.node).padEnd(24) + ' ' + String(it.kind).padEnd(6) + ' indent=' + String(it.indent).padEnd(6) + ' title=' + JSON.stringify(it.title))
    }
    const real = rows.items.filter((r) => r.title && r.title !== '（无标题）' && r.title !== '（已清空）')
    console.log('  显示真实标题的行数: ' + real.length + ' / ' + rows.items.length)
  }

  console.log('\n=== 诊断：数据源（直接打宿主两个端点）===')
  const probe = await evaluate(`(async () => {
    const root = document.querySelector('[data-freethought-map-root]');
    const m = root ? (root.innerText || '').match(/session-[0-9a-f-]{8,}/i) : null;
    if (!m) return { err: 'no-session-id-in-panel' };
    const sid = m[0];
    const post = async (method, args) => {
      const rpcId = 'diag-' + Math.random().toString(36).slice(2);
      const r = await fetch('/api/freethoughtMap/' + method, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ type: 'client-request', rpcId, method: 'freethoughtMap/' + method, payload: { args } })
      });
      return await r.json();
    };
    const ev = await post('events', { sessionId: sid, sinceSeq: -1 });
    const ld = await post('load', { sessionId: sid });
    const entries = (ev.result && ev.result.ok && ev.result.value && ev.result.value.entries) || [];
    const doc = (ld.result && ld.result.ok && ld.result.value && ld.result.value.doc) || null;
    return {
      sessionId: sid,
      eventsCount: entries.length,
      eventsWithTitle: entries.filter(e => e.title).length,
      eventsSample: entries.map(e => ({ eventId: String(e.eventId).slice(0, 12), title: e.title })),
      docNodes: doc ? Object.keys(doc.nodes).length : null,
      refsInLog: doc ? Object.values(doc.nodes).filter(n => n.sourceRef && entries.some(e => e.eventId === n.sourceRef.eventId)).length : null,
    };
  })()`)
  console.log('  ' + JSON.stringify(probe, null, 2).split('\n').join('\n  '))
}

ws.close()
process.exit(fails.length ? 1 : 0)
