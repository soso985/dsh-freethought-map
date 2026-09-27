/**
 * 导入 / 导出 / 重建投影（卡 8）—— 纯函数。
 *
 * 规格来源：`docs/01-产品与技术规格.md` §6.5（重建投影）、§10.1（注解三态）、
 * §10.2（几何字段往返不得丢）、§11（JSON 导入导出）。
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * 这一层不碰 DOM、不碰 ctx，所以「导入校验」「合并语义」「导出格式」全部可以离线验死。
 * 唯一需要真画布的是 PNG 导出 —— **那件事刻意不做**：与其导出一张假的空图，
 * 不如在 UI 上明确说明它需要画布，等画布做出来再补。
 *
 * 合并语义是这里最容易写错的地方（规格 §11 原文）：
 *   · 文件里的 user-structure 字段**采用文件**（manual / parentId / position / 注解 / hidden / 粉线）
 *   · **不得**删除 canonical 仍需要且未在 hidden 中的投影 —— 缺的**补链**
 *   · 同一 sourceRef 两边都有 → 结构字段以**导入文件**为准
 * ═══════════════════════════════════════════════════════════════════════════
 */

import { OVERLAY_VERSION, canSetParent, createOverlay, isHidden, refKey, validateOverlay } from './index.js'

/** 导入体积上限（规格 §11：nodes ≤ 5000、JSON ≤ 2MB）。 */
export const IMPORT_LIMITS = {
  nodes: 5000,
  bytes: 2 * 1024 * 1024,
  freeLinks: 10000,
}

export const IMPORT_OK = 'ok'

/**
 * 校验一份待导入的 JSON（规格 §11）。
 *
 * **禁止导入进错会话**：`sessionId` 必须与当前会话一致 —— 这是硬拒绝，不是警告。
 *
 * @param {unknown} raw 已 parse 的对象（字符串请先 parseJsonSafely）
 * @param {{ sessionId: string, jsonBytes?: number }} ctx
 * @returns {{ ok: true, doc: object, warnings: string[] }
 *          | { ok: false, reason: string, detail?: string }}
 */
export function validateImport(raw, ctx) {
  const sessionId = ctx && ctx.sessionId
  if (!sessionId) return { ok: false, reason: 'no-current-session' }

  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    return { ok: false, reason: 'not-an-object' }
  }
  if (raw.version !== OVERLAY_VERSION) {
    return {
      ok: false,
      reason: 'bad-version',
      detail: '期望 version=' + String(OVERLAY_VERSION) + '，实际 ' + JSON.stringify(raw.version),
    }
  }
  if (typeof raw.sessionId !== 'string' || raw.sessionId !== sessionId) {
    return {
      ok: false,
      reason: 'session-mismatch',
      detail: '文件属于 ' + JSON.stringify(raw.sessionId) + '，当前会话是 ' + sessionId,
    }
  }
  if (typeof ctx.jsonBytes === 'number' && ctx.jsonBytes > IMPORT_LIMITS.bytes) {
    return { ok: false, reason: 'too-large', detail: String(ctx.jsonBytes) + ' 字节' }
  }
  if (raw.nodes === null || typeof raw.nodes !== 'object' || Array.isArray(raw.nodes)) {
    return { ok: false, reason: 'bad-nodes' }
  }
  if (!Array.isArray(raw.freeLinks)) return { ok: false, reason: 'bad-free-links' }
  if (!Array.isArray(raw.hidden)) return { ok: false, reason: 'bad-hidden' }

  const ids = Object.keys(raw.nodes)
  if (ids.length > IMPORT_LIMITS.nodes) {
    return { ok: false, reason: 'too-many-nodes', detail: String(ids.length) }
  }
  if (raw.freeLinks.length > IMPORT_LIMITS.freeLinks) {
    return { ok: false, reason: 'too-many-links', detail: String(raw.freeLinks.length) }
  }

  const warnings = []

  // 节点自身的字段检查
  for (const id of ids) {
    const node = raw.nodes[id]
    if (!node || typeof node !== 'object') return { ok: false, reason: 'bad-node', detail: id }
    if (node.id !== id) {
      return { ok: false, reason: 'id-key-mismatch', detail: id + ' vs ' + String(node.id) }
    }
    if (node.kind !== 'turn' && node.kind !== 'manual') {
      return { ok: false, reason: 'bad-kind', detail: id + ' → ' + String(node.kind) }
    }
    const pos = node.position
    if (!pos || typeof pos.x !== 'number' || typeof pos.y !== 'number' || !isFinite(pos.x) || !isFinite(pos.y)) {
      return { ok: false, reason: 'bad-position', detail: id }
    }
    if (node.kind === 'turn') {
      if (!node.sourceRef || typeof node.sourceRef.kind !== 'string' || typeof node.sourceRef.eventId !== 'string') {
        return { ok: false, reason: 'turn-without-source-ref', detail: id }
      }
    } else if (node.sourceRef !== undefined) {
      // manual 节点不该有 sourceRef —— 有就说明文件被手工改坏了
      warnings.push('manual 节点 ' + id + ' 带了 sourceRef，已忽略')
    }
  }

  // parent 引用必须存在（null 允许），且不得成环
  for (const id of ids) {
    const parentId = raw.nodes[id].parentId ?? null
    if (parentId === null) continue
    if (!raw.nodes[parentId]) {
      return { ok: false, reason: 'dangling-parent', detail: id + ' → ' + parentId }
    }
    if (parentId === id) return { ok: false, reason: 'self-parent', detail: id }
  }
  const cycle = findCycle(raw.nodes)
  if (cycle) return { ok: false, reason: 'cycle', detail: cycle.join(' → ') }

  // 粉线端点必须存在，且不得自连
  const linkIds = new Set()
  for (const link of raw.freeLinks) {
    if (!link || typeof link.id !== 'string' || !link.id) return { ok: false, reason: 'bad-link-id' }
    if (linkIds.has(link.id)) return { ok: false, reason: 'duplicate-link-id', detail: link.id }
    linkIds.add(link.id)
    if (!raw.nodes[link.a] || !raw.nodes[link.b]) {
      return { ok: false, reason: 'dangling-link', detail: link.id }
    }
    if (link.a === link.b) return { ok: false, reason: 'self-link', detail: link.id }
  }

  // hidden 项形状
  for (const h of raw.hidden) {
    if (!h || typeof h.kind !== 'string' || typeof h.eventId !== 'string') {
      return { ok: false, reason: 'bad-hidden-entry' }
    }
  }

  // focusId 指向的节点若不存在 → 降级为 null（不拒绝，只提示）
  let focusId = raw.focusId ?? null
  if (focusId !== null && !raw.nodes[focusId]) {
    warnings.push('focusId 指向不存在的节点 ' + focusId + '，已清空')
    focusId = null
  }

  const doc = {
    version: OVERLAY_VERSION,
    sessionId,
    rev: 0, // rev 由 Host 在保存时分配（规格 §11：rev 不强制导入时沿用）
    nodes: raw.nodes,
    freeLinks: raw.freeLinks,
    focusId,
    hidden: raw.hidden,
    updatedAt: typeof raw.updatedAt === 'number' ? raw.updatedAt : 0,
  }

  const v = validateOverlay(doc)
  if (!v.ok) return { ok: false, reason: 'invalid-overlay', detail: v.errors.join('; ') }

  return { ok: true, doc, warnings }
}

/** 安全 parse：返回结果对象而不是抛错（导入路径上不该抛）。 */
export function parseJsonSafely(text) {
  if (typeof text !== 'string') return { ok: false, reason: 'not-a-string' }
  try {
    return { ok: true, value: JSON.parse(text) }
  } catch (e) {
    return { ok: false, reason: 'bad-json', detail: e && e.message ? e.message : String(e) }
  }
}

/** 环形检测：返回环上的节点 id 序列（没有环返回 null）。 */
function findCycle(nodes) {
  const state = new Map() // 0=未访问 1=在栈上 2=已完成
  for (const start of Object.keys(nodes)) {
    if (state.get(start) === 2) continue
    const path = []
    let cursor = start
    while (cursor !== null && cursor !== undefined) {
      if (state.get(cursor) === 1) {
        const at = path.indexOf(cursor)
        return at >= 0 ? path.slice(at) : path
      }
      if (state.get(cursor) === 2) break
      state.set(cursor, 1)
      path.push(cursor)
      cursor = nodes[cursor]?.parentId ?? null
    }
    for (const id of path) state.set(id, 2)
  }
  return null
}

// ───────────────────────────── 合并（规格 §11） ─────────────────────────────

/**
 * 把导入的 doc 合并进当前 overlay。
 *
 * 规格 §11 的原文规则，逐条对应：
 *   1. **manual、parentId、position、注解、hidden、粉线采用文件** —— 文件说了算；
 *   2. **不得删除 canonical 仍需要且未在 hidden 中的投影** —— 当前 overlay 里
 *      文件没有的 turn 节点**原样保留**；
 *   3. **同一 sourceRef 两边都有 → 结构字段以导入文件为准** —— 用 sourceRef 对齐，
 *      把文件里那个节点的**结构字段**搬到当前 overlay 的对应节点上（保留它的 id）；
 *   4. **缺的补链** —— 合并后由调用方跑 `rebuildProjection` 补齐（本函数只做合并）。
 *
 * @param {object} current 当前 overlay
 * @param {object} incoming 已通过 validateImport 的 doc
 * @returns {{ doc: object, stats: { updated: number, added: number, kept: number, hidden: number } }}
 */
export function mergeImport(current, incoming) {
  const base = current && current.nodes ? current : createOverlay(incoming.sessionId)

  // 当前 overlay 的 sourceRef → nodeId 索引（用来对齐"同一个结算"）
  const byRef = new Map()
  for (const node of Object.values(base.nodes)) {
    if (node.kind === 'turn' && node.sourceRef) byRef.set(refKey(node.sourceRef), node.id)
  }

  const nodes = { ...base.nodes }
  /** 文件节点 id → 最终落在当前 overlay 里的节点 id */
  const idMap = new Map()
  let updated = 0

  // 第一遍：对齐/新增节点
  for (const fileNode of Object.values(incoming.nodes)) {
    const key = fileNode.kind === 'turn' && fileNode.sourceRef ? refKey(fileNode.sourceRef) : null
    const existingId = key ? byRef.get(key) : null

    if (existingId) {
      // 同一个结算两边都有 → **结构字段以文件为准**，id 沿用当前的
      const existing = nodes[existingId]
      nodes[existingId] = applyStructuralFields(existing, fileNode)
      idMap.set(fileNode.id, existingId)
      updated += 1
    } else {
      // 文件里的新节点（含 manual 与文件独有的 turn）
      const id = fileNode.id
      if (nodes[id]) {
        // id 撞了但不指向同一个结算 —— 罕见，按文件覆盖
        nodes[id] = applyStructuralFields(nodes[id], fileNode)
      } else {
        nodes[id] = clone(fileNode)
      }
      idMap.set(fileNode.id, id)
    }
  }

  // 第二遍：把文件里的 parentId 映射到最终 id（因为对齐后 id 可能变了）
  for (const [fileId, finalId] of idMap) {
    const fileNode = incoming.nodes[fileId]
    const desired = fileNode.parentId === null || fileNode.parentId === undefined
      ? null
      : idMap.get(fileNode.parentId) ?? null
    if (fileNode.parentId !== null && fileNode.parentId !== undefined && desired === null) {
      // 文件的父在映射里找不到（不该发生，validateImport 已挡悬空父）→ 保守置顶层
      nodes[finalId] = { ...nodes[finalId], parentId: null }
      continue
    }
    if ((nodes[finalId].parentId ?? null) === desired) continue
    // 防环：映射后仍可能成环（对齐把两个 id 合成一个）
    const probe = { ...base, nodes: { ...nodes, [finalId]: { ...nodes[finalId], parentId: desired } } }
    if (canSetParent(probe, finalId, desired).ok) {
      nodes[finalId] = { ...nodes[finalId], parentId: desired }
    }
  }

  // 第三遍：粉线采用文件（端点按 idMap 换算；映射不到就丢弃并计数）
  const links = []
  const linkIds = new Set()
  for (const link of incoming.freeLinks) {
    const a = idMap.get(link.a)
    const b = idMap.get(link.b)
    if (!a || !b || a === b) continue
    let id = link.id
    while (linkIds.has(id)) id = id + '~' // 与当前 overlay 已有的线 id 撞了就换个不撞的
    linkIds.add(id)
    links.push({ id, a, b })
  }

  // 第四遍：hidden 合并（**采用文件**，但当前 overlay 已有的也保留 —— 摘除记录不能因为导入而复活）
  const hiddenKeys = new Set(base.hidden.map(refKey))
  const hidden = [...base.hidden]
  for (const h of incoming.hidden) {
    if (!hiddenKeys.has(refKey(h))) {
      hidden.push({ ...h })
      hiddenKeys.add(refKey(h))
    }
  }

  // 第五遍：当前 overlay 里**文件没有的 turn 节点**原样保留（规格第 2 条）
  let kept = 0
  for (const node of Object.values(base.nodes)) {
    if (node.kind !== 'turn') continue
    if (byRef.has(refKey(node.sourceRef))) {
      const mapped = idMap.get(node.id)
      if (mapped === undefined || nodes[node.id] === undefined) {
        // 文件里没有这个结算 → 保留当前那份
        nodes[node.id] = node
        kept += 1
      }
    }
  }

  let focusId = base.focusId
  if (incoming.focusId !== null && incoming.focusId !== undefined) {
    focusId = idMap.get(incoming.focusId) ?? (nodes[incoming.focusId] ? incoming.focusId : focusId)
  }

  return {
    doc: {
      ...base,
      nodes,
      // 粉线 = 当前 overlay 原有的（过滤掉端点已不存在的）∪ 文件带来的（按 id 去重、文件优先）。
      // ⚠️ 不能写成「文件有就只用文件」—— 那会凭空丢掉用户当前的联想（本轮写第一版时踩到）。
      freeLinks: dedupeLinks(
        base.freeLinks.filter((l) => keptOnly({ nodes }, l)),
        links,
      ),
      focusId,
      hidden,
    },
    stats: { updated, added: idMap.size - updated, kept, hidden: hidden.length - base.hidden.length },
  }
}

/** 保留当前 overlay 里那些**两端都还在**的粉线（合并时文件说了算，但不能凭空制造悬空线）。 */
function keptOnly(doc, link) {
  return Boolean(doc.nodes[link.a] && doc.nodes[link.b])
}

/** 当前 overlay 原有的线 ∪ 文件带来的线（按 id 去重，文件优先）。 */
function dedupeLinks(currentLinks, incomingLinks) {
  const byId = new Map(currentLinks.map((l) => [l.id, l]))
  for (const l of incomingLinks) byId.set(l.id, l)
  return [...byId.values()]
}

/**
 * 把「结构字段」从 `from` 搬到 `to`：manual/parentId/position/注解/几何。
 *
 * `sourceRef` 与 `id` **不搬** —— id 要沿用当前 overlay 的，
 * sourceRef 是"同一个结算"的对齐依据，两边本来就相同。
 */
function applyStructuralFields(to, from) {
  const next = { ...to }
  for (const field of ['parentId', 'position', 'width', 'height', 'tags', 'shape', 'color', 'collapsed', 'locked']) {
    if (Object.prototype.hasOwnProperty.call(from, field)) next[field] = clone(from[field])
    else delete next[field]
  }
  // 注解三态：文件没这个字段就**删掉**（而不是留下当前的值）
  if (Object.prototype.hasOwnProperty.call(from, 'title')) next.title = from.title
  else delete next.title
  return next
}

function clone(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value))
}

// ───────────────────────────── 重建投影（规格 §6.5） ─────────────────────────────

/**
 * 「重建投影」：对**当前已加载窗口**跑一遍落链算法，仍**不覆盖已有结构、不复活 hidden**。
 *
 * 这正是卡 3 的 `backfill` 的语义 —— 所以这里不做第二份实现，只做一层**安全包装**：
 * 跑完之后断言「没有覆盖已有节点的 parentId/position/注解、没有复活 hidden」。
 * 与其写第二份算法冒着分叉的风险，不如复用 + 事后验证。
 *
 * @param {object} doc
 * @param {any[]} events 已加载窗口内的事件，**调用方保证按 seq 升序**
 * @param {{ backfill: Function, newId?: () => string }} deps
 * @returns {{ doc: object, appended: number, skipped: number, violations: string[] }}
 */
export function rebuildProjection(doc, events, deps) {
  if (!deps || typeof deps.backfill !== 'function') {
    throw new Error('rebuildProjection 需要注入 backfill（卡 3 的那份实现）')
  }
  // 记下"已有结构"，跑完后逐项核对没有被改（规格：仍不覆盖已有结构）
  const before = new Map()
  for (const node of Object.values(doc.nodes)) {
    before.set(node.id, {
      parentId: node.parentId ?? null,
      position: node.position ? { ...node.position } : null,
      hasTitle: Object.prototype.hasOwnProperty.call(node, 'title'),
      title: node.title,
    })
  }
  const hiddenBefore = new Set(doc.hidden.map(refKey))

  const r = deps.backfill(doc, events, deps.newId ? { newId: deps.newId } : {})
  const violations = []

  // 1) 已有节点不得被改结构
  for (const [id, snapshot] of before) {
    const node = r.doc.nodes[id]
    if (!node) {
      violations.push('已有节点被删掉：' + id)
      continue
    }
    if ((node.parentId ?? null) !== snapshot.parentId) {
      violations.push('parentId 被覆盖：' + id)
    }
    if (snapshot.position && node.position && (node.position.x !== snapshot.position.x || node.position.y !== snapshot.position.y)) {
      violations.push('position 被覆盖：' + id)
    }
    const hasTitle = Object.prototype.hasOwnProperty.call(node, 'title')
    if (hasTitle !== snapshot.hasTitle || (hasTitle && node.title !== snapshot.title)) {
      violations.push('注解被覆盖：' + id)
    }
  }

  // 2) hidden 不得被复活
  for (const ref of doc.hidden) {
    if (!hiddenBefore.has(refKey(ref))) continue // 本来就在，不管
    const alive = Object.values(r.doc.nodes).some((n) => n.sourceRef && refKey(n.sourceRef) === refKey(ref))
    if (alive && !isHidden(r.doc, ref)) violations.push('hidden 被复活：' + refKey(ref))
  }

  return { doc: r.doc, appended: r.appended, skipped: r.skipped, violations }
}

// ───────────────────────────── 导出 ─────────────────────────────

/**
 * 导出 overlay JSON（规格 §11 第 1 项）。
 *
 * `rev` 一并写出便于人类比对，但导入时**不沿用**（规格明写 rev 不强制）。
 */
export function exportJson(doc, opts = {}) {
  const pretty = opts.pretty !== false
  const payload = {
    version: OVERLAY_VERSION,
    sessionId: doc.sessionId,
    rev: doc.rev,
    focusId: doc.focusId,
    nodes: doc.nodes,
    freeLinks: doc.freeLinks,
    hidden: doc.hidden,
    updatedAt: doc.updatedAt,
    exportedAt: opts.now === undefined ? null : opts.now,
  }
  return pretty ? JSON.stringify(payload, null, 2) : JSON.stringify(payload)
}

/**
 * 导出 Markdown 大纲（规格 §11 第 2 项：注解优先，脚注原文可选）。
 *
 * 注解三态在这里同样生效：
 *   · 有注解 → 用注解
 *   · 注解是 `""` → 显示占位（**不回退**原文）
 *   · 注解缺失 → 用派生标题，并在「脚注原文」模式下附上原文
 *
 * @param {object} doc
 * @param {{ derivedTitles?: Record<string,string>, originalText?: Record<string,string>, footnotes?: boolean, title?: string }} [opts]
 */
export function exportMarkdown(doc, opts = {}) {
  const derived = opts.derivedTitles || {}
  const original = opts.originalText || {}
  const footnotes = opts.footnotes === true
  const lines = []
  const notes = []

  lines.push('# ' + (opts.title || 'FreeThought Map'))
  lines.push('')
  const total = Object.keys(doc.nodes).length
  lines.push(
    '- 会话：`' + String(doc.sessionId) + '`\n- 节点：' + String(total) + '\n- 自由联想：' + String(doc.freeLinks.length),
  )
  lines.push('')

  const kids = new Map()
  for (const node of Object.values(doc.nodes)) {
    const list = kids.get(node.parentId ?? null) || []
    list.push(node.id)
    kids.set(node.parentId ?? null, list)
  }
  const roots = Object.values(doc.nodes)
    .filter((n) => !n.parentId || !doc.nodes[n.parentId])
    .map((n) => n.id)
  roots.sort((a, b) => (doc.nodes[a].seq || 0) - (doc.nodes[b].seq || 0) || (a < b ? -1 : 1))

  const seen = new Set()
  const walk = (id, depth) => {
    if (seen.has(id)) return
    seen.add(id)
    const node = doc.nodes[id]
    if (!node) return
    const annotated = node.title
    let label
    if (annotated === undefined || annotated === null) {
      label = derived[id] || '（未命名）'
      if (footnotes && original[id]) {
        const n = notes.length + 1
        notes.push('[' + n + '] ' + String(original[id]).replace(/\s+/g, ' ').trim())
        label = label + '[^' + n + ']'
      }
    } else if (annotated === '') {
      label = '（已清空）' // 用户主动清空 —— **不回退**原文
    } else {
      label = annotated
    }
    const mark = doc.focusId === id ? ' ← 焦点' : ''
    lines.push('  '.repeat(depth) + '- ' + label + mark)
    for (const c of kids.get(id) || []) walk(c, depth + 1)
  }
  for (const r of roots) walk(r, 0)
  for (const id of Object.keys(doc.nodes)) walk(id, 0)

  if (doc.freeLinks.length) {
    lines.push('')
    lines.push('## 自由联想')
    lines.push('')
    for (const link of doc.freeLinks) {
      const a = doc.nodes[link.a]
      const b = doc.nodes[link.b]
      if (!a || !b) continue
      lines.push('- ' + nameForLabel(a, derived) + ' ↔ ' + nameForLabel(b, derived))
    }
  }

  if (notes.length) {
    lines.push('')
    lines.push('## 原文脚注')
    lines.push('')
    for (const note of notes) lines.push(note)
  }

  return lines.join('\n') + '\n'
}

function nameForLabel(node, derived) {
  const annotated = node && node.title
  if (annotated !== undefined && annotated !== null) return annotated === '' ? '（已清空）' : annotated
  return (derived && derived[node.id]) || '（未命名）'
}

// ───────────────────────────── 帮助短文 ─────────────────────────────

/**
 * 帮助短文（规格 §7 要求写明"刷新后不能 Ctrl+Z 跨刷新"）。
 *
 * 写成一个纯函数返回字符串，而不是散在 JSX 里 —— 这样"必须写到的几条"
 * 可以用断言钉住，避免以后改 UI 时把关键说明弄丢。
 */
export function helpText() {
  return [
    '这块面板是会话思路图，不是聊天窗口 —— 说话还是在官方输入框里。',
    '',
    '## 图是怎么长出来的',
    '每完成一轮（你发一句、模型答完），图里就多两个节点。它们按时间连成一条链。',
    '',
    '## 你能做的',
    '· 点一行：把焦点移过去（下一句默认挂在它下面）',
    '· 「跳到气泡」：回到官方对话里对应的那一条',
    '· 手建节点、拖动、改父、写注解、摘除 —— 这些操作都可以 Ctrl+Z 撤销',
    '',
    '## 图会被怎样使用',
    '发送前会把**当前焦点**和**这一轮新拉的自由联想**以「[用户图数据]」的形式附在消息后面。',
    '模型只能读图，不能改图 —— 结构永远是你说了算。',
    '',
    '## 几点要知道的',
    '· **刷新后不能 Ctrl+Z 跨刷新**：撤销历史只活在内存里；图本身存在本地，不会丢。',
    '· 撤销历史**按会话分开**，切换会话会换一套历史。',
    '· 「摘除」不是删除对话 —— 对话还在，图里不再显示它，也不会被自动补链建回来。',
    '· 帮助里出现「禁止一键生成思维导图」是说明：这个产品**刻意不做**自动成树，',
    '  结构必须由你自己长出来或手建。',
  ].join('\n')
}
