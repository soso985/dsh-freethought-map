/**
 * 用户结构操作与撤销栈（卡 7）—— 纯函数 + 可序列化的**操作日志**。
 *
 * 规格来源：`docs/01-产品与技术规格.md` §6.6（摘除唯一规则）、§7（投影与撤销）、§10.1（注解）、
 * `docs/02-实施计划.md` 卡 7。
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * 这个文件的存在是为了守住两条最容易写错的规则：
 *
 *   1. **只逆转用户操作，绝不碰投影**（规格 §7）。
 *      具体到「拖动期间到达的 AI 投影」：撤销拖动**只恢复位置**，不得删掉那个 AI 节点。
 *      所以历史里存的是**逆操作**，不是整份 doc 快照
 *      （规格明令禁止 v0.1 那种「beginEdit 整份 doc 快照含即将到来的投影」）。
 *
 *   2. **不变量：undo 绝不新建节点**（只删/改）。
 *      这条一破，撤销摘除就会真的复活一个节点，而它旁边的投影节点会变成孤儿。
 *      逆操作里的 `create` 因此被降级为 `restore`：节点还在就恢复字段，已被投影清理掉就跳过。
 *
 * 另外两条：历史**按 sessionId 隔离**（切会话换栈）、栈深 **50 步**。
 * 第一版历史只活在内存（刷新后可丢，overlay 以 Host 为准）—— 帮助里要写明。
 * ═══════════════════════════════════════════════════════════════════════════
 */

/** 用户历史栈深（规格 §7）。 */
export const HISTORY_DEPTH = 50

export const OP_CREATE = 'create'
export const OP_SET_PARENT = 'set-parent'
export const OP_DELETE = 'delete'
export const OP_ANNOTATE = 'annotate'
export const OP_GEOMETRY = 'geometry'
export const OP_LINK_ADD = 'link-add'
export const OP_LINK_REMOVE = 'link-remove'

// ───────────────────────────── 逆操作（历史里存的就是它） ─────────────────────────────

/**
 * 把一条用户操作压成**逆操作**。
 *
 * ⚠️ 关键设计：**「之前的值」必须由操作自己带着（`op.before`），不能在这里从 doc 现读。**
 * 因为调用时 `doc` 已经是**操作之后**的状态了 —— 现读会把新值当成旧值，
 * 于是「撤销拖动」会把节点挪到它拖动后的位置（本轮实测踩到，7 条断言一起红）。
 * 这是标准 operation-log 的做法：op 是自包含的，逆操作也自包含。
 *
 * 逆操作的种类刻意只有 `remove` / `unremove` / `set-field` / `link-remove` / `link-restore`
 * 五类 —— 都不是「新建节点」，所以「undo 绝不新建节点」这条不变量是**结构上成立**的。
 *
 * @param {{ doc: object, op: object }} input
 * @returns {object | null} 逆操作；null 表示这条操作不需要/不能撤销
 */
export function invertOp(input) {
  const { doc, op } = input || {}
  if (!doc || !op) return null

  // ⚠️ 这几个分支**不能**先要求"节点存在" —— 对 `remove` 来说节点**按定义**已经没了。
  //    本轮实测踩到：把存在性检查放在 switch 之前，导致 remove 的逆操作恒为 null，
  //    于是「撤销手建」之后再「重做」永远是空的（redo 栈根本没东西）。
  switch (op.type) {
    case 'remove':
      return {
        type: 'restore-node',
        id: op.id,
        node: op.node ? cloneNode(op.node) : null,
        links: (op.links || []).map(cloneLink),
        enabled: Boolean(op.node),
      }

    case 're-delete':
      // 撤销「重做摘除」需要节点字段快照；重做路径上没有存，所以显式不可撤销。
      // 明确拒绝一次「撤销重做」比悄悄做错好。
      return { type: 'unknown', id: op.id, enabled: false }

    case 'link-add':
      return { type: 'remove-link-added', id: op.id, link: cloneLink(op.link), enabled: true }

    default:
      break
  }

  switch (op.type) {
    case OP_CREATE: {
      // 节点快照优先取 op 自带的（redo 路径上它刚被删掉，doc 里已经没有），
      // 其次取当前 doc（正常"新建"路径）。
      const snapshot = op.node ? cloneNode(op.node) : doc.nodes[op.id] ? cloneNode(doc.nodes[op.id]) : null
      if (!snapshot) return null
      const links = op.links
        ? op.links.map(cloneLink)
        : doc.freeLinks.filter((l) => l.a === op.id || l.b === op.id).map(cloneLink)
      return {
        type: 'remove',
        id: op.id,
        // **带上节点快照**：撤销手建之后再重做，需要把字段原样写回来
        node: snapshot,
        // 删节点时要把它接过的粉线一起记账，撤销时才能恢复
        links,
        focusIdBefore: op.focusIdBefore,
        movedFocus: op.movedFocus === true,
      }
    }

    case OP_SET_PARENT:
      return {
        type: 'set-field',
        id: op.id,
        field: 'parentId',
        value: op.before === undefined ? null : op.before,
        enabled: true,
      }

    case OP_DELETE: {
      // 摘除：逆操作要把「被删节点的字段 + 被上提子节点的原父 + 被删的粉线 + hidden 项 + 焦点」
      // 全部记下来（规格 §7：「撤销日志须足够」）
      const hiddenRef = op.hiddenRef || null
      return {
        type: 'unremove',
        id: op.id,
        node: cloneNode(op.snapshot),
        // 摘除时被上提的直接子节点，撤销要放回原位
        liftedChildren: (op.liftedChildren || []).map((c) => ({ id: c.id, parentId: c.parentId })),
        links: (op.removedLinks || []).map(cloneLink),
        hiddenRef,
        // 重做（= 再删一次）时把 hidden 项加回去
        addHidden: hiddenRef,
        // 焦点原值：撤销要把焦点**原样**还回去（不是猜成父节点）
        focusIdBefore: op.focusIdBefore === undefined ? null : op.focusIdBefore,
      }
    }

    case OP_ANNOTATE:
      // ⚠️ 注解三态：`undefined`（字段不存在）与 `''`（用户清空）**语义不同**，
      //    所以撤逆操作必须带 `had` 标记，不能靠 `?? null` 抹平。
      return {
        type: 'set-field',
        id: op.id,
        field: 'title',
        value: op.before,
        had: op.hadBefore === true,
        enabled: true,
      }

    case OP_GEOMETRY:
      return {
        type: 'set-field',
        id: op.id,
        field: 'position',
        value: op.beforePosition ? { ...op.beforePosition } : null,
        size: op.beforeSize
          ? {
              width: op.beforeSize.width,
              height: op.beforeSize.height,
              hadW: op.beforeSize.hadW,
              hadH: op.beforeSize.hadH,
            }
          : null,
        enabled: true,
      }

    case OP_LINK_ADD:
      return {
        type: 'remove-link-added',
        id: op.id,
        link: cloneLink(op.link),
        enabled: true,
      }

    case OP_LINK_REMOVE:
      return { type: 'link-restore', link: cloneLink(op.link), enabled: true }

    default:
      return null
  }
}
/**
 * 把一条逆操作作用到**当前** doc 上（当前 doc 可能已含更新的投影）。
 *
 * 三条纪律：
 *   · **不新建节点** —— `unremove` 只在节点真的不存在时才写回，且写的是当时的快照；
 *     若节点已被投影清理掉，就只清 hidden，不复活它。
 *   · 目标节点已不存在 → 跳过（不报错、不半途改坏）。
 *   · 返回新 doc，不改原对象。
 *
 * @param {object} doc
 * @param {object} inv 逆操作
 * @returns {{ doc: object, applied: boolean, reason?: string }}
 */
export function applyInverse(doc, inv) {
  if (!doc || !inv) return { doc, applied: false, reason: 'no-input' }
  // `enabled === false` 表示这条逆操作**生来就无法撤销**（例如撤一条"撤销摘除"，
  // 那会违反「undo 不删节点」）。这类必须显式拒绝，不能靠"碰巧没做事"来蒙。
  if (inv.enabled === false) return { doc, applied: false, reason: 'not-undoable' }

  switch (inv.type) {
    case 'set-field': {
      const node = doc.nodes[inv.id]
      if (!node) return { doc, applied: false, reason: 'node-gone' }
      const next = { ...node }
      if (inv.field === 'title') {
        // 换回来之前，把**现值**记进逆操作：redo 要用它换回去（undo/redo 对称的关键）
        inv.next = Object.prototype.hasOwnProperty.call(node, 'title') ? node.title : undefined
        inv.nextHad = Object.prototype.hasOwnProperty.call(node, 'title')
        if (inv.had) next.title = inv.value
        else delete next.title // 原来是「没有字段」，恢复成没有字段
      } else if (inv.field === 'position') {
        inv.nextPosition = node.position ? { ...node.position } : null
        inv.nextSize =
          Object.prototype.hasOwnProperty.call(node, 'width') ||
          Object.prototype.hasOwnProperty.call(node, 'height')
            ? {
                width: node.width,
                height: node.height,
                hadW: Object.prototype.hasOwnProperty.call(node, 'width'),
                hadH: Object.prototype.hasOwnProperty.call(node, 'height'),
              }
            : null
        if (inv.value) next.position = { ...inv.value }
        if (inv.size) {
          if (inv.size.hadW) next.width = inv.size.width
          else delete next.width
          if (inv.size.hadH) next.height = inv.size.height
          else delete next.height
        }
      } else {
        inv.next = node[inv.field]
        next[inv.field] = inv.value
      }
      return { doc: { ...doc, nodes: { ...doc.nodes, [inv.id]: next } }, applied: true }
    }

    case 'remove': {
      const node = doc.nodes[inv.id]
      if (!node) return { doc, applied: false, reason: 'node-gone' }
      if (inv.opaque !== true && node.kind === 'turn') {
        // 投影节点不能靠撤销删掉（规格 §7：不能撤掉投影节点，要去掉用摘除）
        return { doc, applied: false, reason: 'turn-node' }
      }
      const nodes = { ...doc.nodes }
      delete nodes[inv.id]
      // 焦点只在"当时是我挪过去的"情况下回退，否则保留用户的焦点选择
      let focusId = doc.focusId
      if (focusId === inv.id && inv.movedFocus) {
        focusId = inv.focusIdBefore !== undefined ? inv.focusIdBefore : null
      }
      return {
        doc: {
          ...doc,
          nodes,
          freeLinks: doc.freeLinks.filter((l) => l.a !== inv.id && l.b !== inv.id),
          focusId,
        },
        applied: true,
      }
    }

    case 'restore-node': {
      // 撤销「撤销手建」= 重做手建。只在节点确实不在时才写回，**不改动已有节点**。
      if (doc.nodes[inv.id]) return { doc, applied: false, reason: 'already-there' }
      if (!inv.node) return { doc, applied: false, reason: 'no-snapshot' }
      const existing = new Set(doc.freeLinks.map((l) => l.id))
      const links = (inv.links || []).filter((l) => !existing.has(l.id)).map(cloneLink)
      return {
        doc: {
          ...doc,
          nodes: { ...doc.nodes, [inv.id]: cloneNode(inv.node) },
          freeLinks: [...doc.freeLinks, ...links],
        },
        applied: true,
      }
    }

    case 'unremove': {
      // 撤销摘除：恢复节点字段 + 放回被上提的子节点 + 恢复粉线 + 清掉 hidden + 焦点
      const nodes = { ...doc.nodes }
      if (!nodes[inv.id]) nodes[inv.id] = cloneNode(inv.node)
      for (const c of inv.liftedChildren) {
        if (nodes[c.id]) nodes[c.id] = { ...nodes[c.id], parentId: c.parentId }
      }
      const hidden = inv.hiddenRef
        ? doc.hidden.filter((h) => !(h.kind === inv.hiddenRef.kind && h.eventId === inv.hiddenRef.eventId))
        : [...doc.hidden]
      const existing = new Set(doc.freeLinks.map((l) => l.id))
      const restoredLinks = inv.links.filter((l) => !existing.has(l.id)).map(cloneLink)
      return {
        doc: {
          ...doc,
          nodes,
          freeLinks: [...doc.freeLinks, ...restoredLinks],
          hidden,
          // 焦点**原样**还回去（摘除时它可能被改成了父节点）
          focusId: inv.focusIdBefore === undefined ? doc.focusId : inv.focusIdBefore,
        },
        applied: true,
      }
    }

    case 're-delete': {
      // 重做「摘除」：再删一次，并重新写上 hidden
      const node = doc.nodes[inv.id]
      if (!node) return { doc, applied: false, reason: 'node-gone' }
      const parentId = node.parentId ?? null
      const children = Object.values(doc.nodes).filter((n) => n.parentId === inv.id)
      const nodes = { ...doc.nodes }
      delete nodes[inv.id]
      for (const c of children) nodes[c.id] = { ...nodes[c.id], parentId }
      const hidden = inv.addHidden && !isHiddenRef(doc.hidden, inv.addHidden)
        ? [...doc.hidden, { ...inv.addHidden }]
        : doc.hidden
      return {
        doc: {
          ...doc,
          nodes,
          freeLinks: doc.freeLinks.filter((l) => l.a !== inv.id && l.b !== inv.id),
          focusId: doc.focusId === inv.id ? parentId : doc.focusId,
          hidden,
        },
        applied: true,
      }
    }

    case 'remove-link-added': {
      const freeLinks = doc.freeLinks.filter((l) => l.id !== inv.id)
      return { doc: { ...doc, freeLinks }, applied: true }
    }

    case 'link-remove': {
      const before = doc.freeLinks.length
      const freeLinks = doc.freeLinks.filter((l) => l.id !== inv.id)
      return { doc: { ...doc, freeLinks }, applied: freeLinks.length !== before }
    }

    case 'link-restore': {
      if (!inv.link) return { doc, applied: false, reason: 'no-link' }
      if (doc.freeLinks.some((l) => l.id === inv.link.id)) {
        return { doc, applied: false, reason: 'already-there' }
      }
      return { doc: { ...doc, freeLinks: [...doc.freeLinks, cloneLink(inv.link)] }, applied: true }
    }

    default:
      return { doc, applied: false, reason: 'unknown-inverse:' + String(inv.type) }
  }
}

// ───────────────────────────── 历史栈（按会话隔离） ─────────────────────────────

/**
 * 一个会话的用户历史栈。**用户操作**才进这里；投影/补链/幽灵清理一律不进（规格 §7）。
 *
 * 为什么按会话隔离：规格明写「历史按 sessionId 隔离；切会话换栈」。
 * 所以这里是「一个会话一份」，由 `HistoryBySession` 负责分发。
 */
export class History {
  constructor(depth = HISTORY_DEPTH) {
    this.depth = depth
    /** @type {object[]} */
    this.undoStack = []
    /** @type {object[]} */
    this.redoStack = []
  }

  /** 记一条**用户操作**的逆操作。新操作会清空 redo 栈（常规撤销语义）。 */
  push(inverse) {
    if (!inverse) return
    this.undoStack.push(inverse)
    if (this.undoStack.length > this.depth) this.undoStack.shift()
    this.redoStack.length = 0
  }

  get canUndo() {
    return this.undoStack.length > 0
  }

  get canRedo() {
    return this.redoStack.length > 0
  }

  /**
   * 撤销一步。
   *
   * redo 用的逆操作**直接由刚应用的逆操作推导**（`redoInverseOf`），
   * 而不是"先翻译回 op、再拿操作后的 doc 重新算一遍" ——
   * 后者在 remove 这类"节点已消失"的情形下算不出东西：
   * 应用完 remove 之后 doc 里已经没有那个节点，重新算逆操作只会得到 null，
   * 于是 redo 栈永远是空的（本轮实测踩到）。
   *
   * @param {object} doc
   * @returns {{ doc: object, applied: boolean, reason?: string }}
   */
  undo(doc) {
    const inv = this.undoStack.pop()
    if (!inv) return { doc, applied: false, reason: 'empty' }
    const r = applyInverse(doc, inv)
    if (!r.applied) {
      // 目标已不在（例如投影把它清了），或这条逆操作生来不可撤销：
      // 这一步作废。**不放回栈**（否则会卡住整个撤销链）。
      return { doc: r.doc, applied: false, reason: r.reason }
    }
    const redoInv = redoInverseOf(inv)
    if (redoInv) this.redoStack.push(redoInv)
    return { doc: r.doc, applied: true }
  }

  /**
   * 重做一步。与 `undo` 对称：undo 用的逆操作也直接由刚应用的逆操作推导。
   * @param {object} doc
   */
  redo(doc) {
    const inv = this.redoStack.pop()
    if (!inv) return { doc, applied: false, reason: 'empty' }
    const r = applyInverse(doc, inv)
    if (!r.applied) return { doc: r.doc, applied: false, reason: r.reason }
    const undoInv = redoInverseOf(inv)
    if (undoInv) this.undoStack.push(undoInv)
    return { doc: r.doc, applied: true }
  }

  clear() {
    this.undoStack.length = 0
    this.redoStack.length = 0
  }

  get size() {
    return this.undoStack.length
  }
}

/**
 * 「一个会话一份历史」的分发器。切会话换栈，**不共享**。
 */
export class HistoryBySession {
  constructor(depth = HISTORY_DEPTH) {
    this.depth = depth
    /** @type {Map<string, History>} */
    this.bySession = new Map()
  }

  /** @param {string} sessionId */
  for(sessionId) {
    if (!sessionId) return new History(this.depth)
    let h = this.bySession.get(sessionId)
    if (!h) {
      h = new History(this.depth)
      this.bySession.set(sessionId, h)
    }
    return h
  }

  /**
   * 记一条用户操作。
   * @param {string} sessionId
   * @param {object} doc 操作**之后**的 doc
   * @param {object} op 操作描述
   */
  record(sessionId, doc, op) {
    const inv = invertOp({ doc, op })
    this.for(sessionId).push(inv)
    return inv
  }

  undo(sessionId, doc) {
    return this.for(sessionId).undo(doc)
  }

  redo(sessionId, doc) {
    return this.for(sessionId).redo(doc)
  }

  clear(sessionId) {
    if (sessionId === undefined) this.bySession.clear()
    else this.bySession.delete(sessionId)
  }
}

// ───────────────────────────── 用户操作（都在这里产 op 描述） ─────────────────────────────

/** 手建节点。`parentId` 走 `canSetParent` 校验。 */
export function opCreateManual(doc, input, deps = {}) {
  const can = doc.nodes[input.parentId] === undefined && input.parentId !== null && input.parentId !== undefined
    ? { ok: false, reason: 'missing-parent' }
    : canSetParentLoose(doc, input.parentId)
  if (!can.ok) return { ok: false, reason: can.reason, doc }

  const newId = deps.newId || (() => 'M' + Math.random().toString(36).slice(2, 10))
  const id = newId()
  const node = {
    id,
    kind: 'manual',
    parentId: input.parentId ?? null,
    position: input.position ? { ...input.position } : { x: 40, y: 40 },
  }
  if (input.title !== undefined) node.title = input.title
  const next = { ...doc, nodes: { ...doc.nodes, [id]: node } }
  return { ok: true, doc: next, id, op: { type: OP_CREATE, id } }
}

/** 手动改父（Tree 边）。成环/自指/缺节点一律拒绝，**不改动 doc**。 */
export function opSetParent(doc, childId, parentId) {
  const can = canSetParentLoose(doc, parentId, childId)
  if (!can.ok) return { ok: false, reason: can.reason, doc }
  const node = doc.nodes[childId]
  if ((node.parentId ?? null) === (parentId ?? null)) {
    return { ok: false, reason: 'no-change', doc }
  }
  const next = {
    ...doc,
    nodes: { ...doc.nodes, [childId]: { ...node, parentId: parentId ?? null } },
  }
  return {
    ok: true,
    doc: next,
    // before 由操作自己带着 —— 撤销才有旧值可用（见 invertOp 的注释）
    op: { type: OP_SET_PARENT, id: childId, parentId: parentId ?? null, before: node.parentId ?? null },
  }
}

/**
 * 摘除节点（规格 §6.6 唯一规则）。
 *
 * 产出 `op` 时把**撤销所需的一切**都记下来：被删节点快照、被上提子节点的原父、
 * 被删的粉线、hidden 项。撤销才能完全恢复。
 */
export function opDelete(doc, id) {
  const node = doc.nodes[id]
  if (!node) return { ok: false, reason: 'missing', doc }

  const parentId = node.parentId ?? null
  // 上提后是否成环？规格：「上提后若成环（不应发生）：拒绝此次删除并提示」
  const children = Object.values(doc.nodes).filter((n) => n.parentId === id)
  for (const c of children) {
    if (c.id === parentId) return { ok: false, reason: 'would-cycle', doc }
    // 沿新父链向上找，若撞到自己说明成环
    let cursor = parentId
    const guard = new Set()
    while (cursor && !guard.has(cursor)) {
      if (cursor === id) return { ok: false, reason: 'would-cycle', doc }
      guard.add(cursor)
      cursor = doc.nodes[cursor]?.parentId ?? null
    }
  }

  const nodes = { ...doc.nodes }
  delete nodes[id]
  for (const c of children) nodes[c.id] = { ...nodes[c.id], parentId }

  const removedLinks = doc.freeLinks.filter((l) => l.a === id || l.b === id)
  const hiddenRef = node.kind === 'turn' && node.sourceRef ? { ...node.sourceRef } : null

  const next = {
    ...doc,
    nodes,
    freeLinks: doc.freeLinks.filter((l) => l.a !== id && l.b !== id),
    focusId: doc.focusId === id ? parentId : doc.focusId,
    hidden: hiddenRef && !isHiddenRef(doc.hidden, hiddenRef) ? [...doc.hidden, hiddenRef] : doc.hidden,
  }

  return {
    ok: true,
    doc: next,
    op: {
      type: OP_DELETE,
      id,
      snapshot: cloneNode(node),
      liftedChildren: children.map((c) => ({ id: c.id, parentId: id })),
      removedLinks: removedLinks.map(cloneLink),
      hiddenRef,
      // 焦点原值：撤销要原样还回去
      focusIdBefore: doc.focusId,
    },
  }
}

/** 写注解。`""` 是**合法值**（用户主动清空），与「没有字段」语义不同。 */
export function opAnnotate(doc, id, title) {
  const node = doc.nodes[id]
  if (!node) return { ok: false, reason: 'missing', doc }
  if (title !== null && typeof title !== 'string') return { ok: false, reason: 'bad-title', doc }
  const hadBefore = Object.prototype.hasOwnProperty.call(node, 'title')
  const next = { ...node }
  if (title === null) delete next.title
  else next.title = title
  return {
    ok: true,
    doc: { ...doc, nodes: { ...doc.nodes, [id]: next } },
    // before/hadBefore 一起带上：撤销才能区分「本来是空串」与「本来没这个字段」
    op: { type: OP_ANNOTATE, id, title, before: hadBefore ? node.title : undefined, hadBefore },
  }
}

/** 改几何（拖动 / 缩放）。 */
export function opGeometry(doc, id, geometry) {
  const node = doc.nodes[id]
  if (!node) return { ok: false, reason: 'missing', doc }
  const beforePosition = node.position ? { ...node.position } : null
  const hadW = Object.prototype.hasOwnProperty.call(node, 'width')
  const hadH = Object.prototype.hasOwnProperty.call(node, 'height')
  const next = { ...node }
  if (geometry.position) next.position = { ...geometry.position }
  if (geometry.width !== undefined) next.width = geometry.width
  if (geometry.height !== undefined) next.height = geometry.height
  return {
    ok: true,
    doc: { ...doc, nodes: { ...doc.nodes, [id]: next } },
    op: {
      type: OP_GEOMETRY,
      id,
      // 拖动只记「被拖节点的 position 前后」，不存整份 doc 快照（规格 §7 明令）
      beforePosition,
      beforeSize: hadW || hadH ? { width: node.width, height: node.height, hadW, hadH } : null,
    },
  }
}

// ───────────────────────────── 小工具 ─────────────────────────────

/**
 * `canSetParent` 的宽松版：允许 `parentId` 为 null/undefined（= 变成顶层），
 * 其余交给 overlay 里那份唯一实现 —— **不重复实现防环**。
 */
function canSetParentLoose(doc, parentId, childId) {
  if (parentId === null || parentId === undefined) {
    return childId === undefined || doc.nodes[childId] ? { ok: true } : { ok: false, reason: 'missing-child' }
  }
  if (childId === undefined) {
    // 建节点时校验父是否存在（此时还没有子）
    return doc.nodes[parentId] ? { ok: true } : { ok: false, reason: 'missing-parent' }
  }
  return canSetParentShared(doc, childId, parentId)
}

/** 延迟引用 overlay 的 `canSetParent`，避免 import 顺序问题。 */
let canSetParentImpl = null
function canSetParentShared(doc, childId, parentId) {
  if (!canSetParentImpl) throw new Error('undo.js 还没收到 canSetParent 实现（应通过 setCanSetParent 注入）')
  return canSetParentImpl(doc, childId, parentId)
}

/**
 * 注入 overlay 里那份 `canSetParent`。
 *
 * 为什么用注入而不是 `import`：客户端 bundle 不能 import 相对模块，
 * 而这份代码要同时被宿主与客户端 bundle 使用。用一个 setter 让两侧各自接线，
 * 断言（`verify-undo.mjs`）会检查两侧都接上了、且接的是同一份实现。
 */
export function setCanSetParent(fn) {
  canSetParentImpl = fn
}

/**
 * 求出「撤销这条逆操作」的逆操作 —— 也就是 undo/redo 互为逆的那一环。
 *
 * 直接按类型配对，**不需要 doc**：每条逆操作自己带足了恢复所需的数据
 * （node 快照 / link / 前值）。这是把 undo/redo 做成对称的关键，
 * 也避免了"节点已消失就算不出逆操作"的死路。
 */
function redoInverseOf(inv) {
  switch (inv.type) {
    case 'remove':
      return {
        type: 'restore-node',
        id: inv.id,
        node: inv.node ? cloneNode(inv.node) : null,
        links: (inv.links || []).map(cloneLink),
        enabled: Boolean(inv.node),
      }
    case 'restore-node':
      return {
        type: 'remove',
        id: inv.id,
        node: inv.node ? cloneNode(inv.node) : null,
        links: (inv.links || []).map(cloneLink),
        focusIdBefore: inv.focusIdBefore,
        movedFocus: inv.movedFocus === true,
      }
    case 'unremove':
      return { type: 're-delete', id: inv.id, addHidden: inv.addHidden || null }
    case 're-delete':
      // 撤销"重做摘除"要节点字段快照，重做路径上没有存 → 明确不可撤销。
      return { type: 'unknown', id: inv.id, enabled: false }
    case 'remove-link-added':
      return { type: 'link-restore', link: cloneLink(inv.link), enabled: true }
    case 'link-restore':
      return { type: 'remove-link-added', id: inv.link && inv.link.id, link: cloneLink(inv.link), enabled: true }
    case 'link-remove':
      return { type: 'link-restore', link: cloneLink(inv.link), enabled: true }
    case 'set-field':
      // 前值 ↔ 现值互换由调用方在 set-field 上再做一次"记前值"完成；
      // 这里按字段回填 `before*`，所以再执行一次就是回到原状。
      if (inv.field === 'title') {
        return {
          type: 'set-field',
          id: inv.id,
          field: 'title',
          value: inv.next === undefined ? null : inv.next,
          had: inv.nextHad === true,
          enabled: true,
        }
      }
      if (inv.field === 'parentId') {
        return { type: 'set-field', id: inv.id, field: 'parentId', value: inv.next ?? null, enabled: true }
      }
      if (inv.field === 'position') {
        return {
          type: 'set-field',
          id: inv.id,
          field: 'position',
          value: inv.nextPosition ? { ...inv.nextPosition } : null,
          size: inv.nextSize || null,
          enabled: true,
        }
      }
      return { type: 'unknown', id: inv.id, enabled: false }
    default:
      return { type: 'unknown', id: inv.id, enabled: false }
  }
}

function isHiddenRef(hidden, ref) {
  return (hidden || []).some((h) => h.kind === ref.kind && h.eventId === ref.eventId)
}

function cloneNode(node) {
  return node === undefined || node === null ? node : JSON.parse(JSON.stringify(node))
}

function cloneLink(link) {
  return { ...link }
}

/**
 * 把一条逆操作翻译回「操作描述」，供 `undo` 之后再算一次逆操作压进 redo 栈。
 *
 * 每个分支都必须产出**语义等价于原操作**的 op，这样 redo 才会真的重做那件事。
 * 关键点：`unremove` → `re-delete`（不是 `delete` —— 那需要快照，而重做只需要"再删一次"）。
 */
function inverseToOp(inv) {
  switch (inv.type) {
    case 'remove':
      return { type: OP_CREATE, id: inv.id, node: inv.node ? cloneNode(inv.node) : null, links: (inv.links || []).map(cloneLink) }
    case 'unremove':
      return { type: 're-delete', id: inv.id, addHidden: inv.addHidden || null }
    case 'remove-link-added':
      return { type: OP_LINK_ADD, id: inv.id, link: inv.link }
    case 'link-restore':
      return { type: OP_LINK_REMOVE, id: inv.link && inv.link.id, link: inv.link }
    case 'restore-node':
      return { type: 'remove', id: inv.id, node: inv.node ? cloneNode(inv.node) : null, links: (inv.links || []).map(cloneLink) }
    case 're-delete':
      return { type: 'unknown', id: inv.id }
    case 'set-field':
      if (inv.field === 'title') {
        return {
          type: OP_ANNOTATE,
          id: inv.id,
          before: inv.value,
          hadBefore: inv.had === true,
        }
      }
      if (inv.field === 'parentId') return { type: OP_SET_PARENT, id: inv.id, before: inv.value }
      if (inv.field === 'position') {
        return {
          type: OP_GEOMETRY,
          id: inv.id,
          beforePosition: inv.value,
          beforeSize: inv.size || null,
        }
      }
      return { type: 'unknown', id: inv.id }
    default:
      return { type: 'unknown', id: inv.id }
  }
}
