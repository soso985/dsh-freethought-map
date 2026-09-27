/**
 * overlay 纯函数自测 —— 不需要宿主、不需要浏览器，纯 Node 可跑。
 *
 * 覆盖的是规格里最容易写错、且写错就直接违反红线的几处：
 *   注解三态 / 派生标题不写回 / 防环 / 上提 / 补链默认父 / sourceRef 唯一 / 校验器与规模上限。
 *
 * 用法：
 *   node scripts/verify-overlay.mjs
 */
import assert from 'node:assert/strict'
import {
  DERIVED_TITLE_LIMIT,
  canSetParent,
  deriveTitle,
  findByRef,
  isDescendant,
  isHidden,
  isWithinLimits,
  liftTarget,
  linkParentFromTimeline,
  refKey,
  resolveAnnotation,
  sameRef,
  validateOverlay,
} from '../src/overlay/index.js'

let passed = 0
const cases = []

function test(name, fn) {
  try {
    fn()
    passed += 1
    cases.push(['PASS', name, ''])
  } catch (e) {
    cases.push(['FAIL', name, e.message])
  }
}

/** 造一份最小合法 overlay */
function makeDoc(over = {}) {
  return {
    version: 1,
    sessionId: 's-1',
    rev: 3,
    nodes: {},
    freeLinks: [],
    focusId: null,
    hidden: [],
    updatedAt: 1758888000000,
    ...over,
  }
}

const U = (id, eventId) => ({
  id,
  kind: 'turn',
  sourceRef: { kind: 'user-message', eventId },
  parentId: null,
  position: { x: 0, y: 0 },
})
const A = (id, eventId) => ({
  id,
  kind: 'turn',
  sourceRef: { kind: 'assistant-settlement', eventId },
  parentId: null,
  position: { x: 0, y: 0 },
})
const M = (id, parentId = null) => ({
  id,
  kind: 'manual',
  parentId,
  position: { x: 0, y: 0 },
})

// ───────────────── 注解三态（规格 §10.1） ─────────────────
test('注解：undefined → 回退原文', () => {
  assert.equal(resolveAnnotation(undefined, '原文'), '原文')
})
test('注解：null → 回退原文', () => {
  assert.equal(resolveAnnotation(null, '原文'), '原文')
})
test('注解：空字符串 → 显示空，**不回退**原文', () => {
  assert.equal(resolveAnnotation('', '原文'), '')
})
test('注解：非空 → 显示注解', () => {
  assert.equal(resolveAnnotation('我的注解', '原文'), '我的注解')
})

// ───────────────── 派生标题（规格 §6.4：不写入 title） ─────────────────
test('派生标题：取首行并压缩空白', () => {
  assert.equal(deriveTitle('第一行\n第二行'), '第一行')
  assert.equal(deriveTitle('  多   空格  '), '多 空格')
})
test(`派生标题：超长截断到 ${DERIVED_TITLE_LIMIT} 字并加省略号`, () => {
  const long = '一'.repeat(40)
  const out = deriveTitle(long)
  assert.equal(out.length, DERIVED_TITLE_LIMIT + 1)
  assert.ok(out.endsWith('…'))
})
test('派生标题：恰好等于上限时不截断', () => {
  const exact = '二'.repeat(DERIVED_TITLE_LIMIT)
  assert.equal(deriveTitle(exact), exact)
})
test('派生标题：空输入得到空串（不抛错）', () => {
  assert.equal(deriveTitle(''), '')
  assert.equal(deriveTitle(undefined), '')
})

// ───────────────── sourceRef 唯一 / 去重 / hidden ─────────────────
test('refKey：kind + eventId', () => {
  assert.equal(refKey({ kind: 'user-message', eventId: '42' }), 'user-message:42')
})
test('sameRef：kind 不同即不等（禁止 eventId 与 turnId 混用）', () => {
  assert.ok(sameRef({ kind: 'user-message', eventId: '1' }, { kind: 'user-message', eventId: '1' }))
  assert.ok(!sameRef({ kind: 'user-message', eventId: '1' }, { kind: 'assistant-settlement', eventId: '1' }))
  assert.ok(!sameRef(undefined, { kind: 'user-message', eventId: '1' }))
})
test('findByRef：重放同一结算能找到既有节点（→ no-op）', () => {
  const doc = makeDoc({ nodes: { n1: U('n1', '7'), n2: A('n2', '7') } })
  assert.equal(findByRef(doc, { kind: 'user-message', eventId: '7' })?.id, 'n1')
  assert.equal(findByRef(doc, { kind: 'assistant-settlement', eventId: '7' })?.id, 'n2')
  assert.equal(findByRef(doc, { kind: 'user-message', eventId: '8' }), undefined)
})
test('isHidden：摘除按 sourceRef 记，不按 node.id', () => {
  const doc = makeDoc({ hidden: [{ kind: 'user-message', eventId: '9' }] })
  assert.ok(isHidden(doc, { kind: 'user-message', eventId: '9' }))
  assert.ok(!isHidden(doc, { kind: 'assistant-settlement', eventId: '9' }))
})

// ───────────────── 防环（规格 §6.6 复用线 A 算法） ─────────────────
test('isDescendant：沿 parentId 向上判定', () => {
  const doc = makeDoc({
    nodes: { a: M('a'), b: M('b', 'a'), c: M('c', 'b') },
  })
  assert.ok(isDescendant(doc, 'a', 'c'))
  assert.ok(isDescendant(doc, 'a', 'a'))
  assert.ok(!isDescendant(doc, 'c', 'a'))
})
test('isDescendant：数据被写成环也能终止', () => {
  const doc = makeDoc({ nodes: { a: M('a', 'b'), b: M('b', 'a') } })
  assert.ok(isDescendant(doc, 'a', 'b'))
  assert.ok(!isDescendant(doc, 'z', 'a'))
})
test('canSetParent：拒绝成环', () => {
  const doc = makeDoc({ nodes: { a: M('a'), b: M('b', 'a') } })
  assert.deepEqual(canSetParent(doc, 'a', 'b'), { ok: false, reason: 'cycle' })
})
test('canSetParent：拒绝自指', () => {
  const doc = makeDoc({ nodes: { a: M('a') } })
  assert.deepEqual(canSetParent(doc, 'a', 'a'), { ok: false, reason: 'self' })
})
test('canSetParent：parentId=null = 断开成独立节点（合法）', () => {
  const doc = makeDoc({ nodes: { a: M('a'), b: M('b', 'a') } })
  assert.deepEqual(canSetParent(doc, 'b', null), { ok: true })
})
test('canSetParent：拒绝指向不存在的父', () => {
  const doc = makeDoc({ nodes: { a: M('a') } })
  assert.deepEqual(canSetParent(doc, 'a', 'nope'), { ok: false, reason: 'missing-parent' })
})

// ───────────────── 摘除上提（规格 §6.6 唯一规则） ─────────────────
test('liftTarget：子节点上提到被删节点的父', () => {
  const doc = makeDoc({ nodes: { root: M('root'), x: M('x', 'root'), kid: M('kid', 'x') } })
  assert.equal(liftTarget(doc, new Set(['x']), 'x'), 'root')
})
test('liftTarget：连续删除时一路向上找幸存祖先', () => {
  const doc = makeDoc({
    nodes: { root: M('root'), x: M('x', 'root'), y: M('y', 'x'), kid: M('kid', 'y') },
  })
  assert.equal(liftTarget(doc, new Set(['x', 'y']), 'y'), 'root')
})
test('liftTarget：祖先全被删 → null（变顶层）', () => {
  const doc = makeDoc({ nodes: { x: M('x'), kid: M('kid', 'x') } })
  assert.equal(liftTarget(doc, new Set(['x']), 'x'), null)
})

// ───────────────── 补链默认父（规格 §6.5：禁用 live focusId） ─────────────────
test('linkParentFromTimeline：用时间线上前一个未隐藏 turn', () => {
  const doc = makeDoc({ nodes: { t1: U('t1', '1') } })
  assert.equal(linkParentFromTimeline(doc, 't1'), 't1')
})
test('linkParentFromTimeline：没有前驱 → null（新顶层链）', () => {
  const doc = makeDoc({ nodes: {} })
  assert.equal(linkParentFromTimeline(doc, null), null)
  assert.equal(linkParentFromTimeline(doc, undefined), null)
})
test('linkParentFromTimeline：前驱已不存在 → null，不猜', () => {
  const doc = makeDoc({ nodes: {} })
  assert.equal(linkParentFromTimeline(doc, 'ghost'), null)
})

// ───────────────── 校验器 ─────────────────
test('validateOverlay：最小合法文档通过', () => {
  const doc = makeDoc({ nodes: { n1: U('n1', '1') }, focusId: 'n1' })
  const r = validateOverlay(doc)
  assert.deepEqual(r, { ok: true, errors: [] })
})
test('validateOverlay：turn 缺 sourceRef 报错', () => {
  const doc = makeDoc({ nodes: { n1: { ...U('n1', '1'), sourceRef: undefined } } })
  const r = validateOverlay(doc)
  assert.ok(!r.ok)
  assert.ok(r.errors.some((e) => e.includes('没有 sourceRef')))
})
test('validateOverlay：manual 带 sourceRef 报错（规格禁止）', () => {
  const doc = makeDoc({ nodes: { m1: { ...M('m1'), sourceRef: { kind: 'user-message', eventId: '1' } } } })
  const r = validateOverlay(doc)
  assert.ok(!r.ok)
  assert.ok(r.errors.some((e) => e.includes('manual 但带 sourceRef')))
})
test('validateOverlay：sourceRef 重复报错', () => {
  const doc = makeDoc({ nodes: { n1: U('n1', '5'), n2: U('n2', '5') } })
  const r = validateOverlay(doc)
  assert.ok(!r.ok)
  assert.ok(r.errors.some((e) => e.includes('sourceRef 重复')))
})
test('validateOverlay：parentId 成环报错', () => {
  const doc = makeDoc({ nodes: { a: M('a', 'b'), b: M('b', 'a') } })
  const r = validateOverlay(doc)
  assert.ok(!r.ok)
  assert.ok(r.errors.some((e) => e.includes('成环')))
})
test('validateOverlay：粉线端点缺失 / 自连 / 重复 都要报错', () => {
  const doc = makeDoc({
    nodes: { a: M('a'), b: M('b') },
    freeLinks: [
      { id: 'l1', a: 'a', b: 'ghost' },
      { id: 'l2', a: 'b', b: 'b' },
      { id: 'l3', a: 'a', b: 'b' },
      { id: 'l4', a: 'b', b: 'a' },
    ],
  })
  const r = validateOverlay(doc)
  assert.ok(!r.ok)
  assert.ok(r.errors.some((e) => e.includes('端点 b=ghost')))
  assert.ok(r.errors.some((e) => e.includes('自连')))
  assert.ok(r.errors.some((e) => e.includes('freeLink 重复')))
})
test('validateOverlay：focusId 指向幽灵节点报错', () => {
  const doc = makeDoc({ nodes: { a: M('a') }, focusId: 'ghost' })
  const r = validateOverlay(doc)
  assert.ok(!r.ok)
  assert.ok(r.errors.some((e) => e.includes('focusId 指向不存在')))
})
test('validateOverlay：version 不是 1 直接拒绝', () => {
  const r = validateOverlay(makeDoc({ version: 2 }))
  assert.ok(!r.ok)
  assert.ok(r.errors.some((e) => e.includes('version')))
})
test('isWithinLimits：节点数超上限被拒', () => {
  const nodes = {}
  for (let i = 0; i < 11; i += 1) nodes['n' + i] = M('n' + i)
  const doc = makeDoc({ nodes })
  assert.equal(isWithinLimits(doc, 10).ok, false)
  assert.equal(isWithinLimits(doc, 20).ok, true)
})

// ───────────────── 报告 ─────────────────
const failed = cases.filter(([s]) => s === 'FAIL')
const pad = Math.max(...cases.map(([, n]) => n.length))
for (const [status, name, msg] of cases) {
  console.log(`  ${status}  ${name.padEnd(pad)}${msg ? '  ← ' + msg : ''}`)
}
console.log('')
console.log(`overlay 自测：${passed} 通过 / ${failed.length} 失败（共 ${cases.length} 条）`)
process.exit(failed.length ? 1 : 0)
