/**
 * 发送前注入的**决策核心**（卡 5）—— 纯函数，零 import。
 *
 * 为什么把它从宿主事件处理器里抽出来：注入是这个产品最核心、也最"看不见"的一步
 * （用户看不到自己发出去的消息里多了什么）。如果它只存在于 `ctx.on('agent/pre-step', …)`
 * 的回调里，**唯一**能验证的办法就是真发一条消息（要花 token、还要人盯着）。
 *
 * 抽出来之后：给一个假的 `decision` + 假的 `payload` + 一份 overlay，就能把
 * 「注入了什么、插在哪个位置、什么时候不注入」全部验死 —— 不需要模型、不需要网络。
 *
 * 事件契约（`dsh-tool-cordis/lib/types/api-catalog.js` 的 `'agent/pre-step'`）：
 *   payload  = { agent, messages: UserMessage[], turn, step, signal }
 *   decision = { kind: 'reject' } | { kind: 'enter', messages: UserMessage[], startsRequestSeries?: true }
 *
 * 四条纪律（对应 `docs/01-产品与技术规格.md` §10.3/§10.4 与官方 practices）：
 *   1. 只有 `kind === 'enter'` 才动；`reject` 是别人的判断，原样放行；
 *   2. 返回**新数组**，绝不原地改写 `messages`；
 *   3. 没有焦点也没有粉线 → **什么都不注入**（绝不塞空消息）；
 *   4. 重试复用同一份快照（key = sessionId:turn:step），**不重新采样**。
 */

import {
  buildSendSnapshot,
  createPending,
  makeGraphContextMessage,
  rememberSnapshot,
  renderSendInjection,
  spliceInjectionAfterClaimed,
} from './links.js'

/** 注入结果的三态：不适用 / 无内容可注入 / 已注入。 */
export const INJECT_NA = 'not-applicable'
export const INJECT_EMPTY = 'empty'
export const INJECT_DONE = 'injected'

/**
 * 计算「这一轮该不该注入、注入什么」。
 *
 * @param {object} input
 * @param {any} input.decision           下游 listener 给出的决策（已被 `await next()` 拿到）
 * @param {any} input.payload            pre-step 的 payload
 * @param {import('./index.js').OverlayDoc | null | undefined} input.doc  该会话的权威 overlay
 * @param {{ ids: string[] }} [input.pending]  待注入的粉线集合
 * @param {Record<string, string>} [input.derivedTitles] 派生标题索引
 * @param {Map<string, object>} [input.snapshotStore] 重试复用用的快照表
 * @returns {{ status: string, decision: any, message?: object, meta?: object, reason?: string }}
 */
export function computeInjection(input) {
  const { decision, payload, doc } = input || {}

  // 1) 只处理 enter；reject 与缺失原样放行
  if (!decision || decision.kind !== 'enter') {
    return { status: INJECT_NA, decision, reason: 'decision-not-enter' }
  }
  // 2) 必须有权威文档 —— 没有图就没有可注入的东西
  if (!doc || !doc.nodes) {
    return { status: INJECT_NA, decision, reason: 'no-doc' }
  }

  const sessionId = doc.sessionId || (payload && payload.sessionId) || ''
  const turn = payload && payload.turn
  const step = payload && payload.step
  const snapshotKey = sessionId + ':' + String(turn) + ':' + String(step)

  // 3) 快照：已有则复用（官方重试走这条），没有就现在拍
  const pending = input.pending || createPending()
  const store = input.snapshotStore
  let snapshot
  if (store && store.get(snapshotKey)) {
    snapshot = store.get(snapshotKey) // **复用**，绝不重新采样
  } else {
    snapshot = buildSendSnapshot(doc, pending, snapshotKey)
    if (store) rememberSnapshot(store, snapshotKey, snapshot)
  }

  // 4) 渲染注入文本
  const rendered = renderSendInjection(doc, snapshot, {
    derivedTitles: input.derivedTitles || {},
  })

  // 5) 空就什么都不做 —— 绝不塞一条空消息进请求（那会污染上下文、白花 token）
  if (!rendered.text) {
    return { status: INJECT_EMPTY, decision, reason: 'nothing-to-inject', snapshot }
  }

  // 6) 造消息 + 插到「已接纳的用户消息」之后
  const message = makeGraphContextMessage(
    rendered.text,
    {
      sendNonce: snapshot.sendNonce,
      focusNodeId: rendered.focusNodeId,
      linkCount: rendered.linkCount,
    },
    input.uuid ? { uuid: input.uuid } : {},
  )
  const messages = spliceInjectionAfterClaimed(
    decision.messages,
    payload && payload.messages,
    message,
  )

  return {
    status: INJECT_DONE,
    decision: { ...decision, messages },
    message,
    snapshot,
    meta: {
      text: rendered.text,
      messageId: message.id,
      linkCount: rendered.linkCount,
      skippedLinks: rendered.skippedLinks,
      focusNodeId: rendered.focusNodeId,
      snapshotKey,
      // 插入位置：便于断言"确实插在已接纳消息之后"
      insertedAt: messages.indexOf(message),
      messageCount: messages.length,
    },
  }
}

// ───────────────────────────── 消费快照（规格 §10.3） ─────────────────────────────

/**
 * 该用户消息被 canonical 接受后，**消费**这一次注入用的快照。
 *
 * 语义（规格 §10.3 四条里最容易写错的一条）：
 *   · 只移出「快照里**仍存在**」的 id —— 快照之后用户又拉的新线不能被这一次消费掉；
 *   · **发送后、消费前删线** → 线已不在 pending 里，消费时自然什么都不做，
 *     但**注入已经发生了**（那是发送瞬间的意图，规格明写仍要注入）；
 *   · **发送前删线** → 根本没进快照，所以不会注入。
 *
 * @param {{ ids: string[] }} pending
 * @param {string[]} snapshotIds 该次注入用的快照里的 id 列表
 * @returns {{ ids: string[] }}
 */
export function consumeInjectedSnapshot(pending, snapshotIds) {
  const consumed = new Set(Array.isArray(snapshotIds) ? snapshotIds : [])
  if (consumed.size === 0) return pending
  return { ids: (pending.ids || []).filter((id) => !consumed.has(id)) }
}
