/**
 * pre-step 钩子探针（临时诊断用，2026-09-27）。
 *
 * 目的只有一个：回答「宿主到底有没有调用 `agent/pre-step`」这个问题。
 *
 * 为什么需要它：注入的内容已经被 19 条离线断言验死了（`verify-inject.mjs`），
 * 但「钩子在真实请求上被调用了吗」只能在真机上确认。之前试图用 CDP 自动化
 * 在官方 composer 里打字来触发，失败了 —— 官方编辑器是 Lexical，
 * 自动化输入/提交做不对时是**静默失败**。改成：人手工发一句，钩子自己写日志。
 *
 * 三条设计约束：
 *   1. **每次调用都写**，不管成功、跳过还是抛错 —— 否则分不清"没被调用"和"被调用但没注入"。
 *   2. **写文件失败绝不影响对话** —— 探针是诊断，不是功能。全部包在 try/catch 里。
 *   3. **追加写**（`appendFileSync`），保留历史，便于对比多次发送。
 *
 * 日志格式：JSON Lines（一行一个 JSON 对象），便于 `Get-Content | ConvertFrom-Json` 直读。
 */

import { appendFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/** 探针日志的固定位置（刻意放临时目录：它是诊断产物，不该进仓库或用户数据目录）。 */
export const PROBE_FILE = join(tmpdir(), 'ftm-pre-step-probe.jsonl')

/** 我们注入的消息有哪些特征（用于识别「这一步里是不是已经有我们注入的那条」）。 */
export const INJECTION_SOURCE_KIND = 'freethought-map'
export const INJECTION_SOURCE_FORM = 'graph-context'

/**
 * 这条消息是不是我们自己注入的「用户图数据」。
 *
 * 判定按 `source.kind`/`source.form`，**不按文本前缀** —— 文本前缀会被用户原文里的
 * 巧合字符串污染，而 source 是我们自己写进去的结构化标记。
 */
export function isInjectedMessage(message) {
  const s = message && message.source
  return Boolean(s && s.kind === INJECTION_SOURCE_KIND && s.form === INJECTION_SOURCE_FORM)
}

/** 一批消息里有几条是我们的注入。 */
export function countInjected(messages) {
  if (!Array.isArray(messages)) return 0
  let n = 0
  for (const m of messages) if (isInjectedMessage(m)) n += 1
  return n
}

/**
 * 从 pre-step 的 payload + 我们最终给出的 decision，算出这条日志记录。
 *
 * 抽成纯函数是为了能离线断言（见 `verify-host.mjs`）——
 * 探针本身不参与产品逻辑，但它的字段形状会被断言锁住，避免以后改坏。
 *
 * @param {object} input
 * @param {any} input.payload   pre-step 的 payload（`{ agent, messages, turn, step, signal }`）
 * @param {any} input.originalDecision `await next()` 拿到的原始决策
 * @param {any} input.finalDecision    我们最终返回的决策
 * @param {string | null} [input.sessionId]
 * @param {string} [input.outcome]     我们这边的处置结果（injected / empty / not-applicable / error / skipped:*）
 * @param {object} [input.injection]   注入摘要（computeInjection 的 meta）
 * @param {number} [input.durationMs]
 * @param {string} [input.error]
 * @returns {object} 可 JSON 序列化的一条记录
 */
export function buildProbeEntry(input) {
  const p = (input && input.payload) || {}
  const od = input && input.originalDecision
  const fd = input && input.finalDecision

  const origMsgs = Array.isArray(p.messages) ? p.messages : []
  const origEnter = od && Array.isArray(od.messages) ? od.messages : null
  const finalEnter = fd && Array.isArray(fd.messages) ? fd.messages : null

  // 「我们是否改了 messages」—— 用长度与 id 序列判断，比对象引用更可靠
  const idsOf = (arr) => (Array.isArray(arr) ? arr.map((m) => (m && m.id) || '?') : null)
  const origIds = idsOf(origEnter)
  const finalIds = idsOf(finalEnter)
  const changed = JSON.stringify(origIds) !== JSON.stringify(finalIds)

  // ── 「这一步之前是否**已经**带着我们的注入」──────────────────────────────
  //
  // 为什么需要这一格（问题 B：同一 turn 的每个 step 都会注入，是重复还是必要？）：
  // 只看 `outcome=injected` 分不清两种情况：
  //   (a) 每个 step 都是全新的消息批次 → 每步注入是**必要**的（否则该步没有图上下文）
  //   (b) 上下文会累积 → 每步注入就是**重复**的（白花 token、还会让模型看到多份）
  // 这一格直接回答：**payload / 下游决策里已经存在的注入条数**。
  //   · `payloadInjected === 0` 且 `decisionInjected === 0` → 情况 (a)
  //   · 大于 0 → 情况 (b)，那就不该再注入
  const payloadInjected = countInjected(origMsgs)
  const decisionInjected = countInjected(origEnter)

  const inj = (input && input.injection) || null
  return {
    at: new Date().toISOString(),
    hook: 'agent/pre-step',
    sessionId: (input && input.sessionId) || null,
    turn: p.turn === undefined ? null : p.turn,
    step: p.step === undefined ? null : p.step,
    // 决策形状
    originalDecisionKind: od && od.kind ? String(od.kind) : null,
    finalDecisionKind: fd && fd.kind ? String(fd.kind) : null,
    // 是不是我们改的
    changedMessages: changed,
    messagesBefore: origIds ? origIds.length : null,
    messagesAfter: finalIds ? finalIds.length : null,
    payloadMessages: origMsgs.length,
    // **这一步进来之前**已有的注入条数（回答"每步都注入是否重复"）
    payloadInjected,
    decisionInjected,
    // 处置结果
    outcome: (input && input.outcome) || null,
    // 注入摘要（**不写全文**，只写够判断的摘要 + 前 120 字预览）
    injected:
      inj === null
        ? null
        : {
            messageId: inj.messageId || null,
            linkCount: inj.linkCount === undefined ? null : inj.linkCount,
            skippedLinks: inj.skippedLinks === undefined ? null : inj.skippedLinks,
            focusNodeId: inj.focusNodeId === undefined ? null : inj.focusNodeId,
            insertedAt: inj.insertedAt === undefined ? null : inj.insertedAt,
            textLength: inj.text ? String(inj.text).length : 0,
            textPreview: inj.text ? String(inj.text).slice(0, 120) : null,
          },
    durationMs: input && input.durationMs !== undefined ? input.durationMs : null,
    error: (input && input.error) || null,
  }
}

/**
 * 追加一条探针记录。**绝不抛错** —— 探针坏了也不能影响对话。
 *
 * @param {object} entry
 * @returns {{ ok: boolean, file: string, error?: string }}
 */
export function appendProbeEntry(entry) {
  try {
    appendFileSync(PROBE_FILE, JSON.stringify(entry) + '\n', 'utf8')
    return { ok: true, file: PROBE_FILE }
  } catch (e) {
    return { ok: false, file: PROBE_FILE, error: e && e.message ? e.message : String(e) }
  }
}
