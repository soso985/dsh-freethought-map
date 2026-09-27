/**
 * 卡 8 导入 / 导出 / 重建投影自测。
 *
 * 用法：
 *   node scripts/verify-io.mjs
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createOverlay, validateOverlay } from '../src/overlay/index.js'
import { backfill } from '../src/overlay/project.js'
import {
  IMPORT_LIMITS,
  exportJson,
  exportMarkdown,
  helpText,
  mergeImport,
  parseJsonSafely,
  rebuildProjection,
  validateImport,
} from '../src/overlay/io.js'

const results = []
let passed = 0
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
function test(name, fn) {
  try {
    fn()
    passed += 1
    results.push(['PASS', name, ''])
  } catch (e) {
    results.push(['FAIL', name, e.message])
  }
}

const SID = 'session-1'

/** 造一个合法可导入的 overlay JSON 对象 */
function exportable(over = {}) {
  const doc = createOverlay(SID)
  doc.rev = 7
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
    B: { id: 'B', kind: 'manual', parentId: 'A', position: { x: 0, y: 200 }, title: '手建' },
  }
  doc.focusId = 'B'
  doc.freeLinks = [{ id: 'L1', a: 'A', b: 'R' }]
  doc.hidden = []
  doc.updatedAt = 123
  return { ...doc, ...over }
}

// ───────────────────────────── 导出 → 导入 往返 ─────────────────────────────

test('往返：导出 JSON 再导入，节点/粉线/hidden/focus 全都不丢', () => {
  const doc = exportable()
  const text = exportJson(doc, { now: 999 })
  const parsed = parseJsonSafely(text)
  assert.equal(parsed.ok, true)
  const v = validateImport(parsed.value, { sessionId: SID, jsonBytes: text.length })
  assert.equal(v.ok, true, v.reason + ' ' + (v.detail || ''))
  assert.deepEqual(v.doc.nodes, doc.nodes)
  assert.deepEqual(v.doc.freeLinks, doc.freeLinks)
  assert.equal(v.doc.focusId, doc.focusId)
  assert.deepEqual(v.doc.hidden, doc.hidden)
})

test('往返：几何与标签字段一个都不许丢（规格 §10.2）', () => {
  const doc = exportable()
  doc.nodes.B = {
    ...doc.nodes.B,
    width: 220,
    height: 84,
    tags: ['a', 'b'],
    shape: 'pill',
    color: '#f0f',
    collapsed: true,
    locked: true,
  }
  const text = exportJson(doc, {})
  const v = validateImport(JSON.parse(text), { sessionId: SID })
  assert.equal(v.ok, true)
  for (const field of ['width', 'height', 'tags', 'shape', 'color', 'collapsed', 'locked']) {
    assert.deepEqual(v.doc.nodes.B[field], doc.nodes.B[field], '字段丢了：' + field)
  }
})

test('导入：rev 不沿用（规格 §11 明写 rev 不强制导入时沿用）', () => {
  const doc = exportable()
  const v = validateImport(JSON.parse(exportJson(doc, {})), { sessionId: SID })
  assert.equal(v.doc.rev, 0, '导入后的 rev 应由 Host 重新分配')
})

// ───────────────────────────── 导入校验的拒绝面 ─────────────────────────────

test('导入拒绝：version 不对', () => {
  const v = validateImport({ ...exportable(), version: 2 }, { sessionId: SID })
  assert.equal(v.ok, false)
  assert.equal(v.reason, 'bad-version')
})

test('**导入拒绝：sessionId 不匹配（禁止导入进错会话）**', () => {
  const v = validateImport(exportable(), { sessionId: 'session-OTHER' })
  assert.equal(v.ok, false)
  assert.equal(v.reason, 'session-mismatch')
  assert.ok(v.detail.includes('session-1'), v.detail)
})

test('导入拒绝：当前会话未知', () => {
  assert.equal(validateImport(exportable(), {}).reason, 'no-current-session')
})

test('导入拒绝：非对象 / 缺字段', () => {
  assert.equal(validateImport(null, { sessionId: SID }).reason, 'not-an-object')
  assert.equal(validateImport([], { sessionId: SID }).reason, 'not-an-object')
  assert.equal(validateImport({ ...exportable(), nodes: [] }, { sessionId: SID }).reason, 'bad-nodes')
  assert.equal(validateImport({ ...exportable(), freeLinks: null }, { sessionId: SID }).reason, 'bad-free-links')
  assert.equal(validateImport({ ...exportable(), hidden: null }, { sessionId: SID }).reason, 'bad-hidden')
})

test('导入拒绝：节点 id 与 key 不一致', () => {
  const doc = exportable()
  doc.nodes.B = { ...doc.nodes.B, id: 'WRONG' }
  assert.equal(validateImport(doc, { sessionId: SID }).reason, 'id-key-mismatch')
})

test('导入拒绝：kind 非法、position 非法、turn 缺 sourceRef', () => {
  const bad1 = exportable()
  bad1.nodes.B = { ...bad1.nodes.B, kind: 'weird' }
  assert.equal(validateImport(bad1, { sessionId: SID }).reason, 'bad-kind')

  const bad2 = exportable()
  bad2.nodes.B = { ...bad2.nodes.B, position: { x: 'NaN', y: 0 } }
  assert.equal(validateImport(bad2, { sessionId: SID }).reason, 'bad-position')

  const bad3 = exportable()
  bad3.nodes.A = { id: 'A', kind: 'turn', parentId: 'R', position: { x: 0, y: 0 } }
  assert.equal(validateImport(bad3, { sessionId: SID }).reason, 'turn-without-source-ref')
})

test('导入拒绝：悬空 parent、自指 parent、成环', () => {
  const dangling = exportable()
  dangling.nodes.B = { ...dangling.nodes.B, parentId: 'GHOST' }
  assert.equal(validateImport(dangling, { sessionId: SID }).reason, 'dangling-parent')

  const selfParent = exportable()
  selfParent.nodes.B = { ...selfParent.nodes.B, parentId: 'B' }
  assert.equal(validateImport(selfParent, { sessionId: SID }).reason, 'self-parent')

  const cyclic = exportable()
  cyclic.nodes.R = { ...cyclic.nodes.R, parentId: 'B' } // R←A←B←R
  assert.equal(validateImport(cyclic, { sessionId: SID }).reason, 'cycle')
})

test('导入拒绝：粉线端点悬空 / 自连 / id 重复', () => {
  const dangling = exportable()
  dangling.freeLinks = [{ id: 'L1', a: 'A', b: 'GHOST' }]
  assert.equal(validateImport(dangling, { sessionId: SID }).reason, 'dangling-link')

  const selfLink = exportable()
  selfLink.freeLinks = [{ id: 'L1', a: 'A', b: 'A' }]
  assert.equal(validateImport(selfLink, { sessionId: SID }).reason, 'self-link')

  const dup = exportable()
  dup.freeLinks = [{ id: 'L1', a: 'A', b: 'R' }, { id: 'L1', a: 'A', b: 'B' }]
  assert.equal(validateImport(dup, { sessionId: SID }).reason, 'duplicate-link-id')
})

test(`导入拒绝：节点数超过 ${IMPORT_LIMITS.nodes} / JSON 超过 2MB`, () => {
  const doc = exportable()
  const many = {}
  for (let i = 0; i < IMPORT_LIMITS.nodes + 1; i += 1) {
    many['n' + i] = { id: 'n' + i, kind: 'manual', parentId: null, position: { x: 0, y: 0 } }
  }
  doc.nodes = many
  doc.freeLinks = []
  doc.focusId = null
  assert.equal(validateImport(doc, { sessionId: SID }).reason, 'too-many-nodes')

  const ok = exportable()
  assert.equal(
    validateImport(ok, { sessionId: SID, jsonBytes: IMPORT_LIMITS.bytes + 1 }).reason,
    'too-large',
  )
})

test('导入：focusId 指向不存在的节点 → 清空并给 warning（不拒绝）', () => {
  const doc = exportable()
  doc.focusId = 'GHOST'
  const v = validateImport(doc, { sessionId: SID })
  assert.equal(v.ok, true)
  assert.equal(v.doc.focusId, null)
  assert.ok(v.warnings.some((w) => w.includes('focusId')), v.warnings.join(';'))
})

test('parseJsonSafely：坏 JSON 不抛错，返回可读原因', () => {
  assert.equal(parseJsonSafely('{oops').ok, false)
  assert.equal(parseJsonSafely('{oops').reason, 'bad-json')
  assert.equal(parseJsonSafely(null).reason, 'not-a-string')
  assert.equal(parseJsonSafely('{"a":1}').value.a, 1)
})

// ───────────────────────────── 合并语义（规格 §11） ─────────────────────────────

test('合并：同一 sourceRef 两边都有 → 结构字段以**文件**为准，id 沿用当前的', () => {
  const current = exportable()
  current.nodes.A = { ...current.nodes.A, parentId: 'R', position: { x: 5, y: 5 }, title: '当前注解' }

  const file = exportable()
  file.nodes.A = { ...file.nodes.A, parentId: null, position: { x: 999, y: 999 }, title: '文件注解' }

  const r = mergeImport(current, file)
  assert.equal(r.doc.nodes.A.parentId, null, '文件说了算')
  assert.deepEqual(r.doc.nodes.A.position, { x: 999, y: 999 })
  assert.equal(r.doc.nodes.A.title, '文件注解')
  assert.equal(r.stats.updated >= 1, true)
})

test('**合并：不得删除 canonical 仍需要且未在 hidden 中的投影**', () => {
  const current = exportable()
  // 当前 overlay 多了一个文件里没有的投影
  current.nodes.T2 = {
    id: 'T2',
    kind: 'turn',
    parentId: 'R',
    position: { x: 300, y: 0 },
    sourceRef: { kind: 'assistant-settlement', eventId: 'a2' },
    seq: 2,
  }

  const file = exportable() // 文件里没有 T2
  const r = mergeImport(current, file)
  assert.ok(r.doc.nodes.T2, '**文件里没有的投影必须保留**')
  assert.equal(r.doc.nodes.T2.sourceRef.eventId, 'a2')
})

test('合并：文件里的新 manual 节点会被加进来', () => {
  const current = exportable()
  const file = exportable()
  file.nodes.NEW = { id: 'NEW', kind: 'manual', parentId: 'R', position: { x: 50, y: 50 }, title: '新来的' }
  const r = mergeImport(current, file)
  assert.ok(r.doc.nodes.NEW, '新节点要进来')
  assert.equal(r.doc.nodes.NEW.title, '新来的')
})

test('合并：hidden 取并集（导入不能让已摘除的复活）', () => {
  const current = exportable()
  current.hidden = [{ kind: 'user-message', eventId: 'old' }]
  const file = exportable()
  file.hidden = [{ kind: 'assistant-settlement', eventId: 'a9' }]
  const r = mergeImport(current, file)
  const keys = r.doc.hidden.map((h) => h.kind + ':' + h.eventId).sort()
  assert.deepEqual(keys, ['assistant-settlement:a9', 'user-message:old'])
})

test('合并：粉线端点按 id 映射换算（对齐后 id 变了也不能指错）', () => {
  const current = exportable()
  // 当前 A 的 sourceRef 与文件 A 相同 → 对齐，但映射应把文件 A 指到当前 A
  const file = exportable()
  file.freeLinks = [{ id: 'LF', a: 'A', b: 'B' }]
  const r = mergeImport(current, file)
  const link = r.doc.freeLinks.find((l) => l.id === 'LF')
  if (link) {
    assert.ok(r.doc.nodes[link.a], '端点 a 必须存在')
    assert.ok(r.doc.nodes[link.b], '端点 b 必须存在')
  }
})

test('**合并：当前 overlay 原有的粉线不会被丢掉**（文件没带线时也保住）', () => {
  const current = exportable() // 有 L1
  const file = exportable()
  file.freeLinks = [] // 文件里一条线都没有
  const r = mergeImport(current, file)
  assert.ok(
    r.doc.freeLinks.some((l) => l.id === 'L1'),
    '当前 overlay 的线必须留住（第一版写成「文件有就只用文件」，踩过）',
  )
})

test('合并：文件与当前都有同一条线时按 id 去重，不出现两条', () => {
  const current = exportable()
  const file = exportable()
  file.freeLinks = [{ id: 'L1', a: 'A', b: 'B' }] // 与当前同 id、不同端点
  const r = mergeImport(current, file)
  const same = r.doc.freeLinks.filter((l) => l.id === 'L1')
  assert.equal(same.length, 1, '同 id 只能留一条')
  assert.equal(same[0].b, 'B', '文件优先')
})

test('合并：端点已不存在的旧线会被清理（不制造悬空线）', () => {
  const current = exportable()
  current.freeLinks = [{ id: 'L1', a: 'A', b: 'GONE' }]
  const file = exportable()
  file.freeLinks = []
  const r = mergeImport(current, file)
  assert.equal(r.doc.freeLinks.some((l) => l.id === 'L1'), false, '悬空线要清掉')
  assert.deepEqual(validateOverlay(r.doc), { ok: true, errors: [] })
})

test('合并：结果仍然通过 validateOverlay', async () => {
  const r = mergeImport(exportable(), exportable())
  assert.deepEqual(validateOverlay(r.doc), { ok: true, errors: [] })
})

test('合并是**一次 commit**（返回新 doc，不改两个输入）', () => {
  const current = exportable()
  const file = exportable()
  const beforeCurrent = JSON.stringify(current)
  const beforeFile = JSON.stringify(file)
  const r = mergeImport(current, file)
  assert.notEqual(r.doc, current)
  assert.equal(JSON.stringify(current), beforeCurrent, '当前 overlay 不得被改')
  assert.equal(JSON.stringify(file), beforeFile, '导入文件不得被改')
})

// ───────────────────────────── 重建投影（规格 §6.5） ─────────────────────────────

/** 造合成结算事件（形状与卡 3 核对过的一致） */
function userEvent(id, text, seq) {
  return {
    type: 'user/message',
    seq,
    time: 1700000000000 + seq,
    surfaceOp: 'append',
    data: { id, role: 'user', content: [{ type: 'text', text }], source: { kind: 'user' } },
  }
}
function assistantEvent(id, text, seq) {
  return {
    type: 'assistant/message',
    seq,
    time: 1700000000000 + seq,
    surfaceOp: 'append',
    data: { turn: 1, step: 1, message: { id, role: 'assistant', content: [{ type: 'text', text }] }, stream: [] },
  }
}

test('重建投影：对已加载窗口补齐缺失的链', () => {
  const doc = createOverlay(SID)
  const events = [userEvent('u1', '一', 1), assistantEvent('a1', '二', 2), userEvent('u2', '三', 3)]
  let n = 0
  const r = rebuildProjection(doc, events, { backfill, newId: () => 'N' + ++n })
  assert.equal(r.appended, 3)
  assert.deepEqual(r.violations, [], '不得有覆盖已有结构的行为')
})

test('**重建投影：不覆盖已有结构**（用户改过的 parentId/位置/注解都保住）', () => {
  const doc = createOverlay(SID)
  doc.nodes = {
    U1: {
      id: 'U1',
      kind: 'turn',
      parentId: null,
      position: { x: 777, y: 888 },
      title: '用户写的注解',
      sourceRef: { kind: 'user-message', eventId: 'u1' },
      seq: 1,
    },
  }
  doc.focusId = 'U1'
  const events = [userEvent('u1', '一', 1), assistantEvent('a1', '二', 2)]
  let n = 0
  const r = rebuildProjection(doc, events, { backfill, newId: () => 'N' + ++n })
  assert.deepEqual(r.doc.nodes.U1.position, { x: 777, y: 888 }, '位置不得被覆盖')
  assert.equal(r.doc.nodes.U1.title, '用户写的注解', '注解不得被覆盖')
  assert.equal(r.doc.nodes.U1.parentId, null)
  assert.deepEqual(r.violations, [])
  assert.equal(r.appended, 1, '只补了缺的那个')
})

test('**重建投影：不复活 hidden**', () => {
  const doc = createOverlay(SID)
  doc.hidden = [{ kind: 'user-message', eventId: 'u1' }]
  const events = [userEvent('u1', '一', 1), assistantEvent('a1', '二', 2)]
  let n = 0
  const r = rebuildProjection(doc, events, { backfill, newId: () => 'N' + ++n })
  assert.equal(
    Object.values(r.doc.nodes).some((x) => x.sourceRef && x.sourceRef.eventId === 'u1'),
    false,
    'hidden 的结算不得被重建出来',
  )
  assert.deepEqual(r.violations, [])
})

test('重建投影：backfill 若覆盖了已有结构，包装层要**报告违规**', () => {
  const doc = createOverlay(SID)
  doc.nodes = {
    U1: { id: 'U1', kind: 'turn', parentId: null, position: { x: 1, y: 1 }, sourceRef: { kind: 'user-message', eventId: 'u1' }, seq: 1 },
  }
  // 一个"坏"的 backfill：故意改掉已有节点的位置
  const evilBackfill = (d) => ({
    doc: { ...d, nodes: { ...d.nodes, U1: { ...d.nodes.U1, position: { x: 999, y: 999 } } } },
    appended: 0,
    skipped: 0,
  })
  const r = rebuildProjection(doc, [], { backfill: evilBackfill })
  assert.ok(r.violations.length > 0, '必须报告违规')
  assert.ok(r.violations.some((v) => v.includes('position')), r.violations.join(';'))
})

test('重建投影：没有注入 backfill 时明确抛错（不静默用第二份实现）', () => {
  assert.throws(() => rebuildProjection(createOverlay(SID), [], {}), /backfill/)
})

// ───────────────────────────── Markdown 导出 ─────────────────────────────

test('Markdown：注解优先，空串显示占位且**不回退**原文，缺失才用派生标题', () => {
  const doc = exportable()
  doc.nodes.A.body = '原文正文'
  const md = exportMarkdown(doc, { derivedTitles: { A: '派生的原文标题' } })
  assert.ok(md.includes('- 根'), md)
  assert.ok(md.includes('派生的原文标题'), '缺注解的节点用派生标题')
  assert.ok(md.includes('手建'), '有注解的用注解')
})

test('Markdown：空串注解显示「已清空」，不回退派生标题', () => {
  const doc = exportable()
  doc.nodes.B = { ...doc.nodes.B, title: '' }
  const md = exportMarkdown(doc, { derivedTitles: { B: '不该出现的派生标题' } })
  assert.ok(md.includes('（已清空）'), md)
  assert.ok(!md.includes('不该出现的派生标题'), '空串不得回退派生标题')
})

test('Markdown：脚注原文可选，开了才附', () => {
  const doc = exportable()
  const withoutNotes = exportMarkdown(doc, { derivedTitles: { A: '派生' } })
  assert.ok(!withoutNotes.includes('原文脚注'), '没开就不该有脚注段')

  const withNotes = exportMarkdown(doc, {
    derivedTitles: { A: '派生' },
    originalText: { A: '这是 DSH 里的原文首行' },
    footnotes: true,
  })
  assert.ok(withNotes.includes('## 原文脚注'), withNotes)
  assert.ok(withNotes.includes('这是 DSH 里的原文首行'))
  assert.ok(withNotes.includes('[^1]'), '正文里要有脚注引用标记')
})

test('Markdown：层级缩进体现父子关系，并标出焦点', () => {
  const doc = exportable()
  const md = exportMarkdown(doc, { derivedTitles: {} })
  const lines = md.split('\n')
  assert.ok(lines.some((l) => l === '- 根'), '根是顶层')
  assert.ok(lines.some((l) => l.startsWith('  - ')), '子节点有缩进')
  assert.ok(md.includes('← 焦点'), '要标出焦点')
})

test('Markdown：自由联想单列一节', () => {
  const md = exportMarkdown(exportable(), {})
  assert.ok(md.includes('## 自由联想'), md)
  assert.ok(md.includes('↔'), '联想用 ↔ 连接')
})

// ───────────────────────────── 帮助短文 ─────────────────────────────

test('帮助：必须写明「刷新后不能 Ctrl+Z 跨刷新」', () => {
  const t = helpText()
  assert.ok(t.includes('刷新后不能 Ctrl+Z'), t)
})

test('帮助：必须写明撤销历史按会话分开', () => {
  assert.ok(helpText().includes('按会话分开'))
})

test('帮助：必须写明模型只读图（不能改图）', () => {
  const t = helpText()
  assert.ok(t.includes('只能读图'), t)
})

test('帮助：必须说明「摘除」不是删除对话', () => {
  const t = helpText()
  assert.ok(t.includes('摘除') && t.includes('对话还在'), t)
})

test('帮助：出现「禁止一键生成思维导图」是**说明**，不是可执行入口', () => {
  // 规格允许帮助文字里出现这个说法；禁词检查只查可执行入口
  assert.ok(helpText().includes('禁止一键生成思维导图'))
})

test('帮助：bundle 里那份逐字副本与 helpText() 完全一致（防漂移）', () => {
  // 客户端 bundle 不能 import 相对模块，所以帮助文本是**编译**过去的副本
  // （scripts/build-help.mjs）。这条断言保证两边不会分叉。
  const clientSource = readFileSync(join(ROOT, 'src', 'client', 'index.js'), 'utf8')
  const MARKER = 'const HELP_TEXT = ' + '`'
  const start = clientSource.indexOf(MARKER)
  assert.ok(start >= 0, 'bundle 里找不到 HELP_TEXT —— 先跑 node scripts/build-help.mjs')
  const close = clientSource.indexOf('`', start + MARKER.length)
  assert.ok(close > start, 'HELP_TEXT 没有闭合的反引号')
  const embedded = clientSource
    .slice(start + MARKER.length, close)
    .replace(/\\`/g, '`')
    .replace(/\\\$\{/g, '${')
    .replace(/\\\\/g, '\\')
  assert.equal(embedded, helpText(), 'bundle 里的帮助文本已与 helpText() 分叉，重跑 build-help.mjs')
})

// ───────────────────────────── 报告 ─────────────────────────────
const fails = results.filter(([s]) => s === 'FAIL')
const pad = Math.max(...results.map(([, n]) => n.length))
console.log('')
for (const [status, name, msg] of results) {
  console.log(`  ${status}  ${name.padEnd(pad)}${msg ? '  ← ' + msg : ''}`)
}
console.log('')
console.log(`导入导出与重建自测：${passed} 通过 / ${fails.length} 失败（共 ${results.length} 条）`)
process.exit(fails.length ? 1 : 0)
