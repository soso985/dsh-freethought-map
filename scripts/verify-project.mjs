/**
 * 卡 3 落链自测 —— 用**合成事件**覆盖规格 §6.3–6.5 与 §7 的每一条规则。
 *
 * 为什么可以合成：落链逻辑全在 `src/overlay/project.js` 里，是纯函数；
 * 事件形状是从宿主源码核对出来的（见该文件顶部注释）。所以这里不需要真的发消息、
 * 不烧 token，就能把 D3-1 ~ D3-8 里**不依赖真实会话**的部分全部钉死。
 *
 * 需要真实会话才能验的两条（D3-2 的时序、D3-6 的拖动竞争）在
 * `scripts/verify-session.ps1` 的真浏览器链路上另有覆盖。
 *
 * 用法：
 *   node scripts/verify-project.mjs
 */
import assert from 'node:assert/strict'
import {
  SettlementLog,
  applyProjection,
  backfill,
  eventIdOf,
  isAppendSurfaceEvent,
  planProjection,
  pruneOrphanTurns,
  removeNode,
  settlementKindOf,
  sourceRefOf,
  textOf,
} from '../src/overlay/project.js'
import { createOverlay, validateOverlay } from '../src/overlay/index.js'

const results = []
let passed = 0
function test(name, fn) {
  try {
    fn()
    passed += 1
    results.push(['PASS', name, ''])
  } catch (e) {
    results.push(['FAIL', name, e.message])
  }
}

// ───────────────────────────── 合成事件工厂 ─────────────────────────────
//
// 形状对照宿主源码（见 project.js 顶部）：
//   envelope: { type, seq, time, data, surfaceOp }
//   user/message data: { id, role:'user', content, source:{kind:'user'} }
//   assistant/message data: { turn, step, message:{id,role:'assistant',content}, stream }
let SEQ = 0
function resetSeq() {
  SEQ = 0
}
function userEvent(id, text) {
  SEQ += 1
  return {
    type: 'user/message',
    seq: SEQ,
    time: 1700000000000 + SEQ,
    surfaceOp: 'append',
    data: { id, role: 'user', content: [{ type: 'text', text }], source: { kind: 'user' } },
  }
}
function assistantEvent(id, text, extra = {}) {
  SEQ += 1
  return {
    type: 'assistant/message',
    seq: SEQ,
    time: 1700000000000 + SEQ,
    surfaceOp: 'append',
    data: {
      turn: 1,
      step: 1,
      message: { id, role: 'assistant', content: [{ type: 'text', text }] },
      stream: [],
      ...extra,
    },
  }
}
/** 替换副本：surfaceOp 是对象，**不是** append */
function replacementCopy(id, text) {
  const e = assistantEvent(id, text)
  e.surfaceOp = { op: 'replace', startSeq: 1, endSeq: 2 }
  return e
}
function toolResultEvent() {
  SEQ += 1
  return {
    type: 'tool/result',
    seq: SEQ,
    time: 1700000000000 + SEQ,
    surfaceOp: 'append',
    data: { turn: 1, step: 1, message: { id: 'tool-1', role: 'tool' } },
  }
}

/** 确定化的 id 生成器，便于断言 */
function idGen() {
  let n = 0
  return () => 'N' + String(++n)
}

/**
 * 把一串事件喂进一个新 overlay，模拟真实前端的落链循环：
 *   · 记住「时间线上前一个 turn 节点」（补链前驱）
 *   · 记住「最近一条 user 节点」（assistant 都要配到它上面）
 *   · 焦点跟随由 provider 实现（无头模式 = focusId 跟随最新 user 节点）
 * 返回 doc、每步动作、以及被跳过的原因。
 */
function feed(events, ctxByIndex = {}) {
  const newId = idGen()
  let doc = createOverlay('s1')
  const plans = []
  let prevTurnId = null
  let lastUserId = null
  events.forEach((event, i) => {
    const plan = planProjection(doc, event, {
      prevTurnId,
      ...(lastUserId !== null ? { userNodeIdForAssistant: lastUserId } : {}),
      ...(ctxByIndex[i] || {}),
    })
    plans.push(plan)
    if (plan.action === 'append-turn') {
      doc = applyProjection(doc, plan, { newId })
      const ids = Object.keys(doc.nodes)
      const addedId = ids[ids.length - 1]
      prevTurnId = addedId
      if (plan.kind === 'user-message') lastUserId = addedId
    }
  })
  return { doc, plans, lastUserId }
}

// ───────────────────────────── 事件识别（规格 §6.3） ─────────────────────────────

test('isAppendSurfaceEvent：接收 append 结算', () => {
  resetSeq()
  assert.equal(isAppendSurfaceEvent(userEvent('u1', 'hi')), true)
  assert.equal(isAppendSurfaceEvent(assistantEvent('a1', 'yo')), true)
})

test('isAppendSurfaceEvent：**排除**替换副本（否则同一结算被消费两次）', () => {
  resetSeq()
  const rep = replacementCopy('a1', 'regenerated')
  assert.equal(isAppendSurfaceEvent(rep), false)
  assert.equal(settlementKindOf(rep), null)
})

test('isAppendSurfaceEvent：非 surface 类型与缺标记都排除', () => {
  resetSeq()
  const streamFrame = { type: 'assistant/live-chunk', seq: 9, data: {} }
  assert.equal(isAppendSurfaceEvent(streamFrame), false)
  const noMarker = { type: 'user/message', seq: 9, data: { id: 'x' } }
  assert.equal(isAppendSurfaceEvent(noMarker), false)
})

test('settlementKindOf：assistant 的 interrupted 不算成功结算', () => {
  resetSeq()
  const interrupted = assistantEvent('a1', '半截', { interrupted: true })
  assert.equal(settlementKindOf(interrupted), null, '中止的 assistant 不得建节点')
})

test('settlementKindOf：非 user 来源的 user/message 不算用户结算', () => {
  resetSeq()
  const e = userEvent('u1', 'system injected')
  e.data.source = { kind: 'context' }
  assert.equal(settlementKindOf(e), null)
})

test('settlementKindOf：tool/result 不建节点（规格 §6.3）', () => {
  resetSeq()
  assert.equal(settlementKindOf(toolResultEvent()), null)
})

test('eventIdOf：user 取 data.id，assistant 取 data.message.id', () => {
  resetSeq()
  assert.equal(eventIdOf(userEvent('u-42', 'x')), 'u-42')
  assert.equal(eventIdOf(assistantEvent('a-7', 'y')), 'a-7')
})

test('eventIdOf：都没有时退回 seq（信封本身无 id 字段）', () => {
  const e = { type: 'user/message', seq: 12, surfaceOp: 'append', data: { content: [] } }
  assert.equal(eventIdOf(e), 'seq:12')
})

test('textOf：从 content 块数组里取 text', () => {
  resetSeq()
  assert.equal(textOf(userEvent('u1', '第一行\n第二行')), '第一行\n第二行')
  const e = userEvent('u2', '')
  e.data.content = [{ type: 'text', text: 'A' }, { type: 'image' }, { type: 'text', text: 'B' }]
  assert.equal(textOf(e), 'A\nB')
})

test('sourceRefOf：两种结算各自的 kind 正确', () => {
  resetSeq()
  assert.deepEqual(sourceRefOf(userEvent('u1', 'x')), { kind: 'user-message', eventId: 'u1' })
  assert.deepEqual(sourceRefOf(assistantEvent('a1', 'y')), {
    kind: 'assistant-settlement',
    eventId: 'a1',
  })
})

// ───────────────────────────── D3-1：U1→A1→U2→A2 ─────────────────────────────

test('D3-1：模拟真实前端行为时链为 U1→A1→U2→A2', () => {
  resetSeq()
  const { doc, plans } = feed([
    userEvent('u1', '第一个问题'),
    assistantEvent('a1', '第一个回答'),
    userEvent('u2', '第二个问题'),
    assistantEvent('a2', '第二个回答'),
  ])
  const byRef = (id) =>
    Object.values(doc.nodes).find((n) => n.sourceRef && n.sourceRef.eventId === id)
  const u1 = byRef('u1')
  const a1 = byRef('a1')
  const u2 = byRef('u2')
  const a2 = byRef('a2')
  assert.ok(u1 && a1 && u2 && a2, '四个节点都要在')
  assert.equal(u1.parentId, null, 'U1 是顶层')
  assert.equal(a1.parentId, u1.id, 'A1 挂 U1')
  assert.equal(u2.parentId, a1.id, 'U2 挂 A1（说明 A1 到达时抢到了焦点）')
  assert.equal(a2.parentId, u2.id, 'A2 挂 U2')
  // 四个动作都必须是 append，且两个 assistant 都跟了焦点（因为那一刻焦点正停在对应 U 上）
  assert.deepEqual(plans.map((p) => p.action), [
    'append-turn',
    'append-turn',
    'append-turn',
    'append-turn',
  ])
  assert.deepEqual(plans.map((p) => p.followFocus), [true, true, true, true])
})

test('D3-1b：焦点跟随规则本身 —— 只有焦点仍停在对应 U 上，AI 才抢', () => {
  resetSeq()
  const newId = idGen()
  let doc = createOverlay('s1')
  doc = applyProjection(doc, planProjection(doc, userEvent('u1', '问题'), {}), { newId })
  const u1 = doc.focusId
  // 焦点还在 U1 → 跟随
  const follow = planProjection(doc, assistantEvent('a1', '答'), {
    prevTurnId: u1,
    userNodeIdForAssistant: u1,
  })
  assert.equal(follow.followFocus, true)
  // 焦点被移走 → 不跟随，但父节点不变
  const moved = { ...doc, focusId: u1 + '-other' }
  const noFollow = planProjection(moved, assistantEvent('a1', '答'), {
    prevTurnId: u1,
    userNodeIdForAssistant: u1,
  })
  assert.equal(noFollow.followFocus, false)
  assert.equal(noFollow.parentId, u1, '不抢焦点 ≠ 不落链')
})

// ───────────────────────────── D3-2：等待期间改焦点，AI 不抢 ─────────────────────────────

test('D3-2：等待 A1 时焦点切到 F，A1 仍挂 U1；之后 U2 挂 F', () => {
  resetSeq()
  const newId = idGen()
  let doc = createOverlay('s1')

  // U1
  let plan = planProjection(doc, userEvent('u1', '问题一'), { prevTurnId: null })
  doc = applyProjection(doc, plan, { newId })
  const u1 = doc.focusId
  assert.equal(doc.focusId, u1, '用户发完，焦点在 U1')

  // 等待期间用户手建一个节点 F 并点它 → 焦点离开 U1
  doc = {
    ...doc,
    nodes: {
      ...doc.nodes,
      F: { id: 'F', kind: 'manual', parentId: null, position: { x: 0, y: 500 } },
    },
    focusId: 'F',
  }

  // A1 到达：不得抢焦点，但仍挂 U1
  plan = planProjection(doc, assistantEvent('a1', '回答一'), {
    prevTurnId: u1,
    userNodeIdForAssistant: u1,
  })
  assert.equal(plan.followFocus, false, '焦点已不在 U1 上，AI 不得抢焦点')
  doc = applyProjection(doc, plan, { newId })
  const a1 = Object.values(doc.nodes).find((n) => n.sourceRef && n.sourceRef.eventId === 'a1')
  assert.equal(a1.parentId, u1, 'A1 仍挂在它对应的用户节点下')
  assert.equal(doc.focusId, 'F', '焦点保持在被用户点过的 F 上')

  // 用户从 F 发送 U2 → 父节点是 F（发送快照）
  plan = planProjection(doc, userEvent('u2', '问题二'), { parentIdAtSend: 'F' })
  doc = applyProjection(doc, plan, { newId })
  const u2 = Object.values(doc.nodes).find((n) => n.sourceRef && n.sourceRef.eventId === 'u2')
  assert.equal(u2.parentId, 'F', 'U2 挂 F（发送瞬间快照），不是挂最后焦点')
})

// ───────────────────────────── D3-3：排队两条各用各自快照 ─────────────────────────────

test('D3-3：排队两条发送，各用发送时的父节点，不都挂到最后焦点', () => {
  resetSeq()
  const newId = idGen()
  let doc = createOverlay('s1')
  doc = {
    ...doc,
    nodes: {
      P1: { id: 'P1', kind: 'manual', parentId: null, position: { x: 0, y: 0 } },
      P2: { id: 'P2', kind: 'manual', parentId: null, position: { x: 0, y: 200 } },
    },
  }
  // 快照在**发送瞬间**取：第一条从 P1 发，第二条从 P2 发
  let plan = planProjection(doc, userEvent('u1', '甲'), { parentIdAtSend: 'P1' })
  doc = applyProjection(doc, plan, { newId })
  plan = planProjection(doc, userEvent('u2', '乙'), { parentIdAtSend: 'P2' })
  doc = applyProjection(doc, plan, { newId })

  const byRef = (id) => Object.values(doc.nodes).find((n) => n.sourceRef && n.sourceRef.eventId === id)
  assert.equal(byRef('u1').parentId, 'P1')
  assert.equal(byRef('u2').parentId, 'P2', '第二条用它自己的快照，不是「当时最新焦点」')
})

// ───────────────────────────── D3-4：重放不复制 ─────────────────────────────

test('D3-4：同一结算重放不复制节点（no-op）', () => {
  resetSeq()
  const { doc, plans } = feed([
    userEvent('u1', '问题'),
    assistantEvent('a1', '回答'),
    userEvent('u1', '问题'),
    assistantEvent('a1', '回答'),
  ])
  assert.equal(Object.keys(doc.nodes).length, 2, '重放不得新建')
  assert.equal(plans[2].action, 'noop')
  assert.equal(plans[2].reason, 'already-projected')
  assert.equal(plans[3].reason, 'already-projected')
})

test('D3-4b：重放时绝不改 parentId / position / 注解', () => {
  resetSeq()
  const newId = idGen()
  let doc = createOverlay('s1')
  doc = applyProjection(doc, planProjection(doc, userEvent('u1', '问题'), {}), { newId })
  const id = doc.focusId
  // 用户把节点拖走并改父 + 加注解
  doc = {
    ...doc,
    nodes: {
      ...doc.nodes,
      [id]: {
        ...doc.nodes[id],
        parentId: null,
        position: { x: 999, y: 888 },
        title: '我的注解',
      },
    },
  }
  const before = JSON.stringify(doc)
  const plan = planProjection(doc, userEvent('u1', '问题'), { prevTurnId: id })
  assert.equal(plan.action, 'noop')
  assert.equal(JSON.stringify(doc), before, '重放必须是彻底的 no-op')
})

// ───────────────────────────── D3-5：补链不得挂到当前焦点 ─────────────────────────────

test('D3-5：打开旧会话补链，不把旧节点挂到当前焦点', () => {
  resetSeq()
  const newId = idGen()
  // 先造一个「当前焦点」存在的空 overlay
  let doc = createOverlay('s1')
  doc = {
    ...doc,
    nodes: { CUR: { id: 'CUR', kind: 'manual', parentId: null, position: { x: 0, y: 0 } } },
    focusId: 'CUR',
  }
  const events = [
    userEvent('u1', '很久以前的问题'),
    assistantEvent('a1', '很久以前的回答'),
    userEvent('u2', '后来的问题'),
  ]
  const r = backfill(doc, events, { newId })
  const byRef = (id) =>
    Object.values(r.doc.nodes).find((n) => n.sourceRef && n.sourceRef.eventId === id)
  assert.equal(r.appended, 3)
  assert.equal(byRef('u1').parentId, null, 'U1 是链头，不该挂到 CUR')
  assert.equal(byRef('a1').parentId, byRef('u1').id)
  assert.equal(byRef('u2').parentId, byRef('a1').id)
  assert.equal(r.doc.focusId, 'CUR', '补链不得移动焦点')
})

test('D3-5b：补链跳过已存在的 sourceRef，且接得上链', () => {
  resetSeq()
  const newId = idGen()
  const events = [userEvent('u1', '一'), assistantEvent('a1', '二'), userEvent('u2', '三')]
  const first = backfill(createOverlay('s1'), events, { newId })
  // 再补一次：全部已存在 → 一个都不加
  const second = backfill(first.doc, events, { newId })
  assert.equal(second.appended, 0)
  assert.equal(second.skipped, 3)
  assert.equal(JSON.stringify(second.doc.nodes), JSON.stringify(first.doc.nodes))
})

test('D3-5c：补链跳过 hidden（摘除过的不能被复活）', () => {
  resetSeq()
  const newId = idGen()
  const events = [userEvent('u1', '一'), assistantEvent('a1', '二')]
  const first = backfill(createOverlay('s1'), events, { newId })
  const u1 = Object.values(first.doc.nodes).find((n) => n.sourceRef.eventId === 'u1')
  const removed = removeNode(first.doc, u1.id)
  assert.equal(removed.hidden.length, 1, '摘除要写进 hidden')
  const again = backfill(removed, events, { newId })
  assert.equal(again.appended, 0, 'hidden 的结算不得被补链复活')
  assert.equal(
    Object.values(again.doc.nodes).some((n) => n.sourceRef && n.sourceRef.eventId === 'u1'),
    false,
  )
})

// ───────────────────────────── 幽灵清理（规格 §6.3 末） ─────────────────────────────

test('幽灵投影：canonical 里消失的 sourceRef 自动摘除，子节点上提', () => {
  resetSeq()
  const { doc } = feed([userEvent('u1', '一'), assistantEvent('a1', '二'), userEvent('u2', '三')])
  const byRef = (id) => Object.values(doc.nodes).find((n) => n.sourceRef && n.sourceRef.eventId === id)
  const u1 = byRef('u1')
  const u2 = byRef('u2')
  // canonical 里只剩 u1 和 u2（a1 被官方重新生成替换掉了）
  const live = new Set(['user-message:u1', 'user-message:u2'])
  const r = pruneOrphanTurns(doc, live)
  assert.equal(r.removed.length, 1, '幽灵节点要被摘掉')
  const a1 = byRef('a1')
  assert.equal(r.doc.nodes[a1.id], undefined, 'A1 记录应被删除')
  assert.ok(
    r.doc.hidden.some((h) => h.kind === 'assistant-settlement' && h.eventId === 'a1'),
    '摘除要写进 hidden（补链才不会建回来）',
  )
  assert.equal(r.doc.nodes[u2.id].parentId, u1.id, 'U2 上提到 A1 原来的父节点')
})

// ───────────────────────────── 摘除规则（规格 §6.6） ─────────────────────────────

test('摘除：子节点上提一级、粉线删除、hidden 记录 sourceRef、焦点回退到父', () => {
  resetSeq()
  const { doc } = feed([userEvent('u1', '一'), assistantEvent('a1', '二')])
  const byRef = (id) => Object.values(doc.nodes).find((n) => n.sourceRef && n.sourceRef.eventId === id)
  const u1 = byRef('u1')
  const a1 = byRef('a1')
  const withLink = {
    ...doc,
    freeLinks: [{ id: 'L1', a: u1.id, b: a1.id }],
    focusId: a1.id,
  }
  const r = removeNode(withLink, a1.id)
  assert.equal(r.nodes[a1.id], undefined)
  assert.equal(r.freeLinks.length, 0, '相连粉线要删掉')
  assert.equal(r.focusId, u1.id, '焦点回退到被删节点的父')
  assert.ok(r.hidden.some((h) => h.eventId === 'a1'))
})

test('摘除：手建节点不写 hidden（它没有 sourceRef）', () => {
  resetSeq()
  const doc = createOverlay('s1')
  doc.nodes.M = { id: 'M', kind: 'manual', parentId: null, position: { x: 0, y: 0 } }
  const r = removeNode(doc, 'M')
  assert.equal(r.hidden.length, 0)
  assert.equal(Object.keys(r.nodes).length, 0)
})

test('摘除后再投影同一结算：仍是 no-op（hidden 生效）', () => {
  resetSeq()
  const newId = idGen()
  let doc = createOverlay('s1')
  doc = applyProjection(doc, planProjection(doc, userEvent('u1', '一'), {}), { newId })
  const id = doc.focusId
  doc = removeNode(doc, id)
  const plan = planProjection(doc, userEvent('u1', '一'), {})
  assert.equal(plan.action, 'noop')
  assert.equal(plan.reason, 'hidden')
})

// ───────────────────────────── 派生标题不写进 overlay（规格 §6.4） ─────────────────────────────

test('派生标题只用于显示：投影节点不带 title 字段', () => {
  resetSeq()
  // 注意：这里必须给一段**真的超过 24 字**的文本，否则根本不会触发截断
  // （第一次写测试时数错了字数，23 字被当成"应该截断"，是测试错不是实现错）
  const long = '这是一段确实超过二十四个字的用户提问内容用来验证派生标题的截断行为'
  assert.ok(long.length > 24, '前置：测试文本必须超过 24 字，实际 ' + long.length)
  const plan = planProjection(createOverlay('s1'), userEvent('u1', long), {})
  assert.equal(plan.title.length, 25, '派生标题应是 24 字 + 省略号')
  assert.ok(plan.title.endsWith('…'), '结尾要有省略号')
  assert.ok(long.startsWith(plan.title.slice(0, 24)), '截断必须取自原文开头')

  // 关键：派生标题绝不写进 overlay —— 节点上的 title 是**注解**字段
  const doc = applyProjection(createOverlay('s1'), plan, { newId: idGen() })
  const node = Object.values(doc.nodes)[0]
  assert.equal(node.title, undefined, 'overlay 节点上不得出现 title（那是注解字段）')
})

test('投影出来的 overlay 始终能通过 validateOverlay', () => {
  resetSeq()
  const { doc } = feed([
    userEvent('u1', '一'),
    assistantEvent('a1', '二'),
    userEvent('u2', '三'),
    assistantEvent('a2', '四'),
  ])
  const v = validateOverlay(doc)
  assert.deepEqual(v, { ok: true, errors: [] })
})

// ───────────────────────────── 会话隔离（规格 §7：历史按 sessionId 隔离） ─────────────────────────────

test('SettlementLog：按会话隔离，且能按 seq 增量读', () => {
  resetSeq()
  const log = new SettlementLog(10)
  const e1 = userEvent('u1', '一')
  const e2 = assistantEvent('a1', '二')
  log.record('s1', e1, 'appended')
  log.record('s1', e2, 'noop')
  log.record('s2', e1, 'appended')
  assert.equal(log.list('s1').length, 2)
  assert.equal(log.list('s2').length, 1)
  assert.equal(log.list('s1', e1.seq).length, 1, '增量读只给更新的')
  assert.equal(log.list('s3').length, 0)
})

test('SettlementLog：超过上限时丢最旧的', () => {
  resetSeq()
  const log = new SettlementLog(3)
  for (let i = 0; i < 6; i += 1) log.record('s1', userEvent('u' + i, 'x'), 'appended')
  assert.equal(log.list('s1').length, 3)
  assert.equal(log.list('s1')[0].eventId, 'u3')
})

// ───────────────────────────── 报告 ─────────────────────────────
const fails = results.filter(([s]) => s === 'FAIL')
const pad = Math.max(...results.map(([, n]) => n.length))
console.log('')
for (const [status, name, msg] of results) {
  console.log(`  ${status}  ${name.padEnd(pad)}${msg ? '  ← ' + msg : ''}`)
}
console.log('')
console.log(`落链自测：${passed} 通过 / ${fails.length} 失败（共 ${results.length} 条）`)
process.exit(fails.length ? 1 : 0)
