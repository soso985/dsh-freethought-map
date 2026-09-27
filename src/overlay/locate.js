/**
 * 双向定位（卡 4）—— 纯函数 + **一处被隔离的脆弱 DOM 适配**。
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * 卡 1 探针已经把方向定死了（见 docs/HOST.md §2.2 / §2.3）：
 *
 *   「图 → 官方气泡」（滚动 + 高亮）：**宿主没有公开 API**。
 *     唯一可行路径是内部 DOM：`[data-chat-node-key]`。
 *   「官方气泡 → 图」（点击回传）：**宿主没有 inbound 回调**。
 *     唯一接管途径是 keyed slot 影子替换官方 renderer —— 那会连带接管官方渲染，
 *     违反红线「不 patch 官方 UI」，**明确不采用**。
 *
 * 所以卡 4 的落地形态是：
 *   ✅ 图 → 气泡：单向跳转（本文件的 locateBubble / scrollToBubble）
 *   ✅ 焦点与选中分离（规格 §5：selectedIds 与 focusId 分开存，点空白不清 focusId）
 *   ⬜ 气泡 → 图：**不做**。卡 1 已判定不可行并记录，不假装以后再修。
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * 脆弱点全部集中在 `bubbleSelectorCandidates()` 一个函数里，并且：
 *   · 只用**属性选择器**，不碰 CSS module 哈希类名（`fq8vsa_flowItem` 那种）；
 *   · 逐级降级：精确 key → 后缀匹配 → 放弃并**如实报告找不到**；
 *   · 找不到时返回 `{ ok:false, reason }`，由 UI 显式提示，绝不静默失败。
 *
 * 依赖的官方契约（从源码核对，非公开承诺）：
 *   `mergedNode.key` = `conversationContextKey(kind, id)` = `` `${kind.length}:${kind}${id}` ``
 *   —— `dsh-client-ui-conversation/lib/client.js` 的 `conversationContextKey`；
 *   渲染成 `data-chat-node-key={routedNode.key}`
 *   —— `dsh-client-ui-chat/lib/client.js`（`"data-chat-node-key": routedNode.key`）。
 *   其中 `kind` 是**官方 Definition 的 kind**（如 `input-message`），不是我们的 kind，
 *   所以精确 key 的构造依赖官方命名 —— 这也是为什么会话侧只做「逐级降级 + 如实报告」。
 */

/** 官方 user 气泡的 Definition kind（`dsh-client-ui-chat/lib/client.js` 的 messageDefinition.kind） */
const OFFICIAL_USER_KIND = 'input-message'

/**
 * 候选选择器，**按可靠性从高到低**。
 *
 * @param {{ sourceRef?: { kind: string, eventId: string } }} node
 * @returns {string[]}
 */
export function bubbleSelectorCandidates(node) {
  const ref = node && node.sourceRef
  if (!ref || !ref.eventId) return []
  const id = String(ref.eventId)
  // 属性值里的引号/反斜杠要转义，否则注入坏选择器
  const esc = id.replace(/["\\]/g, '\\$&')
  const out = []

  // 1) 精确 key（只有 user 结算能确定地构造出来：kind 已知 + id 就是 data.id）
  if (ref.kind === 'user-message') {
    out.push(`[data-chat-node-key="${OFFICIAL_USER_KIND.length}:${OFFICIAL_USER_KIND}${esc}"]`)
  }

  // 2) 后缀匹配：key 一定以该结算的 id 结尾 —— 不依赖官方 kind 名
  out.push(`[data-chat-node-key$="${esc}"]`)

  // 3) 退一步：任何 chat 标记里以该 id 结尾（涵盖 anchor/flow 两种属性）
  out.push(`[data-chat-anchor-key$="${esc}"]`)

  return out
}

/**
 * 找官方气泡元素。**这是全项目唯一直接读宿主内部 DOM 的地方。**
 *
 * 三级降级 + 唯一性检查：
 *   · 每级候选里如果命中**多个**，不盲选第一个 —— 报 `ambiguous`，
 *     因为选错气泡比找不到更糟（用户会被带到错的地方）。
 *
 * @param {Document | HTMLElement} root
 * @param {{ sourceRef?: object }} node
 * @returns {{ ok: true, el: Element, selector: string }
 *          | { ok: false, reason: 'no-source-ref' | 'not-found' | 'ambiguous', detail?: string }}
 */
export function locateBubble(root, node) {
  if (!node || !node.sourceRef || !node.sourceRef.eventId) {
    return { ok: false, reason: 'no-source-ref' }
  }
  if (!root || typeof root.querySelectorAll !== 'function') {
    return { ok: false, reason: 'not-found', detail: 'no-dom' }
  }
  const candidates = bubbleSelectorCandidates(node)
  if (candidates.length === 0) return { ok: false, reason: 'no-source-ref' }

  for (const selector of candidates) {
    let hits
    try {
      hits = root.querySelectorAll(selector)
    } catch (e) {
      continue // 选择器语法问题：跳过这一级，交给下一级
    }
    if (hits.length === 1) return { ok: true, el: hits[0], selector }
    if (hits.length > 1) {
      return { ok: false, reason: 'ambiguous', detail: selector + ' → ' + String(hits.length) }
    }
  }
  return { ok: false, reason: 'not-found' }
}

/**
 * 滚到该气泡并短暂高亮。
 *
 * 高亮用**内联样式 + 定时还原**，不注入样式表：
 * 这样不会污染宿主 DOM，也不会留下全局 class。
 *
 * @param {Document | HTMLElement} root
 * @param {{ sourceRef?: object }} node
 * @param {{ holdMs?: number }} [opts]
 * @returns {{ ok: boolean, reason?: string, detail?: string, selector?: string }}
 */
export function scrollToBubble(root, node, opts = {}) {
  const found = locateBubble(root, node)
  if (!found.ok) return found

  const el = found.el
  try {
    if (typeof el.scrollIntoView === 'function') {
      el.scrollIntoView({ block: 'center', behavior: 'smooth' })
    }
  } catch {
    /* 某些环境不支持 options 参数；滚动失败不算致命 */
  }

  // 高亮：记下原值，按时还原。宿主自己的 outline 不该被我们永久改掉。
  const holdMs = Number.isFinite(opts.holdMs) ? opts.holdMs : 1200
  let restore = null
  try {
    const prevOutline = el.style && el.style.outline
    const prevOffset = el.style && el.style.outlineOffset
    if (el.style) {
      el.style.outline = '2px solid var(--dsw-alias-brand, rgb(64, 128, 255))'
      el.style.outlineOffset = '2px'
      restore = () => {
        if (!el.style) return
        el.style.outline = prevOutline || ''
        el.style.outlineOffset = prevOffset || ''
      }
    }
  } catch {
    /* 不能改样式也不影响"滚过去了"这件事 */
  }
  if (restore) {
    const timer = typeof setTimeout === 'function' ? setTimeout : null
    if (timer) timer(restore, holdMs)
    else restore()
  }

  return { ok: true, selector: found.selector }
}

// ───────────────────────────── 焦点与选中（规格 §5） ─────────────────────────────

/**
 * 选中与焦点**必须分离**（规格 §5）：
 *   · `selectedIds` —— 画布高亮，可多选、可空；点空白清空
 *   · `focusId`     —— 下一句默认父节点；点空白**不清**
 *
 * 这条规则很容易被写成"点一下就同时设两个"，所以单独抽成纯函数并单测。
 *
 * @param {{ selectedIds?: string[], focusId?: string | null }} state
 * @param {{ type: 'click-node' | 'box-select' | 'click-blank' | 'new-projection', id?: string, ids?: string[] }} action
 * @returns {{ selectedIds: string[], focusId: string | null }}
 */
export function applySelection(state, action) {
  const prevSel = Array.isArray(state && state.selectedIds) ? state.selectedIds : []
  const prevFocus = state && state.focusId !== undefined ? state.focusId : null

  switch (action && action.type) {
    case 'click-node':
      // 单击：选中它**并**把焦点移过去（用户明确指向了这个节点）
      return { selectedIds: action.id ? [action.id] : [], focusId: action.id ?? null }

    case 'box-select':
      // 框选：只改 selectedIds，**不动** focusId
      return { selectedIds: [...new Set(action.ids || [])], focusId: prevFocus }

    case 'click-blank':
      // 点空白：取消选中，**但焦点保留**（规格 §5 明写）
      return { selectedIds: [], focusId: prevFocus }

    case 'new-projection':
      // 新投影落地：选中它；焦点是否跟随由落链规则决定，这里不擅自改
      return { selectedIds: action.id ? [action.id] : [], focusId: prevFocus }

    default:
      return { selectedIds: prevSel, focusId: prevFocus }
  }
}

/**
 * 新投影落地时该怎么处理视口（规格 §5）：
 * 「选中该节点，轻推视口，**不整图 fit**」。
 *
 * 返回的是**意图**，不是副作用 —— 由画布决定怎么实现（卡 7 有真画布之后接上去）。
 *
 * @param {{ x: number, y: number } | null | undefined} nodePosition
 * @param {{ x: number, y: number, zoom: number } | null | undefined} viewport
 * @param {{ x: number, y: number, width: number, height: number } | null | undefined} panelBox
 * @returns {{ kind: 'none' } | { kind: 'pan', dx: number, dy: number }}
 */
export function planReveal(nodePosition, viewport, panelBox) {
  if (!nodePosition || !viewport || !panelBox) return { kind: 'none' }
  // 节点在屏幕上的位置 = (节点坐标 + 视口平移) * 缩放
  const screenX = (nodePosition.x + viewport.x) * viewport.zoom
  const screenY = (nodePosition.y + viewport.y) * viewport.zoom
  const margin = 40
  let dx = 0
  let dy = 0
  if (screenX < panelBox.x + margin) dx = panelBox.x + margin - screenX
  else if (screenX > panelBox.x + panelBox.width - margin) {
    dx = panelBox.x + panelBox.width - margin - screenX
  }
  if (screenY < panelBox.y + margin) dy = panelBox.y + margin - screenY
  else if (screenY > panelBox.y + panelBox.height - margin) {
    dy = panelBox.y + panelBox.height - margin - screenY
  }
  if (dx === 0 && dy === 0) return { kind: 'none' } // 已经在视野里，别乱动
  return { kind: 'pan', dx: Math.round(dx), dy: Math.round(dy) }
}

// ───────────────────────────── 链的呈现模型（纯函数，便于单测） ─────────────────────────────

/**
 * 把 overlay 的节点整理成「链」的显示列表。
 *
 * 显示标题的三态（规格 §10.1）：
 *   · 有注解 → 用注解
 *   · 注解是 `""` → 显示空（**不回退**派生标题）
 *   · 注解缺失 → 用 `derivedTitles` 里记的派生标题（那不在 overlay 里，是运行期算的）
 *
 * @param {import('./index.js').OverlayDoc} doc
 * @param {{ derivedTitles?: Record<string, string> }} [opts]
 * @returns {Array<{ id, kind, depth, sourceRef, title, hasAnnotation, isFocus, seq }>}
 */
export function buildChainView(doc, opts = {}) {
  if (!doc || !doc.nodes) return []
  const derived = opts.derivedTitles || {}
  const kids = new Map()
  for (const node of Object.values(doc.nodes)) {
    const list = kids.get(node.parentId) || []
    list.push(node.id)
    kids.set(node.parentId, list)
  }
  // 顶层：无父，或父已不存在
  const roots = Object.values(doc.nodes)
    .filter((n) => !n.parentId || !doc.nodes[n.parentId])
    .map((n) => n.id)

  const out = []
  const seen = new Set()
  const walk = (id, depth) => {
    if (seen.has(id)) return
    seen.add(id)
    const node = doc.nodes[id]
    if (!node) return
    const annotated = node.title
    let title
    if (annotated === undefined || annotated === null) title = derived[id] || ''
    else title = annotated // 含 "" —— 用户主动清空，不回退
    out.push({
      id,
      kind: node.kind,
      depth,
      sourceRef: node.sourceRef || null,
      title,
      hasAnnotation: annotated !== undefined && annotated !== null,
      isFocus: doc.focusId === id,
      seq: Number(node.seq) || 0,
    })
    for (const c of kids.get(id) || []) walk(c, depth + 1)
  }
  // 链的阅读顺序 = 按投影时间（seq）排；同 seq 用 id 稳定排序
  roots.sort((a, b) => (doc.nodes[a].seq || 0) - (doc.nodes[b].seq || 0) || (a < b ? -1 : 1))
  for (const r of roots) walk(r, 0)
  // 孤岛（父存在但自己在环里）也要列出来，别丢节点
  for (const id of Object.keys(doc.nodes)) walk(id, 0)
  return out
}
