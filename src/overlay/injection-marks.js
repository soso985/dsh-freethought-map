/**
 * 识别「哪些消息是我们注入的」。
 *
 * 为什么需要它：`agent/pre-step` 每个 step 都会被调用，而我们需要知道
 * **这一步进来之前，消息批次里是不是已经带着我们上一步注入的那条**。
 * 这决定了「每个 step 都注入」到底是必要还是重复：
 *   · 两者皆为 0 → 每步都是全新批次 → 每步注入**必要**（否则该步没有图上下文）
 *   · 大于 0     → 上下文会累积 → 每步注入就是**重复**（白花 token）
 *
 * 真机结论（2026-09-27，见 docs/HOST.md §3.19）：实测 `payloadInjected = 0`
 * 且 `decisionInjected = 0` ⇒ 每个 step 都是全新批次 ⇒ **每步注入是必要的**。
 *
 * 判定为什么按 `source.kind`/`source.form` 而**不按文本前缀**：
 * 文本前缀会被用户原文里的巧合字符串污染（用户完全可能自己打出 `[用户图数据]`），
 * 而 `source` 是我们自己写进去的结构化标记，不会被冒充。
 */

/** 注入消息的 source 标记（写入端在 `inject.js`，这里只读取）。 */
export const INJECTION_SOURCE_KIND = 'freethought-map'
export const INJECTION_SOURCE_FORM = 'graph-context'

/**
 * 这条消息是不是我们自己注入的「用户图数据」。
 *
 * @param {any} message
 * @returns {boolean}
 */
export function isInjectedMessage(message) {
  const s = message && message.source
  return Boolean(s && s.kind === INJECTION_SOURCE_KIND && s.form === INJECTION_SOURCE_FORM)
}

/**
 * 一批消息里有几条是我们的注入。
 *
 * @param {any} messages
 * @returns {number}
 */
export function countInjected(messages) {
  if (!Array.isArray(messages)) return 0
  let n = 0
  for (const m of messages) if (isInjectedMessage(m)) n += 1
  return n
}

/**
 * 给一次 `agent/pre-step` 调用做记账：**这一步之前是否已经带着我们的注入**、
 * 以及我们最终是否改动了消息批次。
 *
 * 存在的意义：它把「每个 step 都注入是必要还是重复」这个判断从"看着日志猜"
 * 变成了一个**纯函数**（可离线验死、可回归）。判定依据是数据本身，不是文本前缀：
 *
 *   · `payloadInjected === 0 && decisionInjected === 0` ⇒ 本步是全新批次
 *     ⇒ **必须注入**（否则该步没有图上下文）
 *   · 任一大于 0 ⇒ 上下文里已经有我们的注入 ⇒ 再插就是重复
 *
 * 真机结论（2026-09-27）：实测两者皆为 0，所以现行「每步都注入」是对的。
 *
 * @param {{ payload?: any, originalDecision?: any, finalDecision?: any }} input
 * @returns {{
 *   turn: number | null, step: number | null,
 *   payloadInjected: number, decisionInjected: number,
 *   payloadMessages: number,
 *   messagesBefore: number | null, messagesAfter: number | null,
 *   changedMessages: boolean,
 *   needsInjection: boolean,
 * }}
 */
export function classifyPreStep(input) {
  const p = (input && input.payload) || {}
  const od = input && input.originalDecision
  const fd = input && input.finalDecision

  const origMsgs = Array.isArray(p.messages) ? p.messages : []
  const origEnter = od && Array.isArray(od.messages) ? od.messages : null
  const finalEnter = fd && Array.isArray(fd.messages) ? fd.messages : null

  const payloadInjected = countInjected(origMsgs)
  const decisionInjected = countInjected(origEnter)

  return {
    turn: p.turn === undefined ? null : p.turn,
    step: p.step === undefined ? null : p.step,
    payloadInjected,
    decisionInjected,
    payloadMessages: origMsgs.length,
    // 用 id 序列判「是否改动」，比对象引用可靠（下游可能重建了数组）
    messagesBefore: origEnter ? origEnter.length : null,
    messagesAfter: finalEnter ? finalEnter.length : null,
    changedMessages:
      (origEnter ? origEnter.map((m) => (m && m.id) || '?').join(',') : null) !==
      (finalEnter ? finalEnter.map((m) => (m && m.id) || '?').join(',') : null),
    // 本步是不是"干净的批次"（＝需要注入）
    needsInjection: payloadInjected === 0 && decisionInjected === 0,
  }
}
