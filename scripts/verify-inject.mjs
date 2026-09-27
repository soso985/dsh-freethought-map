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
import { addFreeLink, createPending, pendingAdd } from '../src/overlay/links.js'
import {
  INJECT_DONE,
  INJECT_EMPTY,
  INJECT_NA,
  computeInjection,
  consumeInjectedSnapshot,
} from '../src/overlay/inject.js'

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
