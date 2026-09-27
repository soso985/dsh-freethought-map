/**
 * 卡 4 双向定位自测 —— 纯函数 + 一个**假的 DOM**（够 `querySelectorAll` 用就够）。
 *
 * 卡 4 的落地形态是「图 → 气泡」单向 + 焦点/选中分离（卡 1 已判定气泡→图不可行）。
 * 这里把每条规则钉死，包括**脆弱点的降级行为**：找不到 / 命中多个 都必须如实报告，
 * 绝不静默选一个错的。
 *
 * 用法：
 *   node scripts/verify-locate.mjs
 */
import assert from 'node:assert/strict'
import {
  applySelection,
  bubbleSelectorCandidates,
  buildChainView,
  locateBubble,
  planReveal,
  scrollToBubble,
} from '../src/overlay/locate.js'
import { createOverlay } from '../src/overlay/index.js'

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

// ───────────────────────────── 假 DOM ─────────────────────────────
/**
 * 极简 DOM 替身：只实现 locateBubble 真正用到的那点能力
 * （`querySelectorAll(attributeSelector)`）。
 * 支持 `[attr="v"]`、`[attr$="v"]` 两种形态 —— 正好是我们会生成的两种。
 */
function makeFakeDom(nodes) {
  const all = nodes.map((n) => {
    const attrs = { ...(n.attrs || {}) }
    return {
      attrs,
      _n: n,
      style: {},
      scrollIntoView(opts) {
        this.scrolled = opts
      },
    }
  })
  function matches(el, selector) {
    const m = selector.match(/^\[([a-z-]+)(?:([$]?=)"((?:[^"\\]|\\.)*)")?\]$/)
    if (!m) throw new Error('fake DOM 不支持的选择器：' + selector)
    const [, attr, op, rawValue] = m
    const value = rawValue === undefined ? undefined : rawValue.replace(/\\(.)/g, '$1')
    const actual = el.attrs[attr]
    if (actual === undefined) return false
    if (op === undefined) return true
    if (op === '=') return actual === value
    if (op === '$=') return actual.endsWith(value)
    return false
  }
  return {
    querySelectorAll(selector) {
      return all.filter((el) => matches(el, selector))
    },
    _all: all,
  }
}

const userBubble = (id) => ({
  attrs: { 'data-chat-node-key': `13:input-message${id}` },
  id,
})

// ───────────────────────────── 选择器候选 ─────────────────────────────

test('候选选择器：user 结算给三级，且第一级是官方精确 key', () => {
  const cands = bubbleSelectorCandidates({
    sourceRef: { kind: 'user-message', eventId: 'u-1' },
  })
  assert.equal(cands.length, 3)
  assert.equal(cands[0], '[data-chat-node-key="13:input-messageu-1"]')
  assert.equal(cands[1], '[data-chat-node-key$="u-1"]')
  assert.ok(cands[2].startsWith('[data-chat-anchor-key$='))
})

test('候选选择器：assistant 结算不给精确 key（官方 kind 无法确定），只给后缀两级', () => {
  const cands = bubbleSelectorCandidates({
    sourceRef: { kind: 'assistant-settlement', eventId: 'a-1' },
  })
  assert.equal(cands.length, 2)
  assert.ok(cands.every((c) => c.includes('$=')), '不该猜官方的 assistant kind')
})

test('候选选择器：没有 sourceRef 就返回空（手建节点没有对应气泡）', () => {
  assert.deepEqual(bubbleSelectorCandidates({}), [])
  assert.deepEqual(bubbleSelectorCandidates(null), [])
})

test('候选选择器：转义 id 里的引号与反斜杠，避免注入坏选择器', () => {
  const cands = bubbleSelectorCandidates({
    sourceRef: { kind: 'user-message', eventId: 'a"b\\c' },
  })
  assert.ok(cands[0].includes('a\\"b\\\\c'), '引号与反斜杠要转义：' + cands[0])
})

// ───────────────────────────── 定位与降级 ─────────────────────────────

test('locateBubble：精确 key 命中时返回唯一元素', () => {
  const dom = makeFakeDom([userBubble('u-1')])
  const r = locateBubble(dom, { sourceRef: { kind: 'user-message', eventId: 'u-1' } })
  assert.equal(r.ok, true)
  assert.equal(r.selector, '[data-chat-node-key="13:input-messageu-1"]')
})

test('locateBubble：精确 key 未命中时降级到后缀匹配（不依赖官方 kind 名）', () => {
  // 假设官方改了 kind 名：精确 key 失效，但后缀匹配仍能命中
  const dom = makeFakeDom([{ attrs: { 'data-chat-node-key': '99:renamed-thingu-2' } }])
  const r = locateBubble(dom, { sourceRef: { kind: 'user-message', eventId: 'u-2' } })
  assert.equal(r.ok, true)
  assert.equal(r.selector, '[data-chat-node-key$="u-2"]', '应降级到后缀匹配')
})

test('locateBubble：**命中多个要报 ambiguous**，不许盲选第一个', () => {
  const dom = makeFakeDom([userBubble('u-3'), userBubble('u-3')])
  const r = locateBubble(dom, { sourceRef: { kind: 'user-message', eventId: 'u-3' } })
  assert.equal(r.ok, false)
  assert.equal(r.reason, 'ambiguous')
})

test('locateBubble：找不到就如实报 not-found（绝不静默）', () => {
  const dom = makeFakeDom([userBubble('other')])
  const r = locateBubble(dom, { sourceRef: { kind: 'user-message', eventId: 'u-9' } })
  assert.equal(r.ok, false)
  assert.equal(r.reason, 'not-found')
})

test('locateBubble：手建节点没有 sourceRef → no-source-ref（不是 not-found）', () => {
  const dom = makeFakeDom([userBubble('u-1')])
  const r = locateBubble(dom, { kind: 'manual', id: 'M1' })
  assert.equal(r.ok, false)
  assert.equal(r.reason, 'no-source-ref')
})

test('locateBubble：没有 DOM 也不抛，报 not-found', () => {
  const r = locateBubble(null, { sourceRef: { kind: 'user-message', eventId: 'u-1' } })
  assert.equal(r.ok, false)
})

// ───────────────────────────── 滚动 + 高亮 ─────────────────────────────

test('scrollToBubble：命中时滚到中间并加临时高亮', () => {
  const dom = makeFakeDom([userBubble('u-4')])
  const r = scrollToBubble(dom, { sourceRef: { kind: 'user-message', eventId: 'u-4' } }, { holdMs: 1 })
  assert.equal(r.ok, true)
  const el = dom.querySelectorAll('[data-chat-node-key$="u-4"]')[0]
  assert.deepEqual(el.scrolled, { block: 'center', behavior: 'smooth' })
  assert.ok(el.style.outline, '要有临时高亮')
})

test('scrollToBubble：找不到时返回失败且不碰任何元素', () => {
  const dom = makeFakeDom([userBubble('other')])
  const r = scrollToBubble(dom, { sourceRef: { kind: 'user-message', eventId: 'u-x' } })
  assert.equal(r.ok, false)
  const el = dom._all[0]
  assert.equal(el.scrolled, undefined, '不得乱滚别的元素')
  assert.equal(el.style.outline, undefined, '不得给别的元素加高亮')
})

// ───────────────────────────── 焦点与选中分离（规格 §5） ─────────────────────────────

test('单击节点：选中它并把焦点移过去', () => {
  const s = applySelection({ selectedIds: [], focusId: 'A' }, { type: 'click-node', id: 'B' })
  assert.deepEqual(s, { selectedIds: ['B'], focusId: 'B' })
})

// ⚠️ `box-select` 这条：**UI 第一版不做多选**（主人拍板 2026-09-27）。
// 这个测试保留的是「纯函数在收到 box-select 时的语义正确性」——
// 函数形状为日后扩展保留，UI 不会产生这个动作。所以它是"形状保留"的回归测试，不是已启用功能。
test('[保留形状] 框选：只改选中，**不动**焦点（UI 第一版不做多选）', () => {
  const s = applySelection(
    { selectedIds: ['A'], focusId: 'A' },
    { type: 'box-select', ids: ['X', 'Y', 'X'] },
  )
  assert.deepEqual(s, { selectedIds: ['X', 'Y'], focusId: 'A' })
})

test('**点空白：取消选中但焦点保留**（规格 §5 明写）', () => {
  const s = applySelection({ selectedIds: ['A', 'B'], focusId: 'B' }, { type: 'click-blank' })
  assert.deepEqual(s, { selectedIds: [], focusId: 'B' }, '点空白绝不清焦点')
})

test('新投影落地：选中它，但焦点跟不跟随由落链规则决定', () => {
  const s = applySelection(
    { selectedIds: ['A'], focusId: 'A' },
    { type: 'new-projection', id: 'N' },
  )
  assert.deepEqual(s, { selectedIds: ['N'], focusId: 'A' })
})

test('未知动作：原样返回，不乱改', () => {
  const s = applySelection({ selectedIds: ['A'], focusId: 'A' }, { type: 'whatever' })
  assert.deepEqual(s, { selectedIds: ['A'], focusId: 'A' })
})

// ───────────────────────────── 视口轻推（规格 §5：不整图 fit） ─────────────────────────────

test('planReveal：节点已在视野内时**不动**视口', () => {
  const r = planReveal({ x: 100, y: 100 }, { x: 0, y: 0, zoom: 1 }, { x: 0, y: 0, width: 800, height: 600 })
  assert.deepEqual(r, { kind: 'none' })
})

test('planReveal：节点在左外侧时给出向右的平移量', () => {
  const r = planReveal({ x: -200, y: 100 }, { x: 0, y: 0, zoom: 1 }, { x: 0, y: 0, width: 800, height: 600 })
  assert.equal(r.kind, 'pan')
  assert.equal(r.dx, 240, '应推到左边距 40 处')
  assert.equal(r.dy, 0)
})

test('planReveal：节点在右外侧时给出向左的平移量', () => {
  const r = planReveal({ x: 2000, y: 100 }, { x: 0, y: 0, zoom: 1 }, { x: 0, y: 0, width: 800, height: 600 })
  assert.equal(r.kind, 'pan')
  assert.ok(r.dx < 0, '往左推')
})

test('planReveal：缺输入时不动（不抛错）', () => {
  assert.deepEqual(planReveal(null, { x: 0, y: 0, zoom: 1 }, { x: 0, y: 0, width: 1, height: 1 }), {
    kind: 'none',
  })
  assert.deepEqual(planReveal({ x: 0, y: 0 }, null, null), { kind: 'none' })
})

// ───────────────────────────── 链的呈现模型（注解三态） ─────────────────────────────

function docWith(nodes, over = {}) {
  const d = createOverlay('s1')
  d.nodes = nodes
  return { ...d, ...over }
}

test('buildChainView：按父子层级给出 depth，链式一条线', () => {
  const doc = docWith({
    U1: { id: 'U1', kind: 'turn', parentId: null, position: { x: 0, y: 0 }, seq: 1, sourceRef: { kind: 'user-message', eventId: 'u1' } },
    A1: { id: 'A1', kind: 'turn', parentId: 'U1', position: { x: 0, y: 0 }, seq: 2, sourceRef: { kind: 'assistant-settlement', eventId: 'a1' } },
    U2: { id: 'U2', kind: 'turn', parentId: 'A1', position: { x: 0, y: 0 }, seq: 3, sourceRef: { kind: 'user-message', eventId: 'u2' } },
  })
  const rows = buildChainView(doc)
  assert.deepEqual(
    rows.map((r) => [r.id, r.depth]),
    [['U1', 0], ['A1', 1], ['U2', 2]],
  )
})

test('buildChainView：注解三态 —— 缺失用派生、空串显示空、非空用注解', () => {
  const doc = docWith({
    A: { id: 'A', kind: 'turn', parentId: null, position: { x: 0, y: 0 }, seq: 1 },
    B: { id: 'B', kind: 'turn', parentId: 'A', position: { x: 0, y: 0 }, seq: 2, title: '' },
    C: { id: 'C', kind: 'turn', parentId: 'B', position: { x: 0, y: 0 }, seq: 3, title: '我的注解' },
  })
  const rows = buildChainView(doc, { derivedTitles: { A: '派生的原文标题' } })
  const by = (id) => rows.find((r) => r.id === id)
  assert.equal(by('A').title, '派生的原文标题', '注解缺失 → 用派生标题')
  assert.equal(by('A').hasAnnotation, false)
  assert.equal(by('B').title, '', '**空串必须保持空**，不回退派生标题')
  assert.equal(by('B').hasAnnotation, true)
  assert.equal(by('C').title, '我的注解')
})

test('buildChainView：标出焦点节点', () => {
  const doc = docWith(
    {
      A: { id: 'A', kind: 'turn', parentId: null, position: { x: 0, y: 0 }, seq: 1 },
      B: { id: 'B', kind: 'turn', parentId: 'A', position: { x: 0, y: 0 }, seq: 2 },
    },
    { focusId: 'B' },
  )
  const rows = buildChainView(doc)
  assert.equal(rows.find((r) => r.id === 'B').isFocus, true)
  assert.equal(rows.find((r) => r.id === 'A').isFocus, false)
})

test('buildChainView：空文档返回空数组；环里的孤岛也不丢', () => {
  assert.deepEqual(buildChainView(createOverlay('s1')), [])
  const doc = docWith({
    X: { id: 'X', kind: 'turn', parentId: 'Y', position: { x: 0, y: 0 }, seq: 1 },
    Y: { id: 'Y', kind: 'turn', parentId: 'X', position: { x: 0, y: 0 }, seq: 2 },
  })
  const rows = buildChainView(doc)
  assert.equal(rows.length, 2, '成环的孤岛也必须出现在列表里')
})

// ───────────────────────────── 报告 ─────────────────────────────
const fails = results.filter(([s]) => s === 'FAIL')
const pad = Math.max(...results.map(([, n]) => n.length))
console.log('')
for (const [status, name, msg] of results) {
  console.log(`  ${status}  ${name.padEnd(pad)}${msg ? '  ← ' + msg : ''}`)
}
console.log('')
console.log(`双向定位自测：${passed} 通过 / ${fails.length} 失败（共 ${results.length} 条）`)
process.exit(fails.length ? 1 : 0)
