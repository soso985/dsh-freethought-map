/**
 * 卡 7 用户结构操作与撤销栈自测 —— 覆盖规格 §6.6 / §7 / §10.1 与实施计划卡 7 的验收条。
 *
 * 用法：
 *   node scripts/verify-undo.mjs
 */
import assert from 'node:assert/strict'
import {
  History,
  HistoryBySession,
  HISTORY_DEPTH,
  applyInverse,
  invertOp,
  opAnnotate,
  opCreateManual,
  opDelete,
  opGeometry,
  opSetParent,
  setCanSetParent,
} from '../src/overlay/undo.js'
import { canSetParent, createOverlay, resolveAnnotation, validateOverlay } from '../src/overlay/index.js'

// 接线：undo.js 用注入的方式拿 overlay 的防环实现（客户端 bundle 不能 import 相对模块）
setCanSetParent(canSetParent)

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

let seq = 0
const newId = () => 'M' + String(++seq)

/** 造一个带链的 doc：R(手建) ← A(turn) ← B(手建) */
function fixture() {
  seq = 0
  const doc = createOverlay('session-1')
  doc.nodes = {
    R: { id: 'R', kind: 'manual', parentId: null, position: { x: 0, y: 0 }, title: '根' },
    A: {
      id: 'A',
      kind: 'turn',
      parentId: 'R',
      position: { x: 0, y: 100 },
      sourceRef: { kind: 'user-message', eventId: 'u1' },
      seq: 1,
    },
    B: { id: 'B', kind: 'manual', parentId: 'A', position: { x: 0, y: 200 } },
    C: { id: 'C', kind: 'manual', parentId: null, position: { x: 200, y: 0 } },
  }
  doc.focusId = 'B'
  doc.freeLinks = [{ id: 'L1', a: 'A', b: 'C' }]
  return doc
}

// ───────────────────────────── 手建 ─────────────────────────────

// 阶段 1 第 2 项（每行「＋ 新建子节点」）落地时新增的两条：
// `opCreateManual` 的实现从 `undo.js` 迁到了 `overlay/manual.js`（客户端要逐字复制它，
// 而它原先连着 `canSetParentLoose` 与注入接线，抄一份要抄三样）。迁完要保证：
//   1. 在**深层**父上建节点，结果仍然是一份**合法**的 overlay（父链不断、能过校验）；
//   2. 新节点 id 在已有节点里**不重复**（覆盖会让一个已有节点凭空消失）。

test('手建：在深层父上建节点 → 结果仍是合法 overlay（validateOverlay 通过）', () => {
  const doc = fixture()
  let cur = doc
  let parentId = 'B' // 已经是第 3 层
  for (let i = 0; i < 5; i += 1) {
    const r = opCreateManual(cur, { parentId, position: { x: i * 10, y: i * 10 } }, { newId })
    assert.equal(r.ok, true, '第 ' + (i + 1) + ' 层应当建成功')
    cur = r.doc
    parentId = r.id
  }
  const v = validateOverlay(cur)
  assert.equal(v.ok, true, '深层建完必须仍合法：' + JSON.stringify(v.errors).slice(0, 200))
  // 父链从最深一路走回顶层，不该断
  let cursor = parentId
  let hops = 0
  while (cursor) {
    assert.ok(cur.nodes[cursor], '父链上的节点必须存在：' + cursor)
    cursor = cur.nodes[cursor].parentId
    hops += 1
    assert.ok(hops < 50, '父链不该成环')
  }
  assert.equal(hops, 8, 'B → 新建 5 层 → 再回到 R/A 共 8 跳')
})

test('手建：默认 id 生成器在**同一毫秒**连建多个也不撞已有节点', () => {
  const doc = fixture()
  let cur = doc
  const ids = new Set(Object.keys(doc.nodes))
  // 不注入 newId ⇒ 用生产的那份默认生成器（时间戳 + 随机段）
  for (let i = 0; i < 40; i += 1) {
    const r = opCreateManual(cur, { parentId: 'R' })
    assert.equal(r.ok, true)
    assert.equal(ids.has(r.id), false, '新 id 撞了已有节点：' + r.id)
    assert.equal(/^M/.test(r.id), true, '手建节点 id 应当以 M 开头：' + r.id)
    ids.add(r.id)
    cur = r.doc
  }
  // 建了 40 个 + 原有 4 个 ⇒ 节点数必须是 44（撞了就会少）
  assert.equal(Object.keys(cur.nodes).length, 44, 'id 碰撞会让节点数变少')
})

test('手建：新建 manual 节点，带 op 描述', () => {
  const doc = fixture()
  const r = opCreateManual(doc, { parentId: 'R', position: { x: 10, y: 20 } }, { newId })
  assert.equal(r.ok, true)
  assert.equal(r.doc.nodes[r.id].kind, 'manual')
  assert.equal(r.doc.nodes[r.id].parentId, 'R')
  assert.deepEqual(r.op, { type: 'create', id: r.id })
  assert.equal(doc.nodes[r.id], undefined, '不得改原 doc')
})

test('手建：父不存在时拒绝', () => {
  const r = opCreateManual(fixture(), { parentId: 'GHOST' }, { newId })
  assert.equal(r.ok, false)
  assert.equal(r.reason, 'missing-parent')
})

test('手建：parentId 为 null 时建成顶层', () => {
  const r = opCreateManual(fixture(), { parentId: null }, { newId })
  assert.equal(r.ok, true)
  assert.equal(r.doc.nodes[r.id].parentId, null)
})

// ───────────────────────────── 改父（防环） ─────────────────────────────

test('改父：合法改父成功', () => {
  const r = opSetParent(fixture(), 'C', 'R')
  assert.equal(r.ok, true)
  assert.equal(r.doc.nodes.C.parentId, 'R')
})

test('改父成环：拒绝，且**不改动 doc**', () => {
  const doc = fixture()
  const before = JSON.stringify(doc)
  // R ← A ← B，把 R 的父改成 B 就成环
  const r = opSetParent(doc, 'R', 'B')
  assert.equal(r.ok, false)
  assert.equal(r.reason, 'cycle')
  assert.equal(JSON.stringify(doc), before, '拒绝时必须原封不动')
})

test('改父自指：拒绝', () => {
  const r = opSetParent(fixture(), 'R', 'R')
  assert.equal(r.ok, false)
  assert.equal(r.reason, 'self')
})

test('改父到不存在的节点：拒绝', () => {
  const r = opSetParent(fixture(), 'C', 'GHOST')
  assert.equal(r.ok, false)
  assert.equal(r.reason, 'missing-parent')
})

test('改父为 null：变成顶层', () => {
  const r = opSetParent(fixture(), 'B', null)
  assert.equal(r.ok, true)
  assert.equal(r.doc.nodes.B.parentId, null)
})

test('改父成"没变化"：拒绝（不产生无意义的撤销步）', () => {
  const r = opSetParent(fixture(), 'B', 'A')
  assert.equal(r.ok, false)
  assert.equal(r.reason, 'no-change')
})

// ───────────────────────────── 摘除（规格 §6.6 唯一规则） ─────────────────────────────

test('摘除：子节点上提一级、相连粉线删除、hidden 记 sourceRef', () => {
  const doc = fixture()
  const r = opDelete(doc, 'A')
  assert.equal(r.ok, true)
  assert.equal(r.doc.nodes.A, undefined, '节点记录应删除')
  assert.equal(r.doc.nodes.B.parentId, 'R', 'B 上提到 A 的父')
  assert.equal(r.doc.freeLinks.length, 0, '与 A 相连的粉线删除')
  assert.deepEqual(r.doc.hidden, [{ kind: 'user-message', eventId: 'u1' }], 'turn 要写 hidden')
  assert.deepEqual(r.op.liftedChildren, [{ id: 'B', parentId: 'A' }], '撤销日志要记原父')
  assert.deepEqual(r.op.removedLinks, [{ id: 'L1', a: 'A', b: 'C' }], '撤销日志要记被删的线')
})

test('摘除：焦点只在「被删的就是焦点」时才回退到父（规格 §6.6）', () => {
  const doc = fixture() // focusId = 'B'
  const r = opDelete(doc, 'A') // A 不是焦点
  assert.equal(r.doc.focusId, 'B', '删的不是焦点节点，焦点不该被动')

  const doc2 = fixture()
  doc2.focusId = 'A' // 这次焦点就是被删的那个
  const r2 = opDelete(doc2, 'A')
  assert.equal(r2.doc.focusId, 'R', '被删的是焦点 → 焦点回退到 X.parentId')
})

test('摘除：手建节点**不写 hidden**（它没有 sourceRef）', () => {
  const r = opDelete(fixture(), 'B')
  assert.equal(r.ok, true)
  assert.equal(r.op.hiddenRef, null)
  assert.deepEqual(r.doc.hidden, [])
})

test('摘除顶层节点：子节点变成顶层', () => {
  const r = opDelete(fixture(), 'R')
  assert.equal(r.ok, true)
  assert.equal(r.doc.nodes.A.parentId, null)
})

test('摘除不存在的节点：拒绝', () => {
  const r = opDelete(fixture(), 'GHOST')
  assert.equal(r.ok, false)
  assert.equal(r.reason, 'missing')
})

test('摘除后 validateOverlay 仍然通过', () => {
  const r = opDelete(fixture(), 'A')
  assert.deepEqual(validateOverlay(r.doc), { ok: true, errors: [] })
})

// ───────────────────────────── 注解（三态） ─────────────────────────────

test('注解：写入 / 清空为空串 / 删除字段，三种语义各不相同', () => {
  const doc = fixture()
  const set = opAnnotate(doc, 'B', '我的注解')
  assert.equal(set.doc.nodes.B.title, '我的注解')

  const cleared = opAnnotate(set.doc, 'B', '')
  assert.equal(cleared.doc.nodes.B.title, '', '清空是空串，**不是**删字段')
  assert.ok(Object.prototype.hasOwnProperty.call(cleared.doc.nodes.B, 'title'))

  const removed = opAnnotate(cleared.doc, 'B', null)
  assert.ok(
    !Object.prototype.hasOwnProperty.call(removed.doc.nodes.B, 'title'),
    '传 null 才是删字段',
  )
})

test('注解三态经 resolveAnnotation 落到正确显示', () => {
  const doc = fixture()
  const withAnnotation = opAnnotate(doc, 'B', '我的注解').doc
  assert.equal(resolveAnnotation(withAnnotation.nodes.B.title, '派生的原文'), '我的注解')

  const cleared = opAnnotate(withAnnotation, 'B', '').doc
  assert.equal(resolveAnnotation(cleared.nodes.B.title, '派生的原文'), '', '空串不回退派生标题')

  const removed = opAnnotate(cleared, 'B', null).doc
  assert.equal(resolveAnnotation(removed.nodes.B.title, '派生的原文'), '派生的原文', '缺字段才用派生')
})

// ───────────────────────────── 撤销：只逆转用户操作 ─────────────────────────────

test('撤销手建：节点消失', () => {
  const h = new History()
  const doc = fixture()
  const created = opCreateManual(doc, { parentId: 'R' }, { newId })
  h.push(invertOp({ doc: created.doc, op: created.op }))
  const r = h.undo(created.doc)
  assert.equal(r.applied, true)
  assert.equal(r.doc.nodes[created.id], undefined)
})

test('撤销改父：恢复原来的父', () => {
  const h = new History()
  const doc = fixture()
  const moved = opSetParent(doc, 'B', 'C')
  h.push(invertOp({ doc: moved.doc, op: moved.op }))
  const r = h.undo(moved.doc)
  assert.equal(r.applied, true)
  assert.equal(r.doc.nodes.B.parentId, 'A')
})

test('撤销注解：空串与缺字段要区分开（这是最容易错的一条）', () => {
  const h = new History()
  const doc = fixture()
  // 先把它清空（字段存在且为 ""）
  const cleared = opAnnotate(doc, 'B', '')
  h.push(invertOp({ doc: cleared.doc, op: cleared.op }))
  const r = h.undo(cleared.doc)
  assert.ok(
    !Object.prototype.hasOwnProperty.call(r.doc.nodes.B, 'title'),
    '撤销清空后应回到「没有 title 字段」，而不是 title=""',
  )
})

test('撤销摘除：**对话还在**、节点与子父关系、粉线、hidden 全部恢复', () => {
  const h = new History()
  const doc = fixture()
  const del = opDelete(doc, 'A')
  h.push(invertOp({ doc: del.doc, op: del.op }))

  const r = h.undo(del.doc)
  assert.equal(r.applied, true)
  assert.equal(r.doc.nodes.A, undefined === null ? undefined : r.doc.nodes.A, '')
  assert.ok(r.doc.nodes.A, '节点要回来')
  assert.equal(r.doc.nodes.A.sourceRef.eventId, 'u1', 'sourceRef 要原样回来')
  assert.equal(r.doc.nodes.B.parentId, 'A', '子节点要放回原位')
  assert.deepEqual(r.doc.freeLinks, [{ id: 'L1', a: 'A', b: 'C' }], '粉线要恢复')
  assert.deepEqual(r.doc.hidden, [], 'hidden 要清掉')
  assert.equal(r.doc.focusId, 'B', '焦点要恢复')
})

test('撤销摘除后，补链**不会**把它再建一次（hidden 已清 + 节点已回）', () => {
  const h = new History()
  const doc = fixture()
  const del = opDelete(doc, 'A')
  h.push(invertOp({ doc: del.doc, op: del.op }))
  const r = h.undo(del.doc)
  // 现在 A 存在且 hidden 为空 —— 这两条同时成立才不会出现"又建一个"
  assert.ok(r.doc.nodes.A)
  assert.equal(r.doc.hidden.length, 0)
  assert.equal(
    Object.values(r.doc.nodes).filter((n) => n.sourceRef && n.sourceRef.eventId === 'u1').length,
    1,
    '同一个 sourceRef 在图里只能有一个节点',
  )
})

// ───────────────────────────── 撤销：绝不碰投影（规格 §7） ─────────────────────────────

test('**关键**：拖动期间到达的 AI 投影，撤销拖动**不得删掉它**（只恢复位置）', () => {
  const h = new History()
  const doc = fixture()
  // 1) 用户开始拖动 B
  const before = { x: 0, y: 200 }
  const dragged = opGeometry(doc, 'B', { position: { x: 500, y: 500 } })
  h.push(invertOp({ doc: dragged.doc, op: dragged.op }))

  // 2) 拖动期间，一个 AI 投影落地（**不进用户历史**，规格 §7）
  const withProjection = {
    ...dragged.doc,
    nodes: {
      ...dragged.doc.nodes,
      T9: {
        id: 'T9',
        kind: 'turn',
        parentId: 'B',
        position: { x: 500, y: 640 },
        sourceRef: { kind: 'assistant-settlement', eventId: 'a9' },
        seq: 9,
      },
    },
  }

  // 3) 撤销拖动
  const r = h.undo(withProjection)
  assert.equal(r.applied, true)
  assert.deepEqual(r.doc.nodes.B.position, before, '位置要恢复')
  assert.ok(r.doc.nodes.T9, '**AI 投影必须还在** —— 撤销拖动不得删掉它')
  assert.equal(r.doc.nodes.T9.parentId, 'B', '它的父也不该被动')
})

test('**关键**：投影节点不能靠撤销删掉（去掉它只能用摘除）', () => {
  const h = new History()
  const doc = fixture()
  // 硬把一条 remove(A) 的逆操作塞进栈（模拟"如果撤销能删投影"的情形）
  h.push({ type: 'remove', id: 'A', links: [], focusId: null })
  const r = h.undo(doc)
  assert.equal(r.applied, false)
  assert.equal(r.reason, 'turn-node')
  assert.ok(r.doc.nodes.A, '投影节点必须还在')
})

test('**关键**：undo 绝不新建节点（不变量）—— 逆操作只有 remove/restore/set-field', () => {
  const doc = fixture()
  // 逐一带上所有操作种类，检查产出的逆操作种类都在白名单里
  const cases = [
    opCreateManual(doc, { parentId: 'R' }, { newId }),
    opSetParent(doc, 'B', 'C'),
    opDelete(doc, 'A'),
    opAnnotate(doc, 'B', 'x'),
    opGeometry(doc, 'B', { position: { x: 1, y: 1 } }),
  ]
  const allowed = new Set(['remove', 'unremove', 'set-field', 'link-remove', 'link-restore'])
  for (const c of cases) {
    assert.equal(c.ok, true)
    const inv = invertOp({ doc: c.doc, op: c.op })
    assert.ok(inv, '应产出逆操作')
    assert.ok(allowed.has(inv.type), '逆操作种类越界：' + inv.type)
  }
})

test('目标节点已被投影清理掉时，撤销跳过而不是半途改坏', () => {
  const h = new History()
  const doc = fixture()
  const created = opCreateManual(doc, { parentId: 'R' }, { newId })
  h.push(invertOp({ doc: created.doc, op: created.op }))
  // 节点被别处删掉了
  const nodes = { ...created.doc.nodes }
  delete nodes[created.id]
  const r = h.undo({ ...created.doc, nodes })
  assert.equal(r.applied, false)
  assert.equal(r.reason, 'node-gone')
})

// ───────────────────────────── 重做 ─────────────────────────────

test('重做：撤销后能重做回来', () => {
  const h = new History()
  const doc = fixture()
  const created = opCreateManual(doc, { parentId: 'R' }, { newId })
  h.push(invertOp({ doc: created.doc, op: created.op }))
  const undone = h.undo(created.doc)
  assert.equal(undone.doc.nodes[created.id], undefined)
  const redone = h.redo(undone.doc)
  assert.equal(redone.applied, true)
  assert.ok(redone.doc.nodes[created.id], '重做要把节点找回来')
})

test('重做摘除：再删一次，且 hidden 重新写上', () => {
  const h = new History()
  const doc = fixture()
  const del = opDelete(doc, 'A')
  h.push(invertOp({ doc: del.doc, op: del.op }))
  const undone = h.undo(del.doc)
  assert.ok(undone.doc.nodes.A)
  const redone = h.redo(undone.doc)
  assert.equal(redone.applied, true)
  assert.equal(redone.doc.nodes.A, undefined, '重做摘除应再删掉')
  assert.equal(redone.doc.nodes.B.parentId, 'R', '子节点再次上提')
})

test('新操作会清空 redo 栈（常规撤销语义）', () => {
  const h = new History()
  const doc = fixture()
  h.push(invertOp({ doc, op: { type: 'create', id: 'B' } }))
  h.undo(doc)
  assert.equal(h.canRedo, true)
  h.push(invertOp({ doc, op: { type: 'create', id: 'C' } }))
  assert.equal(h.canRedo, false)
})

// ───────────────────────────── 栈深与会话隔离 ─────────────────────────────

test(`栈深上限 ${HISTORY_DEPTH} 步，超出丢最旧的`, () => {
  const h = new History(3)
  for (let i = 0; i < 6; i += 1) h.push({ type: 'remove', id: 'X' + i, links: [], focusId: null })
  assert.equal(h.size, 3)
  assert.equal(h.undoStack[0].id, 'X3', '最旧的被丢掉')
})

test('历史**按 sessionId 隔离**：切会话换栈，互不影响', () => {
  const bySession = new HistoryBySession()
  const doc = fixture()
  bySession.record('s1', doc, { type: 'create', id: 'B' })
  bySession.record('s1', doc, { type: 'create', id: 'C' })
  bySession.record('s2', doc, { type: 'create', id: 'R' })
  assert.equal(bySession.for('s1').size, 2)
  assert.equal(bySession.for('s2').size, 1)
  assert.equal(bySession.for('s3').size, 0, '没记录的会话是空栈')
})

test('会话隔离：在 s1 撤销不会动到 s2 的栈', () => {
  const bySession = new HistoryBySession()
  const doc = fixture()
  bySession.record('s1', doc, { type: 'create', id: 'B' })
  bySession.record('s2', doc, { type: 'create', id: 'C' })
  const r1 = bySession.undo('s1', doc)
  assert.equal(r1.applied, true)
  assert.equal(r1.doc.nodes.B, undefined)
  assert.equal(bySession.for('s2').size, 1, 's2 的栈不受影响')
})

test('空栈撤销/重做：明确返回 empty，不抛错', () => {
  const h = new History()
  const doc = fixture()
  assert.equal(h.undo(doc).reason, 'empty')
  assert.equal(h.redo(doc).reason, 'empty')
})

// ───────────────────────────── 粉线的撤销 ─────────────────────────────

test('撤销「拉粉线」：线消失；撤销「删粉线」：线回来', () => {
  const doc = fixture()
  const h = new History()
  const added = { id: 'L2', a: 'B', b: 'C' }
  const withLink = { ...doc, freeLinks: [...doc.freeLinks, added] }
  h.push(invertOp({ doc: withLink, op: { type: 'link-add', id: 'L2', link: added } }))
  const undone = h.undo(withLink)
  assert.equal(undone.applied, true)
  assert.equal(undone.doc.freeLinks.length, 1, '新加的线被撤销掉')
  const redone = h.redo(undone.doc)
  assert.equal(redone.doc.freeLinks.length, 2, '重做把它加回来')
})

// ───────────────────── 撤销↔重做的**往返对称**（本轮出错最多的地方） ─────────────────────

test('往返：改父可以来回走三次，每次都对', () => {
  const h = new History()
  const doc = fixture()
  const moved = opSetParent(doc, 'B', 'C')
  h.push(invertOp({ doc: moved.doc, op: moved.op }))

  let cur = moved.doc
  for (let i = 0; i < 3; i += 1) {
    const u = h.undo(cur)
    assert.equal(u.applied, true, '第 ' + (i + 1) + ' 次撤销应成功')
    assert.equal(u.doc.nodes.B.parentId, 'A', '第 ' + (i + 1) + ' 次撤销后父应是 A')
    cur = u.doc
    const r = h.redo(cur)
    assert.equal(r.applied, true, '第 ' + (i + 1) + ' 次重做应成功')
    assert.equal(r.doc.nodes.B.parentId, 'C', '第 ' + (i + 1) + ' 次重做后父应是 C')
    cur = r.doc
  }
})

test('往返：拖动位置能来回走（撤销回到旧位、重做回到新位）', () => {
  const h = new History()
  const doc = fixture()
  const dragged = opGeometry(doc, 'B', { position: { x: 777, y: 888 } })
  h.push(invertOp({ doc: dragged.doc, op: dragged.op }))

  const u = h.undo(dragged.doc)
  assert.equal(u.applied, true)
  assert.deepEqual(u.doc.nodes.B.position, { x: 0, y: 200 }, '撤销回到拖动前')
  const r = h.redo(u.doc)
  assert.equal(r.applied, true)
  assert.deepEqual(r.doc.nodes.B.position, { x: 777, y: 888 }, '重做回到拖动后')
})

test('往返：注解三态在撤销↔重做里都不串味', () => {
  // 情形一：原来是「没有字段」，写成注解
  const h1 = new History()
  const doc = fixture()
  const wrote = opAnnotate(doc, 'B', '新注解')
  h1.push(invertOp({ doc: wrote.doc, op: wrote.op }))
  const u1 = h1.undo(wrote.doc)
  assert.ok(
    !Object.prototype.hasOwnProperty.call(u1.doc.nodes.B, 'title'),
    '撤销写注解 → 回到「没有字段」',
  )
  const r1 = h1.redo(u1.doc)
  assert.equal(r1.doc.nodes.B.title, '新注解', '重做写注解 → 回到「新注解」')

  // 情形二：原来是空串（用户清空过），再写注解
  const h2 = new History()
  const cleared = opAnnotate(doc, 'B', '').doc
  const wrote2 = opAnnotate(cleared, 'B', '后来写的')
  h2.push(invertOp({ doc: wrote2.doc, op: wrote2.op }))
  const u2 = h2.undo(wrote2.doc)
  assert.equal(u2.doc.nodes.B.title, '', '撤销后回到空串，**不是**删掉字段')
  assert.ok(
    Object.prototype.hasOwnProperty.call(u2.doc.nodes.B, 'title'),
    '空串必须仍然是个存在的字段',
  )
  const r2 = h2.redo(u2.doc)
  assert.equal(r2.doc.nodes.B.title, '后来写的', '重做回到「后来写的」')
})

test('往返：手建节点撤销后再重做，字段原样回来', () => {
  const h = new History()
  const doc = fixture()
  const created = opCreateManual(
    doc,
    { parentId: 'R', position: { x: 11, y: 22 }, title: '手建标题' },
    { newId },
  )
  h.push(invertOp({ doc: created.doc, op: created.op }))

  const u = h.undo(created.doc)
  assert.equal(u.doc.nodes[created.id], undefined, '撤销后节点不在')
  const r = h.redo(u.doc)
  assert.equal(r.applied, true, '重做应成功')
  assert.ok(r.doc.nodes[created.id], '节点要回来')
  assert.deepEqual(r.doc.nodes[created.id].position, { x: 11, y: 22 }, '位置原样')
  assert.equal(r.doc.nodes[created.id].title, '手建标题', '注解原样')
  assert.equal(r.doc.nodes[created.id].parentId, 'R', '父原样')
})

test('往返：摘除撤销再重做，子节点与 hidden 都对', () => {
  const h = new History()
  const doc = fixture()
  const del = opDelete(doc, 'A')
  h.push(invertOp({ doc: del.doc, op: del.op }))

  const u = h.undo(del.doc)
  assert.equal(u.doc.nodes.B.parentId, 'A')
  assert.deepEqual(u.doc.hidden, [])
  const r = h.redo(u.doc)
  assert.equal(r.applied, true)
  assert.equal(r.doc.nodes.A, undefined, '重做摘除 → 节点再次消失')
  assert.equal(r.doc.nodes.B.parentId, 'R', '子节点再次上提')
  assert.deepEqual(r.doc.hidden, [{ kind: 'user-message', eventId: 'u1' }], 'hidden 重新写上')
})

test('往返期间叠进新投影：撤销/重做都不碰它', () => {
  const h = new History()
  const doc = fixture()
  const dragged = opGeometry(doc, 'B', { position: { x: 300, y: 300 } })
  h.push(invertOp({ doc: dragged.doc, op: dragged.op }))

  const projection = {
    id: 'T7',
    kind: 'turn',
    parentId: 'B',
    position: { x: 300, y: 440 },
    sourceRef: { kind: 'assistant-settlement', eventId: 'a7' },
    seq: 7,
  }
  const withProj = { ...dragged.doc, nodes: { ...dragged.doc.nodes, T7: projection } }

  const u = h.undo(withProj)
  assert.ok(u.doc.nodes.T7, '撤销不能删投影')
  const r = h.redo(u.doc)
  assert.ok(r.doc.nodes.T7, '重做也不能删投影')
  assert.deepEqual(r.doc.nodes.B.position, { x: 300, y: 300 })
})

// ───────────────────────────── 报告 ─────────────────────────────
const fails = results.filter(([s]) => s === 'FAIL')
const pad = Math.max(...results.map(([, n]) => n.length))
console.log('')
for (const [status, name, msg] of results) {
  console.log(`  ${status}  ${name.padEnd(pad)}${msg ? '  ← ' + msg : ''}`)
}
console.log('')
console.log(`用户操作与撤销自测：${passed} 通过 / ${fails.length} 失败（共 ${results.length} 条）`)
process.exit(fails.length ? 1 : 0)
