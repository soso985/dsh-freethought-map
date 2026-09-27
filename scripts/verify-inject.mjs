/**
 * 卡 5「注入是否真的生效」的**离线端到端**验证。
 *
 * 这一套替代了原本「必须真发一条消息才能验」的计划 —— 因为把决策逻辑抽成
 * `computeInjection` 纯函数之后，给假的 decision + 假 payload + 一份真 overlay，
 * 就能把整条注入链路验死：注入了什么文本、插在哪个位置、什么时候不注入、重试是否复用快照。
 *
 * **没有模型、没有网络、没有 token。**
 *
 * 剩下唯一必须真实发送才能确认的，只有「宿主确实在真实请求上调了这个钩子」——
 * 那是接线问题，已由 `verify-host` 的结构断言 + 本套的行为断言两头夹住。
 *
 * 用法：
 *   node scripts/verify-inject.mjs
 */
import assert from 'node:assert/strict'
import { createOverlay } from '../src/overlay/index.js'
import { addFreeLink, buildDerivedTitleIndex, createPending, pendingAdd } from '../src/overlay/links.js'
import {
  INJECT_DONE,
  INJECT_EMPTY,
  INJECT_NA,
  computeInjection,
  consumeInjectedSnapshot,
} from '../src/overlay/inject.js'
import { classifyPreStep, countInjected, isInjectedMessage } from '../src/overlay/injection-marks.js'

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

// ───────────────────────────── 夹具：模拟一次真实发送 ─────────────────────────────

let idSeq = 0
const uuid = () => 'uuid-' + String(++idSeq)

/** 造一个「用户刚发了一条消息」的 pre-step 现场 */
function fixture(opts = {}) {
  const sessionId = opts.sessionId || 'session-1'

  // overlay：一个焦点节点 +（可选）一条粉线
  let doc = createOverlay(sessionId)
  doc.nodes = {
    F1: {
      id: 'F1',
      kind: 'manual',
      parentId: null,
      position: { x: 0, y: 0 },
      title: '中心主题',
      body: opts.focusBody === undefined ? '这是焦点正文' : opts.focusBody,
    },
    L1: { id: 'L1', kind: 'manual', parentId: 'F1', position: { x: 0, y: 120 }, title: '联想一' },
  }
  doc.focusId = opts.noFocus ? null : 'F1'
  if (opts.withLink) {
    const r = addFreeLink(doc, 'F1', 'L1', { newId: () => 'link-1' })
    doc = r.doc
  }

  // 宿主侧 pending（用户刚拉的线）
  let pending = createPending()
  if (opts.withLink) pending = pendingAdd(pending, 'link-1')

  // pre-step 现场：payload.messages 是"这一轮已接纳的消息"，decision.messages 是下游的数组
  const userMessage = { id: 'U1', role: 'user', content: [{ type: 'text', text: '用户原话' }] }
  const payload = { agent: {}, messages: [userMessage], turn: 1, step: 1, signal: {} }
  const decision = { kind: 'enter', messages: [userMessage] }

  return { doc, pending, payload, decision, sessionId, userMessage }
}

/** 跑一次注入。每次重置 uuid 计数器，让 id 断言与执行顺序无关。 */
function run(opts = {}, extra = {}) {
  const f = fixture(opts)
  idSeq = 0
  const result = computeInjection({
    decision: f.decision,
    payload: f.payload,
    doc: opts.noDoc ? null : f.doc,
    pending: f.pending,
    derivedTitles: opts.derivedTitles || {},
    uuid,
    ...extra,
  })
  return { ...f, result }
}

// ───────────────────────────── 不该注入的情形 ─────────────────────────────

test('决策是 reject → 原样放行，绝不改动', () => {
  const rejected = { kind: 'reject' }
  const r = computeInjection({ decision: rejected, payload: { turn: 1, step: 1 }, doc: createOverlay('s') })
  assert.equal(r.status, INJECT_NA)
  assert.equal(r.decision, rejected, '必须是同一个对象（别人的判断不许动）')
})

test('decision 缺失 → 原样返回，不抛错', () => {
  const r = computeInjection({ decision: undefined, payload: {}, doc: createOverlay('s') })
  assert.equal(r.status, INJECT_NA)
  assert.equal(r.decision, undefined)
})

test('没有权威文档 → 不注入（没有图就没有可注入的东西）', () => {
  const r = run({ noDoc: true })
  assert.equal(r.result.status, INJECT_NA)
  assert.equal(r.result.reason, 'no-doc')
  assert.equal(r.result.decision, r.decision, 'decision 原样返回')
})

test('既无焦点也无粉线 → 不注入（**绝不塞空消息**，那会白花 token）', () => {
  const r = run({ noFocus: false, withLink: false, focusBody: '' })
  // 有焦点但正文为空时仍会注入"当前焦点：《…》"这一行 —— 那是有用的信息
  assert.equal(r.result.status, INJECT_DONE)
  const r2 = run({ noFocus: true, withLink: false })
  assert.equal(r2.result.status, INJECT_EMPTY)
  assert.equal(r2.result.reason, 'nothing-to-inject')
  assert.equal(r2.result.decision, r2.decision, '不注入时 decision 必须原样')
})

// ───────────────────────────── 注入内容 ─────────────────────────────

test('只设焦点 → 注入焦点摘要，带 [用户图数据] 前缀', () => {
  const r = run({ withLink: false })
  assert.equal(r.result.status, INJECT_DONE)
  const text = r.result.meta.text
  assert.ok(text.startsWith('[用户图数据]'), text)
  assert.ok(text.includes('当前焦点：《中心主题》'), text)
  assert.ok(text.includes('这是焦点正文'), text)
  assert.equal(r.result.meta.focusNodeId, 'F1')
  assert.equal(r.result.meta.linkCount, 0)
})

test('焦点 + 粉线 → 两段都注入，粉线写成「用户将《A》与《B》建立自由联想」', () => {
  const r = run({ withLink: true })
  const text = r.result.meta.text
  assert.ok(text.includes('当前焦点：《中心主题》'), text)
  assert.ok(text.includes('用户将《中心主题》与《联想一》建立自由联想'), text)
  assert.equal(r.result.meta.linkCount, 1)
  // 前缀出现两次：两段各带一次（规格 §10.4：均标记为用户图数据）
  assert.equal(text.split('[用户图数据]').length - 1, 2)
})

test('注入消息的形状正确（role/content/source 都是宿主认的）', () => {
  const r = run({ withLink: true })
  const m = r.result.message
  assert.equal(m.role, 'user')
  assert.equal(m.content.length, 1)
  assert.equal(m.content[0].type, 'text')
  assert.equal(m.content[0].text, r.result.meta.text)
  assert.equal(m.source.kind, 'freethought-map')
  assert.equal(m.source.form, 'graph-context')
  assert.equal(m.source.linkCount, 1)
  assert.ok(Object.isFrozen(m), '宿主对已接纳消息做深冻结，这条也必须冻结')
  assert.equal(m.id, 'uuid-1', 'id 由注入的 uuid 生成器给出（便于测试确定化）')
})

// ───────────────────────────── 插入位置 ─────────────────────────────

test('插在**已接纳的用户消息之后**，而不是追加到末尾', () => {
  // 下游在用户消息后又追加了一条上下文消息
  const f = fixture({ withLink: true })
  const downstream = { id: 'CTX', role: 'developer', content: [] }
  const decision = { kind: 'enter', messages: [f.userMessage, downstream] }
  idSeq = 0
  const result = computeInjection({
    decision,
    payload: f.payload,
    doc: f.doc,
    pending: f.pending,
    uuid,
  })
  const ids = result.decision.messages.map((m) => m.id)
  assert.deepEqual(ids, ['U1', 'uuid-1', 'CTX'], '注入必须夹在 U1 与下游消息之间')
  assert.equal(result.meta.insertedAt, 1)
})

test('不改原数组：decision.messages 与 payload.messages 都得原封不动', () => {
  const f = fixture({ withLink: true })
  const beforeDecision = [...f.decision.messages]
  const beforePayload = [...f.payload.messages]
  computeInjection({ decision: f.decision, payload: f.payload, doc: f.doc, pending: f.pending, uuid })
  assert.deepEqual(f.decision.messages, beforeDecision, 'decision.messages 不得被原地改')
  assert.deepEqual(f.payload.messages, beforePayload, 'payload.messages 不得被原地改')
})

test('返回的 decision 保留了其它字段（如 startsRequestSeries）', () => {
  const f = fixture({ withLink: true })
  const decision = { kind: 'enter', messages: [f.userMessage], startsRequestSeries: true }
  const result = computeInjection({ decision, payload: f.payload, doc: f.doc, pending: f.pending, uuid })
  assert.equal(result.decision.startsRequestSeries, true, '展开 decision 时必须保留其它字段')
  assert.equal(result.decision.kind, 'enter')
})

// ───────────────────────────── 重试复用同一份快照 ─────────────────────────────

test('官方重试：复用同一份快照，**不重新采样**（这一次不重复注入新线）', () => {
  const f = fixture({ withLink: true })
  const store = new Map()
  const first = computeInjection({
    decision: { kind: 'enter', messages: [f.userMessage] },
    payload: f.payload,
    doc: f.doc,
    pending: f.pending,
    snapshotStore: store,
    uuid,
  })
  assert.equal(first.status, INJECT_DONE)
  assert.equal(first.meta.snapshotKey, 'session-1:1:1')

  // 重试期间用户又拉了一条线 —— 若重新采样就会多注入一条
  const morePending = pendingAdd(f.pending, 'link-2')
  const retry = computeInjection({
    decision: { kind: 'enter', messages: [f.userMessage] },
    payload: f.payload, // 同一次发送：turn/step 不变
    doc: f.doc,
    pending: morePending,
    snapshotStore: store,
    uuid,
  })
  assert.equal(retry.status, INJECT_DONE)
  assert.equal(retry.meta.linkCount, first.meta.linkCount, '重试必须复用快照，不能多注入')
  assert.equal(retry.meta.snapshotKey, first.meta.snapshotKey)
  assert.equal(store.size, 1, '同一 key 只存一份')
})

test('不同的 turn/step 各拿各的快照（下一次发送要重新采样）', () => {
  const f = fixture({ withLink: true })
  const store = new Map()
  computeInjection({
    decision: { kind: 'enter', messages: [f.userMessage] },
    payload: { ...f.payload, turn: 1, step: 1 },
    doc: f.doc,
    pending: f.pending,
    snapshotStore: store,
    uuid,
  })
  const morePending = pendingAdd(f.pending, 'link-2')
  const second = computeInjection({
    decision: { kind: 'enter', messages: [f.userMessage] },
    payload: { ...f.payload, turn: 2, step: 1 },
    doc: f.doc,
    pending: morePending,
    snapshotStore: store,
    uuid,
  })
  assert.equal(second.meta.snapshotKey, 'session-1:2:1')
  assert.equal(store.size, 2)
})

// ───────────────────────────── 边界 ─────────────────────────────

test('焦点指向已删节点 → 只注入粉线（不注入幽灵焦点）', () => {
  const f = fixture({ withLink: true })
  const doc = { ...f.doc, focusId: 'GHOST' }
  const result = computeInjection({
    decision: { kind: 'enter', messages: [f.userMessage] },
    payload: f.payload,
    doc,
    pending: f.pending,
    uuid,
  })
  assert.equal(result.status, INJECT_DONE)
  assert.equal(result.meta.focusNodeId, null, '幽灵焦点不得成为 focusNodeId')
  assert.ok(!result.meta.text.includes('当前焦点'), '不得注入幽灵焦点摘要')
  assert.ok(result.meta.text.includes('建立自由联想'), '粉线照常注入')
})

test('粉线端点在发送后已被删 → 只注入焦点摘要，且记 skipped', () => {
  const f = fixture({ withLink: true })
  const doc = { ...f.doc, freeLinks: [] } // 用户把线删了
  const result = computeInjection({
    decision: { kind: 'enter', messages: [f.userMessage] },
    payload: f.payload,
    doc,
    pending: f.pending,
    uuid,
  })
  assert.equal(result.status, INJECT_DONE)
  assert.equal(result.meta.linkCount, 0)
  assert.equal(result.meta.skippedLinks, 1, '被跳过的条数要记账')
})

test('同一轮跑两次注入会插两条（宿主只调一次；这条断言是为了说明它不是幂等的）', () => {
  // 说明性断言：computeInjection 本身不做去重，去重靠"宿主每轮只调一次"。
  // 写下来是为了将来若有人改成重试路径，能立刻看到这条语义。
  const f = fixture({ withLink: true })
  const first = computeInjection({
    decision: { kind: 'enter', messages: [f.userMessage] },
    payload: f.payload,
    doc: f.doc,
    pending: f.pending,
    uuid,
  })
  const second = computeInjection({
    decision: first.decision,
    payload: f.payload,
    doc: f.doc,
    pending: f.pending,
    uuid,
  })
  assert.equal(second.decision.messages.length, 3, '两次调用会插两条 —— 调用方负责只调一次')
})

// ───────────────────────────── 消费（规格 §10.3 第 2 条） ─────────────────────────────

test('消费：用户消息落盘后，被注入用掉的粉线从 pending 移出', () => {
  let pending = createPending()
  pending = pendingAdd(pending, 'link-1')
  pending = pendingAdd(pending, 'link-2')
  const after = consumeInjectedSnapshot(pending, ['link-1'])
  assert.deepEqual(after.ids, ['link-2'], '只移出快照里用掉的那条')
})

test('消费：快照之后新拉的线**不被**这一次消费掉', () => {
  let pending = createPending()
  pending = pendingAdd(pending, 'link-1')
  const snapshot = ['link-1']
  pending = pendingAdd(pending, 'link-new') // 发送之后用户又拉了一条
  const after = consumeInjectedSnapshot(pending, snapshot)
  assert.deepEqual(after.ids, ['link-new'], '新线必须留下，下次发送才用得上')
})

test('消费：发送后、消费前删线 → 注入已发生，pending 自然什么都不用做', () => {
  let pending = createPending()
  pending = pendingAdd(pending, 'link-1')
  const snapshot = ['link-1']
  // 用户在消息落盘前把线删了（客户端会调 pendingRemove）
  pending = { ids: [] }
  const after = consumeInjectedSnapshot(pending, snapshot)
  assert.deepEqual(after.ids, [], '不报错、不复活')
})

test('消费：空快照不动 pending', () => {
  let pending = createPending()
  pending = pendingAdd(pending, 'link-1')
  assert.deepEqual(consumeInjectedSnapshot(pending, []).ids, ['link-1'])
  assert.deepEqual(consumeInjectedSnapshot(pending, undefined).ids, ['link-1'])
})

// ───── 派生标题的两个来源：持久化优先 ─────
//
// 背景（2026-09-27 真机）：派生标题原先只活在内存的 SettlementLog 里，
// 宿主一重启就全失效，注入文案退化成「当前焦点：《（未命名）》」。
// 修法是把标题在投影时持久化到独立的表，重启后读回。
//
// 这一组锁住「注入文案用的是持久化标题」这件事 ——
// 因为它是产品初衷那一环：焦点摘要对模型有没有用，全看名字能不能读出来。

test('持久化标题能经派生索引进入注入文案（重启后旧节点也有名字）', () => {
  const doc = createOverlay('s-title')
  doc.nodes['T-old'] = {
    id: 'T-old',
    kind: 'turn',
    parentId: null,
    position: { x: 0, y: 0 },
    seq: 1,
    sourceRef: { kind: 'user-message', eventId: 'evt-old' },
  }
  doc.focusId = 'T-old'
  // 关键：**没有**内存日志（模拟宿主重启后日志为空），只有持久化标题表
  const derived = buildDerivedTitleIndex(doc, [{ eventId: 'evt-old', title: '456' }])
  const r = computeInjection({
    decision: { kind: 'enter', messages: [{ id: 'u1', role: 'user' }] },
    payload: { sessionId: 's-title', messages: [{ id: 'u1', role: 'user' }] },
    doc,
    pending: createPending(),
    derivedTitles: derived,
    snapshotStore: null,
  })
  assert.equal(r.status, INJECT_DONE)
  assert.match(r.meta.text, /当前焦点：《456》/, '必须用持久化标题，而不是「（未命名）」')
  assert.doesNotMatch(r.meta.text, /（未命名）/, '不得退化成占位符')
})

test('标题不可得的节点仍如实显示（未命名）—— 插件启用前的旧节点就是这个状态', () => {
  const doc = createOverlay('s-title2')
  doc.nodes['T-unknown'] = {
    id: 'T-unknown',
    kind: 'turn',
    parentId: null,
    position: { x: 0, y: 0 },
    seq: 1,
    sourceRef: { kind: 'user-message', eventId: 'evt-never-seen' },
  }
  doc.focusId = 'T-unknown'
  const derived = buildDerivedTitleIndex(doc, [{ eventId: 'evt-other', title: '别的' }])
  const r = computeInjection({
    decision: { kind: 'enter', messages: [{ id: 'u1', role: 'user' }] },
    payload: { sessionId: 's-title2', messages: [{ id: 'u1', role: 'user' }] },
    doc,
    pending: createPending(),
    derivedTitles: derived,
    snapshotStore: null,
  })
  assert.equal(r.status, INJECT_DONE)
  assert.match(r.meta.text, /当前焦点：《（未命名）》/, '读不到标题时要如实说「未命名」，不能假装有名字')
})

test('注解优先于持久化标题（用户的注解永远赢）', () => {
  const doc = createOverlay('s-title3')
  doc.nodes['T-a'] = {
    id: 'T-a',
    kind: 'turn',
    parentId: null,
    position: { x: 0, y: 0 },
    seq: 1,
    title: '我的注解',
    sourceRef: { kind: 'user-message', eventId: 'evt-a' },
  }
  doc.focusId = 'T-a'
  const derived = buildDerivedTitleIndex(doc, [{ eventId: 'evt-a', title: '原文' }])
  const r = computeInjection({
    decision: { kind: 'enter', messages: [{ id: 'u1', role: 'user' }] },
    payload: { sessionId: 's-title3', messages: [{ id: 'u1', role: 'user' }] },
    doc,
    pending: createPending(),
    derivedTitles: derived,
    snapshotStore: null,
  })
  assert.match(r.meta.text, /当前焦点：《我的注解》/)
  assert.doesNotMatch(r.meta.text, /原文/)
})

// ───── 「每步都注入是否重复」的判据（原探针保留下来的那部分）─────
//
// 真机结论（2026-09-27）：payloadInjected = 0 且 decisionInjected = 0
// ⇒ 每个 step 都是全新批次 ⇒ 每步注入是**必要**的，不是重复。
// 这几条把判据本身的行为锁住 —— 它现在是产品逻辑（pre-step 会调它），不再是诊断代码。

const INJ_MARK = { kind: 'freethought-map', form: 'graph-context' }
const injectedMsg = (id) => ({ id, role: 'user', content: [{ type: 'text', text: 'x' }], source: INJ_MARK })
const userMsg = (id) => ({ id, role: 'user', content: [{ type: 'text', text: 'hi' }] })

test('识别注入消息走 source.kind/form —— 不按文本前缀（前缀会被用户原文冒充）', () => {
  assert.equal(isInjectedMessage(injectedMsg('m1')), true)
  assert.equal(isInjectedMessage(userMsg('m2')), false)
  // 用户自己打出前缀字样，也不算我们的注入
  const fake = { id: 'm3', role: 'user', content: [{ type: 'text', text: '[用户图数据]\n当前焦点：《x》' }] }
  assert.equal(isInjectedMessage(fake), false, '文本里有前缀不能被当成我们的注入')
  assert.equal(isInjectedMessage(null), false)
  assert.equal(countInjected([userMsg('a'), injectedMsg('b'), injectedMsg('c')]), 2)
  assert.equal(countInjected(undefined), 0)
})

test('判据：payload/decision 里都没有注入 → needsInjection=true（本步是干净批次）', () => {
  const f = classifyPreStep({
    payload: { turn: 7, step: 1, messages: [userMsg('u1')] },
    originalDecision: { kind: 'enter', messages: [userMsg('u1')] },
  })
  assert.equal(f.payloadInjected, 0)
  assert.equal(f.decisionInjected, 0)
  assert.equal(f.needsInjection, true, '干净批次必须注入，否则该步没有图上下文')
  assert.equal(f.payloadMessages, 1)
  assert.equal(f.turn, 7)
  assert.equal(f.step, 1)
})

test('判据：上下文里已经带着我们的注入 → needsInjection=false（再插就是重复）', () => {
  const f = classifyPreStep({
    payload: { turn: 7, step: 2, messages: [userMsg('u1'), injectedMsg('i1')] },
    originalDecision: { kind: 'enter', messages: [userMsg('u1'), injectedMsg('i1')] },
  })
  assert.equal(f.payloadInjected, 1)
  assert.equal(f.decisionInjected, 1)
  assert.equal(f.needsInjection, false, '已经有注入了，再来一条就是重复花 token')
})

test('判据：changedMessages 按 **id 序列**判（不是按长度或对象引用）', () => {
  const before = [userMsg('u1')]
  const afterInserted = [userMsg('u1'), injectedMsg('i1')]
  const afterSameLengthButDifferent = [userMsg('u2')]

  assert.equal(
    classifyPreStep({ payload: {}, originalDecision: { kind: 'enter', messages: before }, finalDecision: { kind: 'enter', messages: afterInserted } }).changedMessages,
    true,
    '插了一条 → 变了',
  )
  assert.equal(
    classifyPreStep({ payload: {}, originalDecision: { kind: 'enter', messages: before }, finalDecision: { kind: 'enter', messages: before } }).changedMessages,
    false,
    '一模一样 → 没变',
  )
  assert.equal(
    classifyPreStep({ payload: {}, originalDecision: { kind: 'enter', messages: before }, finalDecision: { kind: 'enter', messages: afterSameLengthButDifferent } }).changedMessages,
    true,
    '**长度相同但内容不同也算变了**（这才是 id 序列判据的意义）',
  )
})

test('判据：缺字段不抛错（pre-step 拿不到 decision 时也要安全）', () => {
  const f = classifyPreStep({})
  assert.equal(f.turn, null)
  assert.equal(f.step, null)
  assert.equal(f.payloadMessages, 0)
  assert.equal(f.messagesBefore, null)
  assert.equal(f.needsInjection, true)
  assert.equal(classifyPreStep(null).needsInjection, true)
})

// ───────────────────────────── 报告 ─────────────────────────────
const fails = results.filter(([s]) => s === 'FAIL')
const pad = Math.max(...results.map(([, n]) => n.length))
console.log('')
for (const [status, name, msg] of results) {
  console.log(`  ${status}  ${name.padEnd(pad)}${msg ? '  ← ' + msg : ''}`)
}
console.log('')
console.log(`注入链路自测：${passed} 通过 / ${fails.length} 失败（共 ${results.length} 条）`)
process.exit(fails.length ? 1 : 0)
