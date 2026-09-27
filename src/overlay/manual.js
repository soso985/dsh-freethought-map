/**
 * 手建节点（`kind: 'manual'`）—— 与「防环」共用的那层。
 *
 * 规格来源：`docs/01-产品与技术规格.md` §6.6（摘除唯一规则）、§6.3（防环）。
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * 为什么这个文件存在（而不是把这些函数留在 `undo.js` 里）：
 *
 * `opCreateManual` 原先在 `undo.js`，但它依赖 `canSetParentLoose`；
 * 而客户端 bundle **不能 import 相对模块**，所以要用它就得在客户端再抄一份。
 * 抄 `opCreateManual` 会**连带**要抄 `canSetParentLoose`，而后者要接
 * `setCanSetParent` 的注入机制 —— 抄三份接线 = 三处会分叉的地方。
 *
 * 所以把它们放进这个**零依赖的纯函数模块**（只 import `index.js` 里的 `canSetParent`）：
 * 宿主与客户端都直接把它**逐字复制**进各自的 bundle，需要抄的面从
 * 「函数 + 它的私有依赖 + 注入接线」缩到**一个函数**。
 * 防漂移仍由 `scripts/verify-host.mjs` 的逐字比对守着。
 * ═══════════════════════════════════════════════════════════════════════════
 */

import { canSetParent as canSetParentCanonical } from './index.js'

/** 手建节点 id 的前缀约定（`M` = manual；投影节点是 `T`）。 */
export const MANUAL_ID_PREFIX = 'M'

/**
 * 造一个手建节点的 id。
 *
 * 为什么不用纯随机：同一个会话里历史节点越多，纯随机的碰撞概率虽然仍极低，
 * 但一旦撞上，`{ ...doc.nodes, [id]: node }` 会**静默覆盖**掉一个已有节点。
 * 带上时间戳把碰撞面压到「同一毫秒内建两个」这一种，随机段再兜住它。
 *
 * @param {() => number} [now] 注入时钟，便于测试确定化
 * @param {() => string} [rand] 注入随机段
 */
export function newManualId(now = () => Date.now(), rand = defaultRand) {
  return MANUAL_ID_PREFIX + now().toString(36) + rand()
}

function defaultRand() {
  const c = typeof globalThis !== 'undefined' ? globalThis.crypto : undefined
  if (c && typeof c.getRandomValues === 'function') {
    const a = new Uint8Array(3)
    c.getRandomValues(a)
    return Array.from(a, (b) => b.toString(36).padStart(2, '0')).join('').slice(0, 4)
  }
  return Math.random().toString(36).slice(2, 6)
}

/**
 * `canSetParent` 的宽松版：允许 `parentId` 为 null/undefined（= 变成顶层），
 * 其余交给传进来的那份唯一实现 —— **不重复实现防环**。
 *
 * 为什么要"传进来"而不是直接 import：`undo.js` 用的是**注入**的 `canSetParent`
 * （延迟接线，避免 import 顺序问题），所以它需要同一个算法、不同的实现来源。
 * 让它把实现当参数传进来，环逻辑就**只有这一份**。
 *
 * @param {(doc: any, childId: string, parentId: string) => { ok: boolean, reason?: string }} canSetParent
 */
export function canSetParentLoose(canSetParent, doc, parentId, childId) {
  if (parentId === null || parentId === undefined) {
    return childId === undefined || doc.nodes[childId] ? { ok: true } : { ok: false, reason: 'missing-child' }
  }
  if (childId === undefined) {
    // 建节点时校验父是否存在（此时还没有子）
    return doc.nodes[parentId] ? { ok: true } : { ok: false, reason: 'missing-parent' }
  }
  return canSetParent(doc, childId, parentId)
}

/**
 * 新建一个**手建子节点**（父 = `input.parentId`）。
 *
 * 防环：建节点时只校验父是否存在（新节点还没有子，不可能成环）。
 * 真正会让环出现的是**改父**，那条路由 `opSetParent` + `canSetParent` 守着。
 *
 * ⚠️ 这是这个函数的**唯一实现**（原先在 `undo.js`，后来迁到这里）。
 * `undo.js` 重新导出它，所以两边不会分叉；客户端**逐字复制**它。
 *
 * 为什么它必须「零依赖、不遮蔽」：客户端那份副本跑在 bundle 的闭包里，
 * 里面也有一个同名的 `canSetParent` 函数。一旦函数体里出现
 * `const canSetParent = … || canSetParent`，就会触发 TDZ 报错
 * （真机上点「＋」毫无反应，只有 console 一条 `Cannot access 'canSetParent'
 * before initialization`）。所以默认值必须落在一个**不同名**的常量上。
 *
 * @param {import('./index.js').OverlayDoc} doc
 * @param {{ parentId?: string | null, position?: { x: number, y: number }, title?: string }} input
 * @param {{ newId?: () => string }} [deps] 注入 id 生成器，便于测试确定化
 */
export function opCreateManual(doc, input, deps = {}) {
  // ⚠️ 这里**不能**把默认值写成 `deps.canSetParent || canSetParent`：
  // 同一个作用域里 `const canSetParent` 会遮蔽外层那个函数，于是 `|| canSetParent`
  // 读到的是**还没初始化的自己** —— TDZ 报错 `Cannot access 'canSetParent' before initialization`。
  // 真机上就是这么炸的（点「＋」没有任何反应，只有 console 里一条异常）。
  // 用一个**不同名**的常量兜住，语义不变、也不会遮蔽任何东西。
  const canSetParentFn = deps.canSetParent || canSetParentCanonical
  const can = doc.nodes[input.parentId] === undefined && input.parentId !== null && input.parentId !== undefined
    ? { ok: false, reason: 'missing-parent' }
    : canSetParentLoose(canSetParentFn, doc, input.parentId)
  if (!can.ok) return { ok: false, reason: can.reason, doc }

  const newId = deps.newId || newManualId
  const id = newId()
  const node = {
    id,
    kind: 'manual',
    parentId: input.parentId ?? null,
    position: input.position ? { ...input.position } : { x: 40, y: 40 },
  }
  if (input.title !== undefined) node.title = input.title
  const next = { ...doc, nodes: { ...doc.nodes, [id]: node } }
  return { ok: true, doc: next, id, op: { type: 'create', id } }
}
