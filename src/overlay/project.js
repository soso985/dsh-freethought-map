/**
 * 落链投影（卡 3）—— 纯函数：会话事件 → overlay 动作。
 *
 * 这一层**不 import 任何东西**（连 ctx 都不碰），所以可以用合成事件完整单测，
 * 不需要真的发消息、不烧 token。宿主侧只负责「订阅事件 → 调这里 → 写回权威」。
 *
 * 规格来源：`docs/01-产品与技术规格.md` §6.3–6.5、§7。
 * 宿主版本：dsh 0.1.7-rc.2 · commit c1275515（证据见 docs/HOST.md §3.3 / §3.11）
 *
 * ── 事件形状（从源码核对，不是猜的）────────────────────────────────────────
 * 信封：`{ type, seq, time, data, surfaceOp?, sourceEventSeqs? }`
 *   · `seq`      = 会话日志位置，**durable 事件的稳定标识**（信封没有 `id` 字段）
 *   · `surfaceOp`= 只有「能进模型可见面」的事件才有（`dsh-session/lib/index.js:167-174`）
 *   · `isAppendSurfaceEvent(event)` ⇔ `surfaceOp === 'append'`
 *     （替换副本 `surfaceOp: {op:'replace',…}` 也会发 `session/event`，**必须排除**，
 *       否则同一个结算会被消费两次）
 *
 * `user/message` 的 data：  `{ id, role:'user', content, source, … }` → id 在 `data.id`
 *   （官方 `dsh-client-ui-chat/lib/client.js:9200` 就是 `String(event.data.id)`）
 * `assistant/message` 的 data：`{ turn, step, message: { id, role:'assistant', content }, stream, usage?, interrupted? }`
 *   → id 在 `data.message.id`（同上 `:7557-7616` 一带）
 *
 * **`interrupted === true` 不算成功结算** —— 规格 §6.3 明令失败/中止不建节点。
 * 官方会话控制器也用同一条判据：`event.data.interrupted !== true`
 * （`dsh-api-session-controller/lib/types/…:148`）。
 */

/** 能进模型可见面、因而带 `surfaceOp` 的事件类型（`dsh-session/lib/index.js:154-160`）。 */
const SURFACE_EVENT_TYPES = new Set([
  'system/message',
  'developer/message',
  'user/message',
  'assistant/message',
  'tool/result',
])

/** 与官方 `isSurfaceEvent` 等价：类型在白名单里 **且** 带 surfaceOp 标记。 */
export function isSurfaceEvent(event) {
  if (!event || !SURFACE_EVENT_TYPES.has(event.type)) return false
  return event.surfaceOp !== undefined
}

/**
 * 与官方 `isAppendSurfaceEvent` 等价。
 * **落链只认它** —— 替换副本（surfaceOp 是对象）不是「新发生的事」，不能投影。
 */
export function isAppendSurfaceEvent(event) {
  return isSurfaceEvent(event) && event.surfaceOp === 'append'
}

/** 这个事件是不是「用户结算 / assistant 成功结算」二选一。 */
export function settlementKindOf(event) {
  if (!isAppendSurfaceEvent(event)) return null
  if (event.type === 'user/message') {
    // source.kind === 'user' 才算用户亲自说的；context/steering 等不算一条新结算
    const source = event.data && event.data.source
    if (source && typeof source === 'object' && source.kind && source.kind !== 'user') return null
    return 'user-message'
  }
  if (event.type === 'assistant/message') {
    if (event.data && event.data.interrupted === true) return null // 中止不算成功
    return 'assistant-settlement'
  }
  return null
}

/** 从事件里取出它的稳定 id。取不到就退回 `seq`（信封本身没有 id 字段）。 */
export function eventIdOf(event) {
  if (!event) return null
  const d = event.data
  if (d) {
    if (typeof d.id === 'string' && d.id) return d.id
    if (d.message && typeof d.message.id === 'string' && d.message.id) return d.message.id
  }
  if (Number.isInteger(event.seq)) return 'seq:' + String(event.seq)
  return null
}

/** 从事件里抽出纯文本（content 是块数组，取 text 块拼起来）。 */
export function textOf(event) {
  const d = (event && event.data) || {}
  const content = d.content !== undefined ? d.content : d.message && d.message.content
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  const parts = []
  for (const block of content) {
    if (!block || typeof block !== 'object') continue
    if (block.type === 'text' && typeof block.text === 'string') parts.push(block.text)
  }
  return parts.join('\n')
}

/**
 * 该事件对应的 sourceRef。取不到 id 就返回 null（调用方必须当成「不投影」）。
 * 规格 §6.2：`eventId` 与 `turnId` 禁止混用；一个投影节点只对应一种 SourceRef。
 */
export function sourceRefOf(event) {
  const kind = settlementKindOf(event)
  if (!kind) return null
  const eventId = eventIdOf(event)
  if (!eventId) return null
  return { kind, eventId }
}

// ───────────────────────────── 落链与焦点（规格 §6.4） ─────────────────────────────

/**
 * 为一个结算决定投影动作。
 *
 * 返回的动作是**数据**，不是副作用 —— 宿主负责 apply，测试负责断言。
 *
 * 焦点时序（规格 §6.4）是本函数的核心：
 *   · 用户结算  → `focusId = 新用户节点`（无条件，用户刚说完，焦点应该跟着走）
 *   · AI 成功结算 → **仅当 `focusId` 仍等于对应那条用户节点** 时才跟随；
 *                   用户等待期间点过别的节点就不抢焦点，AI 节点照样挂在那条用户节点下。
 *
 * 父节点：
 *   · 用户结算  → 有 `parentIdAtSend`（发送瞬间快照）就用它；否则退化为
 *                 「时间线上前一个未隐藏的 turn 节点」（**禁止**用此刻的 live focusId 兜底）
 *   · AI 结算   → 它对应的那条用户节点；找不到就用该 assistant 之前最近的 user 投影
 *
 * @param {import('./index.js').OverlayDoc} doc
 * @param {any} event
 * @param {{ parentIdAtSend?: string | null, prevTurnId?: string | null, userNodeIdForAssistant?: string | null }} [ctx]
 * @returns {{ action: 'append-turn', kind: string, ref: object, parentId: string | null, title: string, followFocus: boolean }
 *          | { action: 'noop', reason: string }}
 */
export function planProjection(doc, event, ctx = {}) {
  const kind = settlementKindOf(event)
  if (!kind) return { action: 'noop', reason: 'not-an-append-settlement' }

  const ref = sourceRefOf(event)
  if (!ref) return { action: 'noop', reason: 'no-source-ref' }

  // 去重：同 sourceRef 已有节点，或已被 hidden → no-op（重连重放不得新建）
  const key = ref.kind + ':' + ref.eventId
  for (const node of Object.values(doc.nodes)) {
    if (node.sourceRef && node.sourceRef.kind + ':' + node.sourceRef.eventId === key) {
      return { action: 'noop', reason: 'already-projected' }
    }
  }
  for (const h of doc.hidden) {
    if (h.kind + ':' + h.eventId === key) return { action: 'noop', reason: 'hidden' }
  }

  const title = deriveTitleFor(textOf(event))

  if (kind === 'user-message') {
    // 父节点：发送时快照优先；没有就用时间线前驱；**绝不用 live focusId**
    let parentId = null
    if (ctx.parentIdAtSend !== undefined && ctx.parentIdAtSend !== null) {
      parentId = doc.nodes[ctx.parentIdAtSend] ? ctx.parentIdAtSend : null
    } else if (ctx.prevTurnId && doc.nodes[ctx.prevTurnId]) {
      parentId = ctx.prevTurnId
    }
    return { action: 'append-turn', kind, ref, parentId, title, followFocus: true }
  }

  // assistant 结算：挂到对应的用户节点下
  let parentId = null
  if (ctx.userNodeIdForAssistant && doc.nodes[ctx.userNodeIdForAssistant]) {
    parentId = ctx.userNodeIdForAssistant
  } else if (ctx.prevTurnId && doc.nodes[ctx.prevTurnId]) {
    parentId = ctx.prevTurnId
  }
  // 抢焦点规则：只有当焦点**仍停在那条用户节点**上才跟随
  const followFocus = ctx.userNodeIdForAssistant !== undefined && doc.focusId === ctx.userNodeIdForAssistant

  return { action: 'append-turn', kind, ref, parentId, title, followFocus }
}

/**
 * 把动作应用到 doc 上，返回**新的 doc**（不改原对象）。
 *
 * 用 `newIdFor` 注入 id 生成器，便于测试确定化。
 *
 * @param {import('./index.js').OverlayDoc} doc
 * @param {any} plan
 * @param {{ newId?: () => string, position?: { x: number, y: number } }} [opts]
 */
export function applyProjection(doc, plan, opts = {}) {
  if (!plan || plan.action !== 'append-turn') return doc
  const newId = opts.newId || (() => 'n' + Math.random().toString(36).slice(2, 10))
  const id = newId()

  const parent = plan.parentId ? doc.nodes[plan.parentId] : null
  const position = opts.position || dropPositionFor(doc, parent)

  const node = {
    id,
    kind: 'turn',
    sourceRef: plan.ref,
    parentId: plan.parentId && doc.nodes[plan.parentId] ? plan.parentId : null,
    position,
    // ⚠️ 派生标题**只用于显示**，不写进 overlay（规格 §6.4）。
    //    这里把它作为「计算结果」返回，由调用方决定怎么用；节点本身不带 title 字段。
  }

  const next = {
    ...doc,
    nodes: { ...doc.nodes, [id]: node },
    focusId: plan.followFocus ? id : doc.focusId,
    updatedAt: doc.updatedAt,
  }
  return next
}

/** 新节点的落点：父节点正下方；没有父就放在原点附近（卡 7 之后交给布局）。 */
function dropPositionFor(doc, parent) {
  if (!parent) {
    const n = Object.keys(doc.nodes).length
    return { x: 40 + (n % 5) * 260, y: 40 + Math.floor(n / 5) * 130 }
  }
  const kids = Object.values(doc.nodes).filter((n) => n.parentId === parent.id)
  const h = parent.height || 84
  if (kids.length === 0) return { x: parent.position.x, y: parent.position.y + h + 40 }
  const rightMost = kids.reduce((a, b) => (a.position.x >= b.position.x ? a : b))
  return { x: rightMost.position.x + (rightMost.width || 220) + 40, y: rightMost.position.y }
}

/** 本地派生标题（与 overlay/index.js 的 deriveTitle 同规则；这里独立一份以免循环依赖）。 */
/**
 * 派生标题：原文首行 + 压空白 + 截断到 limit 字（超出加省略号）。
 *
 * 导出是为了让宿主在**持久化**派生标题时用同一份规则 ——
 * 早先只在 `SettlementLog.record` 里内联用过它；一旦要在别处再算一次，
 * 就必须共用这一个实现，否则截断规则会分叉。
 */
export function deriveTitleFor(text, limit = 24) {
  const firstLine = String(text || '')
    .split(/\r?\n/)[0]
    .replace(/\s+/g, ' ')
    .trim()
  return firstLine.length <= limit ? firstLine : firstLine.slice(0, limit) + '…'
}

// ───────────────────────────── 历史补链（规格 §6.5） ─────────────────────────────

/**
 * 按时间线**从旧到新**补链。
 *
 * 三條硬规则（规格 §6.5）：
 *   1. **禁止**用当前 live focusId 给历史节点当父；
 *   2. 已存在 sourceRef 的结算跳过（保留用户改过的 parentId / 位置 / 注解）；
 *   3. hidden 的跳过（否则摘除会被补链复活）。
 *
 * 补链是 session-sync，**不进用户撤销栈**（卡 7 的撤销栈只管用户操作）。
 *
 * @param {import('./index.js').OverlayDoc} doc
 * @param {any[]} events  已加载窗口内的事件，**调用方保证按 seq 升序**
 * @param {{ newId?: () => string }} [opts]
 * @returns {{ doc: object, appended: number, skipped: number }}
 */
export function backfill(doc, events, opts = {}) {
  let next = doc
  let appended = 0
  let skipped = 0
  let prevTurnId = null

  for (const event of events) {
    const kind = settlementKindOf(event)
    if (!kind) continue
    const plan = planProjection(next, event, {
      // 补链一律用「时间线前驱」，不给发送快照（历史里没有快照）
      prevTurnId,
      userNodeIdForAssistant: kind === 'assistant-settlement' ? prevTurnId : undefined,
      // 焦点规则在补链里不适用：followFocus 只对 assistant 生效，而这里 prevTurnId 不是焦点
    })
    if (plan.action !== 'append-turn') {
      skipped += 1
      // 即使跳过，也要让 prevTurnId 指向这条结算已存在的节点，后续补链才接得上
      const existing = findNodeByRef(next, plan.ref || sourceRefOf(event))
      if (existing) prevTurnId = existing.id
      continue
    }
    const before = next
    next = applyProjection(next, { ...plan, followFocus: false }, opts)
    // 新加的节点就是最后一个 key（applyProjection 用 spread 追加）
    const ids = Object.keys(next.nodes)
    const addedId = ids[ids.length - 1]
    if (next !== before && addedId && next.nodes[addedId] && next.nodes[addedId].sourceRef) {
      prevTurnId = addedId
      appended += 1
    } else {
      skipped += 1
    }
  }

  return { doc: next, appended, skipped }
}

function findNodeByRef(doc, ref) {
  if (!ref) return undefined
  const key = ref.kind + ':' + ref.eventId
  for (const node of Object.values(doc.nodes)) {
    if (node.sourceRef && node.sourceRef.kind + ':' + node.sourceRef.eventId === key) return node
  }
  return undefined
}

/**
 * 幽灵投影清理（规格 §6.3 最后两行）。
 *
 * 官方「重新生成且 **替换** 旧结算」时，旧 sourceRef 不再出现在 canonical 里，
 * 那个节点就成了指向幽灵事件的孤儿 —— 必须自动摘除（不能留给用户一个点不通的节点）。
 *
 * 摘除按 §6.6 的唯一规则：子节点上提、粉线删除、加进 hidden。
 *
 * @param {import('./index.js').OverlayDoc} doc
 * @param {Set<string>} liveRefKeys  canonical 里仍存在的 refKey 集合
 * @param {{ newId?: () => string }} [opts]
 * @returns {{ doc: object, removed: string[] }}
 */
export function pruneOrphanTurns(doc, liveRefKeys, opts = {}) {
  const orphans = []
  for (const node of Object.values(doc.nodes)) {
    if (node.kind !== 'turn' || !node.sourceRef) continue
    const key = node.sourceRef.kind + ':' + node.sourceRef.eventId
    if (!liveRefKeys.has(key)) orphans.push(node)
  }
  if (orphans.length === 0) return { doc, removed: [] }

  let next = doc
  const removed = []
  for (const node of orphans) {
    if (!next.nodes[node.id]) continue
    next = removeNodeInternal(next, node.id)
    removed.push(node.id)
  }
  void opts
  return { doc: next, removed }
}

/**
 * 摘除一个节点（规格 §6.6 唯一规则）。卡 7 的「摘除」按钮与幽灵清理共用它。
 *
 * - 所有子节点 `parentId ← X.parentId`（上提，可为顶层）
 * - 与 X 相连的粉线删除
 * - X 是 turn → 把它的 sourceRef 加进 `hidden`（补链才不会立刻建回来）
 * - X 是 focusId → `focusId ← X.parentId`
 * - X 在 selectedIds 里由调用方负责
 *
 * @param {import('./index.js').OverlayDoc} doc
 * @param {string} id
 */
export function removeNode(doc, id) {
  return removeNodeInternal(doc, id)
}

function removeNodeInternal(doc, id) {
  const target = doc.nodes[id]
  if (!target) return doc

  const nodes = {}
  for (const node of Object.values(doc.nodes)) {
    if (node.id === id) continue
    const parentId = node.parentId === id ? (target.parentId ?? null) : node.parentId
    nodes[node.id] = parentId === node.parentId ? node : { ...node, parentId }
  }

  const hidden = [...doc.hidden]
  if (target.kind === 'turn' && target.sourceRef) {
    const key = target.sourceRef.kind + ':' + target.sourceRef.eventId
    if (!hidden.some((h) => h.kind + ':' + h.eventId === key)) hidden.push(target.sourceRef)
  }

  return {
    ...doc,
    nodes,
    freeLinks: doc.freeLinks.filter((l) => l.a !== id && l.b !== id),
    focusId: doc.focusId === id ? (target.parentId ?? null) : doc.focusId,
    hidden,
  }
}

// ───────────────────────────── 会话事件队列（给验收脚本用） ─────────────────────────────

/**
 * 一个按会话记录「最近见过的结算事件」的小环形缓冲。
 *
 * 为什么需要：卡 3 的验收要能回答「宿主到底收到并投影了哪些事件」。
 * 光看 overlay 分不清「没收到事件」和「收到了但去了重」。
 * 有它就能把两侧对齐着看 —— 也给客户端一个可显示的诊断面。
 */
export class SettlementLog {
  constructor(limit = 200) {
    this.limit = limit
    /** @type {Map<string, Array<{ seq: number, type: string, eventId: string, at: number, outcome: string }>>} */
    this.bySession = new Map()
  }

  /**
   * @param {string} sessionId
   * @param {any} event
   * @param {string} outcome
   * @param {Record<string, any>} [extra] 额外诊断字段（注入日志用：text / messageId / linkCount…）
   */
  record(sessionId, event, outcome, extra) {
    if (!sessionId) return
    const list = this.bySession.get(sessionId) || []
    list.push({
      seq: Number.isInteger(event && event.seq) ? event.seq : -1,
      type: String((event && event.type) || '?'),
      eventId: String(eventIdOf(event) || '?'),
      at: Date.now(),
      outcome,
      // 派生标题一起记下来：它**不落盘**（规格 §6.4），但客户端显示时需要它。
      // 在宿主算一次，客户端就不用再实现一遍同样的截断规则。
      title: deriveTitleFor(textOf(event)),
      ...(extra && typeof extra === 'object' ? extra : {}),
    })
    if (list.length > this.limit) list.splice(0, list.length - this.limit)
    this.bySession.set(sessionId, list)
  }

  /** @param {string} sessionId @param {number} [sinceSeq] */
  list(sessionId, sinceSeq = -1) {
    const list = this.bySession.get(sessionId) || []
    return list.filter((e) => e.seq > sinceSeq)
  }

  clear(sessionId) {
    if (sessionId === undefined) this.bySession.clear()
    else this.bySession.delete(sessionId)
  }
}
