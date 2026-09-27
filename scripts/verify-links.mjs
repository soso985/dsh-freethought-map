/**
 * 卡 5 粉线与发送快照自测 —— 覆盖规格 §10.3 / §10.4 的每条规则。
 *
 * 这些全是纯函数，所以注入的「内容对不对」可以完全离线验死。
 * 只有「注入真的进了本轮请求」需要真实发送才能验（见 docs/HOST.md）。
 *
 * 用法：
 *   node scripts/verify-links.mjs
 */
import assert from 'node:assert/strict'
import { createOverlay } from '../src/overlay/index.js'
import {
  MAX_LINKS_PER_SEND,
  USER_GRAPH_PREFIX,
  addFreeLink,
  buildDerivedTitleIndex,
  buildSendSnapshot,
  consumePending,
  createPending,
  displayNameOf,
  forgetSnapshot,
  makeGraphContextMessage,
  makeInjectedUserMessage,
  pendingAdd,
  pendingRemove,
  rememberSnapshot,
  removeFreeLink,
  renderLinkInjection,
  renderSendInjection,
  snapshotPending,
  spliceInjectionAfterClaimed,
} from '../src/overlay/links.js'

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

/** 造一个带 N 个节点的 doc */
function docWith(names, over = {}) {
  const d = createOverlay('s1')
  const nodes = {}
  for (const [id, title] of Object.entries(names)) {
    nodes[id] = { id, kind: 'manual', parentId: null, position: { x: 0, y: 0 }, ...(title === undefined ? {} : { title }) }
  }
  d.nodes = nodes
  return { ...d, ...over }
}

function idGen() {
  let n = 0
  return () => 'L' + String(++n)
}

// ───────────────────────────── 粉线数据模型 ─────────────────────────────

test('addFreeLink：建立粉线，返回新 doc 不改原对象', () => {
  const doc = docWith({ A: '甲', B: '乙' })
  const before = JSON.stringify(doc)
  const r = addFreeLink(doc, 'A', 'B', { newId: idGen() })
  assert.equal(r.ok, true)
  assert.equal(r.doc.freeLinks.length, 1)
  assert.equal(r.doc.freeLinks[0].id, 'L1')
  assert.equal(JSON.stringify(doc), before, '不得改原 doc')
})

test('addFreeLink：拒绝自连、缺端点、重复（无向去重）', () => {
  const doc = docWith({ A: '甲', B: '乙' })
  assert.equal(addFreeLink(doc, 'A', 'A').reason, 'self-link')
  assert.equal(addFreeLink(doc, 'A', 'GHOST').reason, 'missing-endpoint')
  const once = addFreeLink(doc, 'A', 'B', { newId: idGen() }).doc
  assert.equal(addFreeLink(once, 'A', 'B').reason, 'duplicate')
  assert.equal(addFreeLink(once, 'B', 'A').reason, 'duplicate', '反向也算重复（无向）')
})

test('removeFreeLink：删掉指定线', () => {
  const doc = docWith({ A: '甲', B: '乙', C: '丙' })
  const g = idGen()
  let d = addFreeLink(doc, 'A', 'B', { newId: g }).doc
  d = addFreeLink(d, 'B', 'C', { newId: g }).doc
  const r = removeFreeLink(d, 'L1')
  assert.equal(r.freeLinks.length, 1)
  assert.equal(r.freeLinks[0].id, 'L2')
})

// ───────────────────────────── pendingLinkIds 生命周期 ─────────────────────────────

test('pending：拉线加入、重复拉不重复加', () => {
  let p = createPending()
  p = pendingAdd(p, 'L1')
  p = pendingAdd(p, 'L1')
  p = pendingAdd(p, 'L2')
  assert.deepEqual(p.ids, ['L1', 'L2'])
})

test('pending：用户删线则移出（若尚未消费）', () => {
  let p = createPending()
  p = pendingAdd(p, 'L1')
  p = pendingAdd(p, 'L2')
  p = pendingRemove(p, 'L1')
  assert.deepEqual(p.ids, ['L2'])
})

test('快照：发送时复制当时的 pending，之后 pending 变化不影响快照', () => {
  let p = createPending()
  p = pendingAdd(p, 'L1')
  p = pendingAdd(p, 'L2')
  const snap = snapshotPending(p)
  p = pendingAdd(p, 'L3')
  assert.deepEqual(snap, ['L1', 'L2'], '快照是独立副本')
})

test('消费：只移出快照里**仍存在**的 id（发送后又拉的新线不能被吃掉）', () => {
  let p = createPending()
  p = pendingAdd(p, 'L1')
  p = pendingAdd(p, 'L2')
  const snap = snapshotPending(p) // ['L1','L2']
  p = pendingAdd(p, 'L3') // 发送之后用户又拉了一条
  p = pendingRemove(p, 'L2') // 而且删掉了 L2
  const after = consumePending(p, snap)
  assert.deepEqual(after.ids, ['L3'], 'L1 被消费、L2 已不在、L3 必须留下')
})

test('消费：空快照不动 pending', () => {
  let p = createPending()
  p = pendingAdd(p, 'L1')
  assert.deepEqual(consumePending(p, []).ids, ['L1'])
  assert.deepEqual(consumePending(p, undefined).ids, ['L1'])
})

// ───────────────────────────── 发送快照三字段（规格 §6.4） ─────────────────────────────

test('buildSendSnapshot：父节点 = 发送瞬间的焦点', () => {
  const doc = docWith({ A: '甲', B: '乙' }, { focusId: 'B' })
  let p = createPending()
  p = pendingAdd(p, 'L1')
  const s = buildSendSnapshot(doc, p, 'nonce-1')
  assert.equal(s.sendNonce, 'nonce-1')
  assert.equal(s.parentIdAtSend, 'B')
  assert.equal(s.focusIdAtSend, 'B')
  assert.deepEqual(s.newPinkLinksAtSend, ['L1'])
})

test('buildSendSnapshot：焦点指向已不存在的节点 → parentIdAtSend 记 null（新顶层链）', () => {
  const doc = docWith({ A: '甲' }, { focusId: 'GHOST' })
  const s = buildSendSnapshot(doc, createPending(), 'n1')
  assert.equal(s.parentIdAtSend, null)
  assert.equal(s.focusIdAtSend, 'GHOST', 'focusIdAtSend 仍记原值，便于诊断')
})

test('buildSendSnapshot：无焦点 → 两个都 null', () => {
  const doc = docWith({ A: '甲' }, { focusId: null })
  const s = buildSendSnapshot(doc, createPending(), 'n1')
  assert.equal(s.parentIdAtSend, null)
  assert.equal(s.focusIdAtSend, null)
  assert.deepEqual(s.newPinkLinksAtSend, [])
})

// ───────────────────────────── 注入文案（规格 §10.4） ─────────────────────────────

test('注入文案：带 [用户图数据] 前缀，写成「用户将《A》与《B》建立自由联想」', () => {
  let doc = docWith({ A: '注意力残留', B: '番茄钟' })
  const link = addFreeLink(doc, 'A', 'B', { newId: idGen() })
  doc = link.doc
  const r = renderLinkInjection(doc, [link.id])
  assert.ok(r.text.startsWith(USER_GRAPH_PREFIX), '必须有用户图数据前缀')
  assert.ok(r.text.includes('用户将《注意力残留》与《番茄钟》建立自由联想'), r.text)
  assert.equal(r.used.length, 1)
  assert.equal(r.skipped, 0)
})

test('注入文案：快照里有、图里已删的线 → 跳过并计入 skipped', () => {
  let doc = docWith({ A: '甲', B: '乙' })
  const link = addFreeLink(doc, 'A', 'B', { newId: idGen() })
  doc = removeFreeLink(link.doc, link.id)
  const r = renderLinkInjection(doc, [link.id])
  assert.equal(r.text, '')
  assert.equal(r.skipped, 1)
})

test('注入文案：端点节点已被删 → 跳过（不注入指向幽灵节点的联想）', () => {
  let doc = docWith({ A: '甲', B: '乙' })
  const link = addFreeLink(doc, 'A', 'B', { newId: idGen() })
  doc = link.doc
  delete doc.nodes.A
  const r = renderLinkInjection(doc, [link.id])
  assert.equal(r.text, '')
  assert.equal(r.skipped, 1)
})

test(`注入文案：最多 ${MAX_LINKS_PER_SEND} 条（规格 §10.4 硬上限）`, () => {
  const names = {}
  for (let i = 0; i < 30; i += 1) names['N' + i] = '节点' + i
  let doc = docWith(names)
  const ids = []
  const gen = idGen()
  for (let i = 0; i < 25; i += 1) {
    const r = addFreeLink(doc, 'N' + i, 'N' + (i + 1), { newId: gen })
    doc = r.doc
    ids.push(r.id)
  }
  const out = renderLinkInjection(doc, ids)
  assert.equal(out.used.length, MAX_LINKS_PER_SEND, '只注入上限条数')
  assert.equal(out.skipped, 5, '超出的计入 skipped')
  const lineCount = out.text.split('\n').length - 1 // 去掉前缀那行
  assert.equal(lineCount, MAX_LINKS_PER_SEND)
})

test('注入文案：显示名走注解三态 —— 缺失用派生、空串用占位、非空用注解', () => {
  const doc = docWith({ A: undefined, B: '', C: '我的注解' })
  assert.equal(displayNameOf(doc.nodes.A, { A: '派生的原文' }), '派生的原文')
  assert.equal(displayNameOf(doc.nodes.B, { B: '派生的原文' }), '（未命名）', '空串不回退派生')
  assert.equal(displayNameOf(doc.nodes.C, { C: '派生的原文' }), '我的注解')
  assert.equal(displayNameOf(doc.nodes.A, {}), '（未命名）', '既无注解又无派生 → 占位')
})

// ───────────────────────────── 焦点摘要 ─────────────────────────────

test('焦点摘要：带前缀、含焦点名与正文', () => {
  const doc = docWith({ A: '中心主题' }, { focusId: 'A' })
  doc.nodes.A.body = '这是正文'
  const r = renderSendInjection(doc, { newPinkLinksAtSend: [] })
  assert.ok(r.text.includes('[用户图数据]'))
  assert.ok(r.text.includes('当前焦点：《中心主题》'))
  assert.ok(r.text.includes('这是正文'))
  assert.equal(r.focusNodeId, 'A')
})

test('焦点摘要：正文超过 500 字要截断（规格 §10.4）', () => {
  const doc = docWith({ A: '中心' }, { focusId: 'A' })
  doc.nodes.A.body = 'x'.repeat(900)
  const r = renderSendInjection(doc, { newPinkLinksAtSend: [] })
  const bodyPart = r.text.split('\n').pop()
  assert.equal(bodyPart.length, 500, '正文部分应恰好截到 500 字')
})

test('焦点摘要：无焦点时返回空串（调用方据此不注入）', () => {
  const doc = docWith({ A: '甲' }, { focusId: null })
  const r = renderSendInjection(doc, { newPinkLinksAtSend: [] })
  assert.equal(r.text, '')
  assert.equal(r.focusNodeId, null)
})

test('完整注入：焦点摘要 + 粉线快照拼在一起', () => {
  let doc = docWith({ A: '中心', B: '联想一' }, { focusId: 'A' })
  const link = addFreeLink(doc, 'A', 'B', { newId: idGen() })
  doc = link.doc
  const r = renderSendInjection(doc, { newPinkLinksAtSend: [link.id] })
  assert.ok(r.text.includes('当前焦点：《中心》'))
  assert.ok(r.text.includes('建立自由联想'))
  assert.equal(r.linkCount, 1)
  assert.ok(r.text.split(USER_GRAPH_PREFIX).length - 1 >= 2, '前缀应出现两次（两段各自带）')
})

// ───────────────────────────── 官方重试复用同一快照（规格 §10.3） ─────────────────────────────

test('重试：同一次发送复用同一份快照，**不重新采样**', () => {
  const store = new Map()
  const first = rememberSnapshot(store, 'send-1', { newPinkLinksAtSend: ['L1'] })
  // 重试期间用户又拉了一条线 —— 若重新采样就会多出 L2
  const retry = rememberSnapshot(store, 'send-1', { newPinkLinksAtSend: ['L1', 'L2'] })
  assert.deepEqual(retry.newPinkLinksAtSend, ['L1'], '必须复用第一次的快照')
  assert.equal(retry, first, '连对象都是同一个')
})

test('重试：不同的 sendNonce 各拿各的快照', () => {
  const store = new Map()
  rememberSnapshot(store, 'send-1', { newPinkLinksAtSend: ['L1'] })
  const second = rememberSnapshot(store, 'send-2', { newPinkLinksAtSend: ['L2'] })
  assert.deepEqual(second.newPinkLinksAtSend, ['L2'])
  assert.equal(store.size, 2)
})

test('重试：消费后忘掉快照，避免 map 无限增长', () => {
  const store = new Map()
  rememberSnapshot(store, 'send-1', { newPinkLinksAtSend: ['L1'] })
  forgetSnapshot(store, 'send-1')
  assert.equal(store.size, 0)
})

// ───────────────────────────── 红线：拉线不触发模型 ─────────────────────────────

test('红线：拉粉线**不产生**任何要发给模型的东西', () => {
  let doc = docWith({ A: '甲', B: '乙' }, { focusId: null })
  const link = addFreeLink(doc, 'A', 'B', { newId: idGen() })
  doc = link.doc
  // 拉线之后立刻算「这一轮要注入什么」：没有快照 → 什么都不注入
  const r = renderSendInjection(doc, { newPinkLinksAtSend: [] })
  assert.equal(r.text, '', '拉线本身不得产生注入内容（红线 3：不自动 followup）')
})

// ───────────────────────────── 注入消息的构造与插入位置 ─────────────────────────────

test('注入消息：形状与宿主 createMessage 一致（克隆 + 补 id + 深冻结）', () => {
  const msg = makeGraphContextMessage('[用户图数据]\n测试内容', {
    sendNonce: 'n-1',
    focusNodeId: 'A',
    linkCount: 2,
  })
  assert.equal(msg.role, 'user')
  assert.deepEqual(msg.content, [{ type: 'text', text: '[用户图数据]\n测试内容' }])
  assert.equal(typeof msg.id, 'string')
  assert.ok(msg.id.length > 0, '必须有 id（宿主按 id 记账）')
  assert.equal(msg.source.kind, 'freethought-map')
  assert.equal(msg.source.form, 'graph-context')
  assert.equal(msg.source.sendNonce, 'n-1')
  assert.equal(msg.source.linkCount, 2)
  assert.ok(Object.isFrozen(msg), '必须冻结（宿主对已接纳消息做深冻结）')
  assert.ok(Object.isFrozen(msg.content), '深冻结要到底')
})

test('注入消息：uuid 可注入，便于测试确定化', () => {
  const msg = makeInjectedUserMessage({ role: 'user', content: [], source: {} }, { uuid: () => 'FIXED' })
  assert.equal(msg.id, 'FIXED')
})

test('注入插入位置：紧跟在**已接纳的用户消息**之后（照抄官方 toSpliced 语义）', () => {
  const u1 = { id: 'U1' }
  const u2 = { id: 'U2' }
  const ctxMsg = { id: 'CTX' }
  const injected = { id: 'INJ' }
  // 下游追加了上下文消息 ctxMsg；已接纳的是 u1/u2
  const out = spliceInjectionAfterClaimed([u1, u2, ctxMsg], [u1, u2], injected)
  assert.deepEqual(
    out.map((m) => m.id),
    ['U1', 'U2', 'INJ', 'CTX'],
    '插在最后一个已接纳消息之后、下游追加消息之前',
  )
})

test('注入插入位置：找不到已接纳消息时追加到末尾（不丢消息）', () => {
  const ctxMsg = { id: 'CTX' }
  const injected = { id: 'INJ' }
  const out = spliceInjectionAfterClaimed([ctxMsg], [], injected)
  assert.deepEqual(out.map((m) => m.id), ['CTX', 'INJ'])
})

test('注入插入位置：不改原数组', () => {
  const u1 = { id: 'U1' }
  const arr = [u1]
  const out = spliceInjectionAfterClaimed(arr, [u1], { id: 'INJ' })
  assert.deepEqual(arr.map((m) => m.id), ['U1'], '原数组必须原封不动')
  assert.equal(out.length, 2)
})

// ───────────── 派生标题索引的键（2026-09-27 真机抓到的 bug） ─────────────
//
// 这个 bug 的性质：事件日志按 `eventId` 建键，而所有显示名消费方按 `node.id` 查表
// → 永远查不中 → 所有无注解的投影节点显示成「（未命名）」
// → 注入给模型的焦点摘要变成「当前焦点：《（未命名）》」，等于没用。
//
// 这几条断言锁住「索引必须按 node.id」这件事。

test('派生标题索引：**按 node.id 建表**（不是按 eventId）—— 曾经的键错配 bug', () => {
  const doc = docWith({})
  doc.nodes = {
    'T-node-A': {
      id: 'T-node-A',
      kind: 'turn',
      parentId: null,
      position: { x: 0, y: 0 },
      sourceRef: { kind: 'user-message', eventId: 'uuid-aaa' },
    },
  }
  const entries = [{ eventId: 'uuid-aaa', title: '456', type: 'user/message' }]
  const idx = buildDerivedTitleIndex(doc, entries)
  assert.equal(idx['T-node-A'], '456', '必须能用 node.id 查到派生标题')
  assert.equal(idx['uuid-aaa'], undefined, '**不得**用 eventId 作键（那正是旧 bug）')
})

test('派生标题索引：经 displayNameOf 真的能显示出原文（端到端那一步）', () => {
  const doc = docWith({})
  doc.nodes = {
    'T-1': {
      id: 'T-1',
      kind: 'turn',
      parentId: null,
      position: { x: 0, y: 0 },
      sourceRef: { kind: 'user-message', eventId: 'uuid-1' },
    },
  }
  const idx = buildDerivedTitleIndex(doc, [{ eventId: 'uuid-1', title: '789' }])
  assert.equal(
    displayNameOf(doc.nodes['T-1'], idx),
    '789',
    '无注解的投影节点必须显示原文派生标题，而不是「（未命名）」',
  )
})

test('派生标题索引：有注解时仍以注解优先；空串仍不回退', () => {
  const doc = docWith({})
  doc.nodes = {
    A: { id: 'A', kind: 'turn', parentId: null, position: { x: 0, y: 0 }, title: '我的注解', sourceRef: { kind: 'user-message', eventId: 'e1' } },
    B: { id: 'B', kind: 'turn', parentId: null, position: { x: 0, y: 0 }, title: '', sourceRef: { kind: 'user-message', eventId: 'e2' } },
  }
  const idx = buildDerivedTitleIndex(doc, [
    { eventId: 'e1', title: '原文一' },
    { eventId: 'e2', title: '原文二' },
  ])
  assert.equal(displayNameOf(doc.nodes.A, idx), '我的注解')
  assert.equal(displayNameOf(doc.nodes.B, idx), '（未命名）', '空串不回退派生标题')
})

test('派生标题索引：手建节点（无 sourceRef）不进来，事件里没有的也不硬编', () => {
  const doc = docWith({})
  doc.nodes = {
    M: { id: 'M', kind: 'manual', parentId: null, position: { x: 0, y: 0 } },
    T: { id: 'T', kind: 'turn', parentId: null, position: { x: 0, y: 0 }, sourceRef: { kind: 'user-message', eventId: 'not-in-log' } },
  }
  const idx = buildDerivedTitleIndex(doc, [{ eventId: 'other', title: '别的' }])
  assert.deepEqual(idx, {}, '既没有 sourceRef 也对不上的节点都不该进表')
})

test('派生标题索引：入参缺失时不抛错，返回空表', () => {
  assert.deepEqual(buildDerivedTitleIndex(null, null), {})
  assert.deepEqual(buildDerivedTitleIndex({ nodes: {} }, undefined), {})
  assert.deepEqual(buildDerivedTitleIndex(undefined, [{ eventId: 'x', title: 'y' }]), {})
})

// ───────────────────────────── 报告 ─────────────────────────────
const fails = results.filter(([s]) => s === 'FAIL')
const pad = Math.max(...results.map(([, n]) => n.length))
console.log('')
for (const [status, name, msg] of results) {
  console.log(`  ${status}  ${name.padEnd(pad)}${msg ? '  ← ' + msg : ''}`)
}
console.log('')
console.log(`粉线与发送快照自测：${passed} 通过 / ${fails.length} 失败（共 ${results.length} 条）`)
process.exit(fails.length ? 1 : 0)
