/**
 * overlay 纯函数层 —— 不 import ctx，不碰 DOM，不读存储。
 *
 * 这一层是插件的「大脑」，也是唯一能被单测的部分：落链、补链、上提、防环、注解三态、派生标题。
 * 宿主与客户端两侧都只做 I/O，判断全部回到这里。
 *
 * 类型与规则来自 docs/01-产品与技术规格.md §6、§7、§10。
 * 宿主版本：dsh 0.1.7-rc.2 · commit c1275515b6b97551ec358c926c479ab750c687c0
 *
 * @typedef {string} ID
 * @typedef {{ kind: 'user-message' | 'assistant-settlement', eventId: string }} SourceRef
 * @typedef {{
 *   id: ID,
 *   kind: 'turn' | 'manual',
 *   sourceRef?: SourceRef,
 *   parentId: ID | null,
 *   title?: string | null,
 *   body?: string | null,
 *   position: { x: number, y: number },
 *   width?: number, height?: number,
 *   tags?: string[], collapsed?: boolean, locked?: boolean, color?: string, shape?: string,
 * }} OverlayNode
 * @typedef {{ id: ID, a: ID, b: ID }} FreeLink
 * @typedef {{
 *   version: 1, sessionId: string, rev: number,
 *   nodes: Record<ID, OverlayNode>, freeLinks: FreeLink[],
 *   focusId: ID | null, hidden: SourceRef[], updatedAt: number,
 * }} OverlayDoc
 */

export const OVERLAY_VERSION = 1

/**
 * 面板宽度的上下限（px）。宿主右列本身有 264～420 的侧栏习惯与 70% 视口上限，
 * 这里给的是插件自己那一层的钳制范围。
 */
export const PANEL_WIDTH_MIN = 264
export const PANEL_WIDTH_MAX = 900
export const PANEL_WIDTH_DEFAULT = 420

/**
 * 把任意输入钳制成一个合法面板宽度。
 * 非有限数（含 NaN / Infinity / 字符串 "abc"）一律回落到默认值。
 * @param {unknown} value
 * @returns {number}
 */
export function clampPanelWidth(value) {
  const n = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(n)) return PANEL_WIDTH_DEFAULT
  return Math.min(PANEL_WIDTH_MAX, Math.max(PANEL_WIDTH_MIN, Math.round(n)))
}

/** 派生标题的截断长度（规格 §6.4：显示标题派生自原文截断 24 字，**不写入** title 字段）。 */
export const DERIVED_TITLE_LIMIT = 24

// ───────────────────────────── sourceRef ─────────────────────────────

/**
 * sourceRef 的稳定序列化形式，用作去重集合的键。
 * 规格 §6.2：`eventId` 与 `turnId` 禁止混用；同一 overlay 内 sourceRef 唯一。
 * @param {SourceRef} ref
 */
export function refKey(ref) {
  return `${ref.kind}:${ref.eventId}`
}

/**
 * 两个 sourceRef 是否指同一条结算。
 * @param {SourceRef | undefined | null} a
 * @param {SourceRef | undefined | null} b
 */
export function sameRef(a, b) {
  if (!a || !b) return false
  return a.kind === b.kind && a.eventId === b.eventId
}

/**
 * 找出已经投影了该 sourceRef 的节点（用于「重复事件、重连重放 → no-op」）。
 * @param {OverlayDoc} doc
 * @param {SourceRef} ref
 * @returns {OverlayNode | undefined}
 */
export function findByRef(doc, ref) {
  const want = refKey(ref)
  for (const node of Object.values(doc.nodes)) {
    if (node.sourceRef && refKey(node.sourceRef) === want) return node
  }
  return undefined
}

/**
 * 该 sourceRef 是否已被摘除（hidden 集按 sourceRef 存，**不是**按 node.id）。
 * @param {OverlayDoc} doc
 * @param {SourceRef} ref
 */
export function isHidden(doc, ref) {
  const want = refKey(ref)
  return doc.hidden.some((r) => refKey(r) === want)
}

// ───────────────────────────── 注解三态（规格 §10.1） ─────────────────────────────

/**
 * 注解三态求值：
 *   - 字段缺失 / undefined → 用 DSH 原文（调用方传原文进来）
 *   - 字段 ""             → 用户主动清空，显示空，**不再回退原文**
 *   - 字段非空             → 显示注解
 *
 * ⚠️ 线 A（v0.1 独立站）的 `ThoughtNode.title` 是必填字符串且空值回落成「未命名」，
 *    与本函数语义相反 —— 那两个模块（Inspector / ThoughtNode）**不能直接搬**进来。
 *
 * @param {string | null | undefined} annotated  overlay 上的注解字段
 * @param {string} fallback  DSH 原文（或由原文派生的标题）
 * @returns {string}
 */
export function resolveAnnotation(annotated, fallback) {
  if (annotated === undefined || annotated === null) return fallback
  return annotated
}

/**
 * 派生标题：取原文首行、压缩空白、截断到 24 字。**只用于显示，绝不写回 overlay。**
 * @param {string} text
 * @param {number} [limit]
 */
export function deriveTitle(text, limit = DERIVED_TITLE_LIMIT) {
  const firstLine = String(text ?? '')
    .split(/\r?\n/)[0]
    .replace(/\s+/g, ' ')
    .trim()
  if (firstLine.length <= limit) return firstLine
  return firstLine.slice(0, limit) + '…'
}

// ───────────────────────────── 防环与上提（复用线 A 的算法） ─────────────────────────────

/**
 * `maybeDescendantId` 是否在 `ancestorId` 的子树里（含自身）。
 * 带 guard 集合，即使数据被写坏成环也会终止。
 * @param {OverlayDoc} doc
 * @param {ID} ancestorId
 * @param {ID} maybeDescendantId
 */
export function isDescendant(doc, ancestorId, maybeDescendantId) {
  let cursor = maybeDescendantId
  const guard = new Set()
  while (cursor && !guard.has(cursor)) {
    if (cursor === ancestorId) return true
    guard.add(cursor)
    cursor = doc.nodes[cursor]?.parentId ?? null
  }
  return false
}

/**
 * 改父是否合法：自指、指向不存在的节点、成环，三种都拒绝。
 * @param {OverlayDoc} doc
 * @param {ID} childId
 * @param {ID | null} parentId
 * @returns {{ ok: true } | { ok: false, reason: 'self' | 'missing-child' | 'missing-parent' | 'cycle' }}
 */
export function canSetParent(doc, childId, parentId) {
  if (!doc.nodes[childId]) return { ok: false, reason: 'missing-child' }
  if (parentId === null) return { ok: true }
  if (childId === parentId) return { ok: false, reason: 'self' }
  if (!doc.nodes[parentId]) return { ok: false, reason: 'missing-parent' }
  if (isDescendant(doc, childId, parentId)) return { ok: false, reason: 'cycle' }
  return { ok: true }
}

/**
 * 摘除/删除 X 后，X 的直接子节点应该挂到谁：沿祖先链向上找第一个不在 kill 集里的节点。
 * 规格 §6.6 是唯一规则：所有子节点（turn 与 manual）`parentId ← X.parentId`，可因此变成顶层。
 * @param {OverlayDoc} doc
 * @param {Set<ID>} kill
 * @param {ID} from  被删节点的 id（从它的父开始向上找）
 * @returns {ID | null}
 */
export function liftTarget(doc, kill, from) {
  let cursor = doc.nodes[from]?.parentId ?? null
  const guard = new Set()
  while (cursor && kill.has(cursor) && !guard.has(cursor)) {
    guard.add(cursor)
    cursor = doc.nodes[cursor]?.parentId ?? null
  }
  return cursor
}

// ───────────────────────────── 补链（规格 §6.5） ─────────────────────────────

/**
 * 时间线补链的默认父节点：`prev`（时间线上前一个已存在且未隐藏的 turn 节点）。
 *
 * ⚠️ 这是**唯一**允许用历史顺序推父节点的地方；调用方**禁止**把当前 live `focusId` 传进来当父。
 * 规格 §6.5：「禁止用当前 live focusId 给历史节点当父」。
 *
 * @param {OverlayDoc} doc
 * @param {ID | null} prevTurnId  时间线上紧邻的上一个未隐藏 turn 节点；没有就是 null（新顶层链）
 * @returns {ID | null}
 */
export function linkParentFromTimeline(doc, prevTurnId) {
  if (prevTurnId === null || prevTurnId === undefined) return null
  return doc.nodes[prevTurnId] ? prevTurnId : null
}

// ───────────────────────────── 校验（规格 §11） ─────────────────────────────

/**
 * overlay 结构与红线校验。用于导入 JSON 与每次写盘前自检。
 *
 * 检查项：
 *   1. `version === 1`、`sessionId` 非空、`rev` 是非负有限数、`updatedAt` 是有限数
 *   2. 每个节点 id 与所在键一致；kind 合法
 *   3. turn 必须有 sourceRef；manual **禁止**有 sourceRef
 *   4. sourceRef 全局唯一（规格 §6.2）
 *   5. parentId 指向存在的节点，或 null
 *   6. parentId 不成环
 *   7. 粉线端点存在、a !== b、无自连、无重复（无向去重）
 *   8. focusId 要么 null，要么指向存在的节点
 *
 * @param {any} doc
 * @returns {{ ok: boolean, errors: string[] }}
 */
export function validateOverlay(doc) {
  /** @type {string[]} */
  const errors = []
  const bad = (msg) => errors.push(msg)

  if (!doc || typeof doc !== 'object') return { ok: false, errors: ['不是对象'] }
  if (doc.version !== OVERLAY_VERSION) bad(`version 必须是 ${OVERLAY_VERSION}，实际 ${JSON.stringify(doc.version)}`)
  if (typeof doc.sessionId !== 'string' || !doc.sessionId) bad('sessionId 必须是非空字符串')
  if (!Number.isFinite(doc.rev) || doc.rev < 0) bad(`rev 必须是非负有限数，实际 ${JSON.stringify(doc.rev)}`)
  if (!Number.isFinite(doc.updatedAt)) bad(`updatedAt 必须是有限数，实际 ${JSON.stringify(doc.updatedAt)}`)
  if (!doc.nodes || typeof doc.nodes !== 'object' || Array.isArray(doc.nodes)) bad('nodes 必须是对象')
  if (!Array.isArray(doc.freeLinks)) bad('freeLinks 必须是数组')
  if (!Array.isArray(doc.hidden)) bad('hidden 必须是数组')
  if (doc.focusId !== null && typeof doc.focusId !== 'string') bad('focusId 必须是 string 或 null')

  if (errors.length) return { ok: false, errors }

  /** @type {Map<string, string>} */
  const seenRefs = new Map()

  for (const [key, node] of Object.entries(doc.nodes)) {
    const where = `nodes["${key}"]`
    if (!node || typeof node !== 'object') {
      bad(`${where} 不是对象`)
      continue
    }
    if (node.id !== key) bad(`${where}.id 与键不一致（${JSON.stringify(node.id)}）`)
    if (node.kind !== 'turn' && node.kind !== 'manual') bad(`${where}.kind 非法：${JSON.stringify(node.kind)}`)

    if (node.kind === 'turn') {
      if (!node.sourceRef) bad(`${where} 是 turn 但没有 sourceRef`)
      else if (!node.sourceRef.eventId) bad(`${where}.sourceRef.eventId 为空`)
      else if (node.sourceRef.kind !== 'user-message' && node.sourceRef.kind !== 'assistant-settlement') {
        bad(`${where}.sourceRef.kind 非法：${JSON.stringify(node.sourceRef.kind)}`)
      } else {
        const k = refKey(node.sourceRef)
        const prev = seenRefs.get(k)
        if (prev) bad(`sourceRef 重复：${k}（${prev} 与 ${where}）`)
        else seenRefs.set(k, where)
      }
    } else if (node.sourceRef) {
      bad(`${where} 是 manual 但带 sourceRef（规格禁止）`)
    }

    if (node.parentId !== null && node.parentId !== undefined) {
      if (typeof node.parentId !== 'string') bad(`${where}.parentId 必须是 string 或 null`)
      else if (!doc.nodes[node.parentId]) bad(`${where}.parentId 指向不存在的节点 ${node.parentId}`)
    }

    if (!node.position || !Number.isFinite(node.position.x) || !Number.isFinite(node.position.y)) {
      bad(`${where}.position 必须是 {x:number,y:number}`)
    }

    // 注解三态：允许 undefined / null / string，其它类型拒绝
    for (const field of ['title', 'body']) {
      const v = node[field]
      if (v !== undefined && v !== null && typeof v !== 'string') {
        bad(`${where}.${field} 必须是 string / null / undefined`)
      }
    }
  }

  // 防环：每个节点沿 parentId 向上走，看能否回到自己
  for (const id of Object.keys(doc.nodes)) {
    const guard = new Set([id])
    let cursor = doc.nodes[id]?.parentId ?? null
    while (cursor) {
      if (guard.has(cursor)) {
        bad(`parentId 成环：${id} → … → ${cursor}`)
        break
      }
      guard.add(cursor)
      cursor = doc.nodes[cursor]?.parentId ?? null
    }
  }

  const seenLinks = new Set()
  for (const link of doc.freeLinks) {
    if (!link || typeof link !== 'object') {
      bad('freeLinks 含非对象元素')
      continue
    }
    if (!doc.nodes[link.a]) bad(`freeLink ${link.id} 的端点 a=${link.a} 不存在`)
    if (!doc.nodes[link.b]) bad(`freeLink ${link.id} 的端点 b=${link.b} 不存在`)
    if (link.a === link.b) bad(`freeLink ${link.id} 自连`)
    const pair = [link.a, link.b].sort().join('|')
    if (seenLinks.has(pair)) bad(`freeLink 重复：${link.a} — ${link.b}`)
    else seenLinks.add(pair)
  }

  if (doc.focusId !== null && !doc.nodes[doc.focusId]) {
    bad(`focusId 指向不存在的节点 ${doc.focusId}`)
  }

  return { ok: errors.length === 0, errors }
}

/**
 * 规模上限（规格 §11：建议 nodes ≤ 5000、JSON ≤ 2MB）。
 * @param {OverlayDoc} doc
 * @param {number} [maxNodes]
 */
export function isWithinLimits(doc, maxNodes = 5000) {
  const count = doc?.nodes ? Object.keys(doc.nodes).length : 0
  if (count > maxNodes) return { ok: false, reason: `nodes ${count} 超过上限 ${maxNodes}` }
  const bytes = JSON.stringify(doc ?? null).length
  const MAX_BYTES = 2 * 1024 * 1024
  if (bytes > MAX_BYTES) return { ok: false, reason: `JSON ${bytes} 字节超过上限 ${MAX_BYTES}` }
  return { ok: true }
}
