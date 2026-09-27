/**
 * 粉线（自由联想）与「本轮新粉线」快照（卡 5）—— 纯函数。
 *
 * 规格来源：`docs/01-产品与技术规格.md` §10.3（本轮新粉线）、§10.4（短上下文与限额）。
 *
 * 三条最容易写错的规则，这里全部落成可单测的纯函数：
 *
 *   1. **拉线不触发模型**（红线 3）。粉线只是图的边，加入 `pendingLinkIds` 等下一次发送。
 *   2. **写操作决定「消费」的语义**：
 *        · 发送时**快照**当时的 `pendingLinkIds`
 *        · 该用户消息被 canonical 接受后，才把快照里**仍存在**的 id 从 pending 移除
 *        · **发送后、消费前删线** → 仍按快照注入（那是用户发送时的意图）
 *        · **发送前删线** → 不进快照，因此不注入
 *   3. **官方重试同一次发送要复用同一份快照** —— 不能重新采样（否则重试会注入不同的联想）。
 *
 * 注入文案统一带 `[用户图数据]` 前缀（规格 §10.4），让模型知道这是用户自己的图，不是它说的。
 */

/** 每次发送最多注入多少条联想（规格 §10.4 表）。 */
export const MAX_LINKS_PER_SEND = 20

/** 注入文案的统一前缀（规格 §10.4：均标记为用户图数据）。 */
export const USER_GRAPH_PREFIX = '[用户图数据]'

// ───────────────────────────── 粉线数据模型 ─────────────────────────────

/**
 * 建立一条粉线。拒绝自连与重复（无向去重）。
 *
 * 注意这与线 A 的实现同义：粉线**无方向语义**，`a`/`b` 顺序只用于存储。
 *
 * @param {import('./index.js').OverlayDoc} doc
 * @param {string} a
 * @param {string} b
 * @param {{ newId?: () => string }} [opts]
 * @returns {{ ok: true, doc: object, id: string } | { ok: false, reason: string, doc: object }}
 */
export function addFreeLink(doc, a, b, opts = {}) {
  if (!doc || !doc.nodes) return { ok: false, reason: 'no-doc', doc }
  if (a === b) return { ok: false, reason: 'self-link', doc }
  if (!doc.nodes[a] || !doc.nodes[b]) return { ok: false, reason: 'missing-endpoint', doc }
  const exists = doc.freeLinks.some((l) => (l.a === a && l.b === b) || (l.a === b && l.b === a))
  if (exists) return { ok: false, reason: 'duplicate', doc }

  const newId = opts.newId || (() => 'L' + Math.random().toString(36).slice(2, 10))
  const id = newId()
  return {
    ok: true,
    id,
    doc: { ...doc, freeLinks: [...doc.freeLinks, { id, a, b }] },
  }
}

/** 删一条粉线。返回新 doc（不改原对象）。 */
export function removeFreeLink(doc, linkId) {
  if (!doc || !doc.freeLinks) return doc
  return { ...doc, freeLinks: doc.freeLinks.filter((l) => l.id !== linkId) }
}

// ───────────────────────────── pendingLinkIds 生命周期 ─────────────────────────────

/** 建一个空的 pending 集合（按会话隔离，所以由调用方持有每个会话一份）。 */
export function createPending() {
  return { ids: [] }
}

/**
 * 拉线成功 → 加入 pending。
 * 已经在里面的不重复加（同一对节点第二次拉同一条线本来就是 duplicate）。
 */
export function pendingAdd(pending, linkId) {
  if (!linkId) return pending
  if (pending.ids.includes(linkId)) return pending
  return { ids: [...pending.ids, linkId] }
}

/**
 * 用户主动删线 → 从 pending 移出（若尚未消费）。
 *
 * ⚠️ 这一步只影响 **pending**，不影响已经拍下的快照 —— 发送后删线仍按快照注入（规格 §10.3）。
 */
export function pendingRemove(pending, linkId) {
  if (!pending.ids.includes(linkId)) return pending
  return { ids: pending.ids.filter((id) => id !== linkId) }
}

/**
 * 发送时**快照** pending → `pendingLinkIds`。
 *
 * @param {{ ids: string[] }} pending
 * @returns {string[]}
 */
export function snapshotPending(pending) {
  return Array.isArray(pending && pending.ids) ? [...pending.ids] : []
}

/**
 * 该用户消息被 canonical 接受后**消费**快照：
 * 只把「快照里仍存在」的 id 从 pending 移除。
 *
 * 为什么是"仍存在"：快照之后用户可能又拉了新线，那些**不能**被这一次消费掉。
 *
 * @param {{ ids: string[] }} pending
 * @param {string[]} snapshot
 */
export function consumePending(pending, snapshot) {
  const consumed = new Set(Array.isArray(snapshot) ? snapshot : [])
  if (consumed.size === 0) return pending
  return { ids: pending.ids.filter((id) => !consumed.has(id)) }
}

/**
 * 一次发送的完整快照。规格 §6.4 的三个字段。
 *
 * `parentIdAtSend` 与 `focusIdAtSend` 都是**发送瞬间**的值；
 * 父节点必须在发送时仍存在，否则记 null（= 新的顶层链）。
 *
 * @param {{ focusId: string | null, nodes: Record<string, any> }} doc
 * @param {{ ids: string[] }} pending
 * @param {string | number} sendNonce
 * @returns {{ sendNonce: string, parentIdAtSend: string | null, focusIdAtSend: string | null, newPinkLinksAtSend: string[] }}
 */
export function buildSendSnapshot(doc, pending, sendNonce) {
  const focusId = (doc && doc.focusId) || null
  const parentIdAtSend = focusId && doc.nodes && doc.nodes[focusId] ? focusId : null
  return {
    sendNonce: String(sendNonce),
    parentIdAtSend,
    focusIdAtSend: focusId,
    newPinkLinksAtSend: snapshotPending(pending),
  }
}

// ───────────────────────────── 注入文案（规格 §10.4） ─────────────────────────────

/**
 * 把快照里的粉线渲染成注入文本。
 *
 * 规则：
 *   · 统一带 `[用户图数据]` 前缀；
 *   · 端点必须**仍存在**（用户可能已经把节点删了）—— 指向幽灵节点的联想不注入；
 *   · 最多 `MAX_LINKS_PER_SEND` 条（规格 §10.4 的硬上限）；
 *   · 节点名用「注解优先、缺失才用派生标题」的三态规则。
 *
 * @param {import('./index.js').OverlayDoc} doc
 * @param {string[]} linkIds
 * @param {{ derivedTitles?: Record<string, string>, max?: number }} [opts]
 * @returns {{ text: string, used: Array<{ a: string, b: string }>, skipped: number }}
 */
export function renderLinkInjection(doc, linkIds, opts = {}) {
  const derived = opts.derivedTitles || {}
  const max = Number.isInteger(opts.max) ? opts.max : MAX_LINKS_PER_SEND
  const ids = Array.isArray(linkIds) ? linkIds : []

  const lines = []
  const used = []
  let skipped = 0

  for (const id of ids) {
    if (lines.length >= max) {
      skipped += 1
      continue
    }
    const link = (doc.freeLinks || []).find((l) => l.id === id)
    if (!link) {
      skipped += 1 // 线已被用户删掉（快照里有、图里没有）
      continue
    }
    const a = doc.nodes[link.a]
    const b = doc.nodes[link.b]
    if (!a || !b) {
      skipped += 1 // 端点节点已被删
      continue
    }
    const nameA = displayNameOf(a, derived)
    const nameB = displayNameOf(b, derived)
    lines.push(`用户将《${nameA}》与《${nameB}》建立自由联想`)
    used.push({ a: link.a, b: link.b })
  }

  if (lines.length === 0) return { text: '', used: [], skipped }
  return {
    text: [USER_GRAPH_PREFIX, ...lines].join('\n'),
    used,
    skipped,
  }
}

/**
 * 显示名三态（规格 §10.1）：注解非空用注解；注解是 `""` 用占位（**不回退派生**）；
 * 注解缺失才用派生标题。派生标题由宿主在投影时记的事件日志提供。
 */
export function displayNameOf(node, derivedTitles = {}) {
  const annotated = node && node.title
  if (annotated !== undefined && annotated !== null) {
    // 用户主动清空 → 显示占位，**不回退**派生标题
    return annotated === '' ? '（未命名）' : annotated
  }
  const d = derivedTitles[node && node.id]
  return d ? d : '（未命名）'
}

/**
 * 焦点摘要（规格 §10.4：焦点正文摘要上限 500 字）。
 *
 * @param {import('./index.js').OverlayDoc} doc
 * @param {{ derivedTitles?: Record<string, string>, limit?: number }} [opts]
 */
export function renderFocusInjection(doc, opts = {}) {
  const limit = Number.isInteger(opts.limit) ? opts.limit : 500
  const focusId = doc && doc.focusId
  if (!focusId) return { text: '', nodeId: null }
  const node = doc.nodes && doc.nodes[focusId]
  if (!node) return { text: '', nodeId: null }
  const name = displayNameOf(node, opts.derivedTitles || {})
  const body = typeof node.body === 'string' ? node.body : ''
  const clipped = body.length > limit ? body.slice(0, limit) : body
  const lines = [`当前焦点：《${name}》`]
  if (clipped) lines.push(clipped)
  return { text: [USER_GRAPH_PREFIX, ...lines].join('\n'), nodeId: focusId }
}

/**
 * 拼出本轮要注入的完整上下文（焦点摘要 + 粉线快照）。
 *
 * 两条都可能为空；都空就返回空串，调用方据此**不注入**（避免塞一条空消息进去）。
 *
 * @param {import('./index.js').OverlayDoc} doc
 * @param {{ newPinkLinksAtSend?: string[] }} snapshot
 * @param {{ derivedTitles?: Record<string, string> }} [opts]
 */
export function renderSendInjection(doc, snapshot, opts = {}) {
  const focus = renderFocusInjection(doc, opts)
  const links = renderLinkInjection(
    doc,
    (snapshot && snapshot.newPinkLinksAtSend) || [],
    opts,
  )
  const parts = [focus.text, links.text].filter(Boolean)
  return {
    text: parts.join('\n\n'),
    focusNodeId: focus.nodeId,
    linkCount: links.used.length,
    skippedLinks: links.skipped,
  }
}

// ───────────────────────────── 官方重试：复用同一份快照 ─────────────────────────────

/**
 * 按「发送」记录快照，供重试复用。
 *
 * 规格 §10.3：「官方重试同一发送：复用**同一次**快照，不重新采样。」
 * 所以 key 不能是"当前时间"，必须是能识别"同一次发送"的东西 —— 用户文本 + nonce。
 *
 * @param {Map<string, object>} store
 * @param {string} key
 * @param {object} snapshot
 */
export function rememberSnapshot(store, key, snapshot) {
  if (!store || !key) return snapshot
  const existing = store.get(key)
  if (existing) return existing // 同一次发送：**复用**，绝不重新采样
  store.set(key, snapshot)
  return snapshot
}

/** 一次发送被 canonical 接受后清掉它的快照（避免 map 无限长）。 */
export function forgetSnapshot(store, key) {
  if (store && key) store.delete(key)
}

// ───────────────────────────── 注入消息的构造（宿主侧用） ─────────────────────────────

/**
 * 按宿主 `createMessage` 的形状手写一条 user 消息。
 *
 * 为什么手写：`createUserMessage` 在 `@deepseek-ai/dsh-llm` 里，而宿主 runtime
 * **解析不到任何裸包名**（见 docs/HOST.md §3.9）。好在它的实现极其简单 ——
 * `dsh-llm/lib/index.js` 的 `createMessage` 就是：
 *
 * ```js
 * return deepFreeze(structuredClone({ ...input, id: brandString(randomUUID()) }))
 * ```
 *
 * 所以这里复制同一件事：克隆 → 补 id → 深冻结。`role: 'user'` 由调用方给。
 *
 * @param {{ content: unknown, source: unknown, role?: string }} input
 * @param {{ uuid?: () => string }} [deps] 注入 uuid 生成器，便于测试确定化
 * @returns {object} 冻结的消息
 */
export function makeInjectedUserMessage(input, deps = {}) {
  const uuid = deps.uuid || defaultUuid
  const message = structuredClone({ ...input, id: uuid() })
  return deepFreeze(message)
}

function defaultUuid() {
  // Node 18+ 有全局 crypto.randomUUID；没有就退化成一个够用的随机串
  const c = typeof globalThis !== 'undefined' ? globalThis.crypto : undefined
  if (c && typeof c.randomUUID === 'function') return c.randomUUID()
  return 'ftm-' + Math.random().toString(36).slice(2) + Date.now().toString(36)
}

function deepFreeze(value) {
  if (value === null || typeof value !== 'object') return value
  for (const key of Object.keys(value)) deepFreeze(value[key])
  return Object.freeze(value)
}

/**
 * 构造「用户图数据」注入消息（规格 §10.4：统一标 `[用户图数据]`）。
 *
 * 内容是**纯文本**（不携带图片/文件句柄），source 里带 enough 信息让宿主侧诊断
 * 一眼看出这条消息是本插件注入的、对应哪次发送。
 *
 * @param {string} text 已渲染好的注入文本（见 renderSendInjection）
 * @param {{ sendNonce?: string, focusNodeId?: string | null, linkCount?: number }} meta
 */
export function makeGraphContextMessage(text, meta = {}) {
  return makeInjectedUserMessage({
    role: 'user',
    content: [{ type: 'text', text }],
    source: {
      kind: 'freethought-map',
      form: 'graph-context',
      sendNonce: meta.sendNonce === undefined ? null : String(meta.sendNonce),
      focusNodeId: meta.focusNodeId === undefined ? null : meta.focusNodeId,
      linkCount: Number.isInteger(meta.linkCount) ? meta.linkCount : 0,
    },
  })
}

/**
 * 把注入消息插到「这一轮已接纳的用户消息」之后。
 *
 * 为什么插在那个位置而不是追加到末尾：官方 `dsh-agent-instructions` 就是这么做的
 * （`decision.messages.toSpliced(lastClaimedIndex + 1, 0, desired)`）——
 * 紧跟在用户原话后面，模型读起来是「用户说了 X，另外这些是用户的图数据」。
 *
 * @param {any[]} messages 下游决策里的消息
 * @param {any[]} originalMessages pre-step payload 里的原始消息（用来定位"已接纳"的那条）
 * @param {any} injected 要插入的消息
 * @returns {any[]} 新数组（不改原数组）
 */
export function spliceInjectionAfterClaimed(messages, originalMessages, injected) {
  const arr = Array.isArray(messages) ? messages : []
  const original = Array.isArray(originalMessages) ? originalMessages : []
  let lastIndex = -1
  for (let i = arr.length - 1; i >= 0; i -= 1) {
    if (original.includes(arr[i])) {
      lastIndex = i
      break
    }
  }
  const at = lastIndex < 0 ? arr.length : lastIndex + 1
  const out = [...arr]
  out.splice(at, 0, injected)
  return out
}
