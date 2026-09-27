/**
 * dsh-freethought-map · 客户端一半（Client half）· 卡 1 探针壳
 *
 * 这一版**不是产品 UI**，是探针外壳。它做五件事：
 *   1. 证明客户端模块被宿主加载 —— 注册进宿主**官方右侧停靠列**的一个 tab 类型；
 *   2. 证明左右布局可收展 —— 用 `push` 呈现形态挤压会话列（宿主原生行为，不自己写 CSS 布局）；
 *   3. 证明 Root / 样式 / 快捷键隔离 —— 全部选择器与监听限定在本插件的根节点内；
 *   4. 证明收展与宽度可持久化（卡 2 再迁到 Host 权威存储）；
 *   5. 把宿主真实暴露的 slot 名单打到面板上，供 docs/HOST.md 的探针表逐条取证。
 *
 * 宿主版本：dsh 0.1.7-rc.2 · commit c1275515b6b97551ec358c926c479ab750c687c0
 *
 * 为什么是「右侧停靠列」而不是自己开一列（实测结论，见 docs/HOST.md §2.1）：
 *   宿主的三栏 AppFrame 由**一次** root 注册声明 5 个子 slot（sidebar / main / rightbar /
 *   shell.overlay / shell.leading）。其中 sidebar、rightbar 是 single 且已被官方包占用，
 *   注册进去是**替换**官方 UI 而不是并列（replaceRisk = shadows-shipped-ui）。
 *   官方唯一「可以附加、且自带空间」的席位就是右列的 tab 位 `sidebar.right.pane.tab`。
 *
 * 纪律（来自宿主官方 skill `cordis-plugin-development`）：
 *   - 不 import 任何 @deepseek-ai/dsh-client-* 包；React 从浏览器模块表取。
 *   - 不替换 app root，不往 document.body 追加节点。
 *   - factory 内不做副作用；注册与监听都放 apply(ctx) 内并用 ctx.effect 归还清理。
 *   - 只用 --dsw-alias-* 主题 token 上色；取不到就退回继承色，保证不白屏。
 */

const PLUGIN_ID = 'dsh-freethought-map'
const TAB_KIND = 'freethoughtmap'
const TAB_ADDRESS = 'freethoughtmap://session'
const ROOT_ATTR = 'data-freethought-map-root'

/**
 * 帮助短文 —— 由 `src/overlay/io.js` 的 `helpText()` **编译**过来（`scripts/build-help.mjs`）。
 *
 * 为什么是编译而不是运行期取：客户端 bundle 是单文件自包含的惰性 CJS 注册，
 * **不能 import 相对模块**（官方 README 明令）。所以这里放一份逐字副本，
 * 并由 `verify-io.mjs` 的断言锁住它与 `helpText()` 完全一致 ——
 * 改了一边不改另一边会直接红。
 */
const HELP_TEXT = `这块面板是会话思路图，不是聊天窗口 —— 说话还是在官方输入框里。

## 图是怎么长出来的
每完成一轮（你发一句、模型答完），图里就多两个节点。它们按时间连成一条链。

## 你能做的
· 点一行：把焦点移过去（下一句默认挂在它下面）
· 「跳到气泡」：回到官方对话里对应的那一条
· 手建节点、拖动、改父、写注解、摘除 —— 这些操作都可以 Ctrl+Z 撤销

## 图会被怎样使用
发送前会把**当前焦点**和**这一轮新拉的自由联想**以「[用户图数据]」的形式附在消息后面。
模型只能读图，不能改图 —— 结构永远是你说了算。

## 几点要知道的
· **刷新后不能 Ctrl+Z 跨刷新**：撤销历史只活在内存里；图本身存在本地，不会丢。
· 撤销历史**按会话分开**，切换会话会换一套历史。
· 「摘除」不是删除对话 —— 对话还在，图里不再显示它，也不会被自动补链建回来。
· 帮助里出现「禁止一键生成思维导图」是说明：这个产品**刻意不做**自动成树，
  结构必须由你自己长出来或手建。`
const WIDTH_KEY = 'freethought-map:panel-width:v1'
const COLLAPSED_KEY = 'freethought-map:panel-collapsed:v1'

// 面板宽度的钳制范围。这份常量与 src/overlay/index.js 的 PANEL_WIDTH_* 保持一致，
// 但**不 import** 它 —— 客户端 bundle 是单文件自包含的惰性 CJS 注册，
// 不能同步 require 另一个相对模块（官方 README 明令）。两侧一致性由 verify-client.mjs 盯住。
const PANEL_WIDTH_DEFAULT = 420
const PANEL_WIDTH_MIN = 264
const PANEL_WIDTH_MAX = 900

const DSH_VERSION = '0.1.7-rc.2'
const DSH_COMMIT = 'c1275515'

/**
 * 宿主 Remote 描述符 —— 必须与 `src/host/storage.js` 的 `buildRemoteContribution()`
 * 逐字段一致（端点名、参数名/wire 名、codec 形状）。
 *
 * 两边各写一份是**故意的**：客户端一半不能 import 宿主代码，宿主一半也不能 import 客户端代码。
 * 一致性由 `scripts/verify-host.mjs` 盯住 —— 它会同时载入两侧并做深度比对。
 *
 * `parameters` 的 name/wire 必须等于宿主方法的形参名：网关用 `Function.prototype.toString`
 * 解析参数名当 wire 字段名，改名即断契约。
 */
const REMOTE_SERVICE = 'freethoughtMap'
const REMOTE_PACKAGE = 'dsh-freethought-map'

/** 恒等 codec：真正的校验在宿主侧 applySave / validateOverlay；这里只满足 strict 入参要求。 */
function identityCodec() {
  return { parse: (v) => v }
}

function remoteParam(name) {
  return {
    name,
    wire: name,
    source: 'json',
    codec: { mode: 'strict', typeSymbol: REMOTE_PACKAGE + '#' + name, create: identityCodec },
  }
}

function buildRemoteContribution() {
  const mk = (method, parameters) => ({
    id: REMOTE_PACKAGE + '#' + REMOTE_SERVICE + '/' + method,
    service: REMOTE_SERVICE,
    namespace: REMOTE_SERVICE,
    method,
    invocation: { kind: 'direct' },
    parameters,
    result: { mode: 'src-json' },
  })
  return {
    package: REMOTE_PACKAGE,
    descriptors: [
      mk('load', [remoteParam('sessionId')]),
      mk('save', [remoteParam('sessionId'), remoteParam('doc'), remoteParam('baseRev')]),
      mk('describe', []),
      mk('events', [remoteParam('sessionId'), remoteParam('sinceSeq')]),
      mk('setPendingLinks', [remoteParam('sessionId'), remoteParam('payload')]),
      mk('injections', [remoteParam('sessionId'), remoteParam('sinceSeq')]),
      mk('exportDoc', [remoteParam('sessionId'), remoteParam('kind')]),
      mk('importDoc', [remoteParam('sessionId'), remoteParam('json')]),
      mk('rebuild', [remoteParam('sessionId'), remoteParam('events')]),
    ],
  }
}

/**
 * 「首次出现时自动打开本插件的 tab」的一次性开关。
 * 存成 localStorage 标记：用户关掉这次打开的 tab 之后，刷新不会再强行弹回来。
 */
const AUTOPEN_KEY = 'freethought-map:autopen-done:v1'

function clampWidth(value) {
  const n = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(n)) return PANEL_WIDTH_DEFAULT
  return Math.min(PANEL_WIDTH_MAX, Math.max(PANEL_WIDTH_MIN, Math.round(n)))
}

/**
 * 读出「当前已加载窗口」的会话事件，供「重建投影」用。
 *
 * ⚠️ 老实说：**官方没有公开的"已加载窗口"读取接口**。卡 1 的 P2 探针已经证明了这一点
 * （会话内容只能通过内部 DOM 拿到，没有公开 API）。所以这里返回 `null`，
 * 由 UI 如实说明「重建已跳过，没有假装成功」。
 *
 * 为什么不放一个"以后补上"的桩：那会让 UI 在**看起来成功**的情况下什么都不做，
 * 而你会以为图已经重建过了。明确说"做不到"比假装做到有用得多。
 *
 * 一旦宿主暴露了合规的读取途径，只需在这里返回按 `seq` 升序的
 * `Array<{type, seq, data, surfaceOp}>` —— 重建链路的其余部分都已就绪且有 39 条断言守着。
 */
function collectWindowEvents(_ctx, _sessionId) {
  return null
}

function createPlugin(React) {
  const h = React.createElement
  const { useCallback, useEffect, useRef, useState } = React

  // ═══════════════════════════════════════════════════════════════════════════
  // 下面两个函数是 `src/overlay/locate.js` 里同名函数的**逐字副本**。
  //
  // 为什么复制而不是 import：客户端 bundle 是单文件自包含的惰性 CJS 注册，
  // **不能同步 require 另一个相对模块**（官方 README 明令）。
  //
  // 防漂移：`scripts/verify-host.mjs` 会把两份源码里的函数体抽出来逐字比对，
  // 不一致直接 FAIL。所以复制是安全的 —— 它不会悄悄分叉。
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * 官方 user 气泡的 Definition kind（`dsh-client-ui-chat` 的 `messageDefinition.kind`）。
   * 只有 user 结算能确定地构造出精确 key；assistant 的 kind 我们不去猜。
   */
  const OFFICIAL_USER_KIND = 'input-message'

  /** 候选选择器，按可靠性从高到低（副本，见上）。 */
  function bubbleSelectorCandidates(node) {
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
   * 找官方气泡 —— **全项目唯一直接读宿主内部 DOM 的地方**（副本，见上）。
   * 命中多个报 ambiguous，绝不盲选；找不到如实报 not-found。
   */
  function locateBubble(root, node) {
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

  /** 滚到气泡 + 临时高亮（内联样式，不注入样式表、不留全局 class）。 */
  function scrollToBubble(root, node, opts) {
    const found = locateBubble(root, node)
    if (!found.ok) return found
    const el = found.el
    try {
      if (typeof el.scrollIntoView === 'function') {
        el.scrollIntoView({ block: 'center', behavior: 'smooth' })
      }
    } catch {
      /* 不支持 options 参数也不致命 */
    }
    const holdMs = opts && Number.isFinite(opts.holdMs) ? opts.holdMs : 1200
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
      /* 改不了样式不影响"滚过去了" */
    }
    if (restore) {
      const timer = typeof setTimeout === 'function' ? setTimeout : null
      if (timer) timer(restore, holdMs)
      else restore()
    }
    return { ok: true, selector: found.selector }
  }

  /** 链的显示模型（副本，见上；注解三态在这里落地）。 */
  function buildChainView(doc, opts = {}) {
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

  // ───────────────────────────── 样式（局部，不污染宿主） ─────────────────────────────
  // 根节点前缀 + CSS 变量；绝不写 html / body / :root。颜色全部走 --dsw-alias-* token。
  const CSS = `
[${ROOT_ATTR}] {
  display: flex;
  flex-direction: column;
  height: 100%;
  min-width: 0;
  box-sizing: border-box;
  color: inherit;
  background: transparent;
}
[${ROOT_ATTR}] * { box-sizing: border-box; }
[${ROOT_ATTR}] .ftm-bar {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 6px 8px;
  border-bottom: 1px solid var(--dsw-alias-border-1, rgba(128, 128, 128, 0.25));
  flex: 0 0 auto;
}
[${ROOT_ATTR}] .ftm-title { font-weight: 600; margin-right: auto; }
[${ROOT_ATTR}] .ftm-btn {
  font: inherit;
  padding: 2px 8px;
  border-radius: 6px;
  border: 1px solid var(--dsw-alias-border-1, rgba(128, 128, 128, 0.35));
  background: transparent;
  color: inherit;
  cursor: pointer;
}
[${ROOT_ATTR}] .ftm-btn:hover { background: var(--dsw-alias-bg-hover, rgba(128, 128, 128, 0.12)); }
[${ROOT_ATTR}] .ftm-body { flex: 1 1 auto; overflow: auto; padding: 8px; min-height: 0; }
[${ROOT_ATTR}] .ftm-hint { opacity: 0.72; margin: 0 0 8px; line-height: 1.5; }
[${ROOT_ATTR}] .ftm-notice {
  margin: 0 0 8px;
  padding: 6px 8px;
  border-radius: 6px;
  border: 1px solid var(--dsw-alias-border-1, rgba(128, 128, 128, 0.35));
  background: var(--dsw-alias-bg-raise, rgba(128, 128, 128, 0.08));
  line-height: 1.5;
}
[${ROOT_ATTR}] .ftm-notice[data-ftm-notice='failed'] { border-color: var(--dsw-alias-danger, rgba(192, 57, 43, 0.7)); }
[${ROOT_ATTR}] .ftm-notice[data-ftm-notice='conflict'] { border-color: var(--dsw-alias-warning, rgba(183, 121, 31, 0.7)); }
[${ROOT_ATTR}] .ftm-notice[data-ftm-notice='warn'] { border-color: var(--dsw-alias-warning, rgba(183, 121, 31, 0.7)); }
[${ROOT_ATTR}] .ftm-chain { list-style: none; margin: 0 0 10px; padding: 0; }
[${ROOT_ATTR}] .ftm-chain-row {
  display: flex;
  align-items: center;
  gap: 6px;
  border-radius: 6px;
  margin-bottom: 2px;
}
[${ROOT_ATTR}] .ftm-chain-row:hover { background: var(--dsw-alias-bg-hover, rgba(128, 128, 128, 0.12)); }
[${ROOT_ATTR}] .ftm-chain-row.is-active { background: var(--dsw-alias-bg-hover, rgba(128, 128, 128, 0.18)); }
[${ROOT_ATTR}] .ftm-chain-main {
  flex: 1 1 auto;
  min-width: 0;
  display: flex;
  align-items: center;
  gap: 6px;
  font: inherit;
  text-align: left;
  padding: 4px 4px;
  border: 0;
  border-radius: 6px;
  background: transparent;
  color: inherit;
  cursor: pointer;
}
[${ROOT_ATTR}] .ftm-chain-badge {
  flex: 0 0 auto;
  font-size: 0.85em;
  opacity: 0.7;
  border: 1px solid var(--dsw-alias-border-1, rgba(128, 128, 128, 0.35));
  border-radius: 4px;
  padding: 0 4px;
}
[${ROOT_ATTR}] .ftm-chain-title { flex: 1 1 auto; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
[${ROOT_ATTR}] .ftm-chain-row.is-focus .ftm-chain-title { font-weight: 600; }
[${ROOT_ATTR}] .ftm-chain-jump {
  flex: 0 0 auto;
  font: inherit;
  font-size: 0.85em;
  padding: 1px 6px;
  border-radius: 4px;
  border: 1px solid var(--dsw-alias-border-1, rgba(128, 128, 128, 0.35));
  background: transparent;
  color: inherit;
  cursor: pointer;
  opacity: 0;
}
[${ROOT_ATTR}] .ftm-chain-row:hover .ftm-chain-jump { opacity: 1; }
[${ROOT_ATTR}] .ftm-tools { display: flex; flex-wrap: wrap; gap: 6px; margin: 0 0 10px; }
[${ROOT_ATTR}] .ftm-tools .ftm-btn { flex: 0 0 auto; }
[${ROOT_ATTR}] .ftm-help {
  margin: 0 0 10px;
  padding: 8px 10px;
  max-height: 40vh;
  overflow: auto;
  white-space: pre-wrap;
  word-break: break-word;
  font: inherit;
  font-size: 0.92em;
  line-height: 1.5;
  border: 1px solid var(--dsw-alias-border-1, rgba(128, 128, 128, 0.35));
  border-radius: 8px;
  background: var(--dsw-alias-bg-2, rgba(128, 128, 128, 0.08));
}
[${ROOT_ATTR}] .ftm-notice[data-ftm-notice='info'] { border-color: var(--dsw-alias-border-1, rgba(128, 128, 128, 0.45)); }
[${ROOT_ATTR}] .ftm-kv { display: grid; grid-template-columns: auto 1fr; gap: 2px 10px; margin: 0 0 10px; }
[${ROOT_ATTR}] .ftm-kv dt { opacity: 0.72; white-space: nowrap; }
[${ROOT_ATTR}] .ftm-kv dd {
  margin: 0;
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  word-break: break-all;
}
[${ROOT_ATTR}] .ftm-slots {
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 0.92em;
  line-height: 1.6;
  margin: 0;
  padding: 0;
}
[${ROOT_ATTR}] .ftm-slots li { list-style: none; padding-left: 14px; position: relative; }
[${ROOT_ATTR}] .ftm-slots li::before { content: '·'; position: absolute; left: 4px; opacity: 0.6; }
[${ROOT_ATTR}] .ftm-resizer {
  position: absolute;
  top: 0;
  bottom: 0;
  left: 0;
  width: 6px;
  cursor: col-resize;
  z-index: 2;
}
[${ROOT_ATTR}] .ftm-resizer:hover { background: var(--dsw-alias-bg-hover, rgba(128, 128, 128, 0.18)); }
[${ROOT_ATTR}][data-collapsed='1'] { overflow: hidden; min-width: 0; }
[${ROOT_ATTR}][data-collapsed='1'] .ftm-resizer { display: none; }
/* 只收起正文，保留标题栏与按钮 —— 否则用户没有回到展开态的路 */
[${ROOT_ATTR}][data-collapsed='1'] .ftm-body { display: none; }
`

  function StyleTag() {
    return h('style', null, CSS)
  }

  // ───────────────────────────── 本地持久化小工具 ─────────────────────────────
  function readStoredWidth() {
    try {
      const raw = window.localStorage.getItem(WIDTH_KEY)
      if (raw === null) return PANEL_WIDTH_DEFAULT
      return clampWidth(raw)
    } catch {
      return PANEL_WIDTH_DEFAULT
    }
  }

  function readStoredCollapsed() {
    try {
      return window.localStorage.getItem(COLLAPSED_KEY) === '1'
    } catch {
      return false
    }
  }

  function write(key, value) {
    try {
      window.localStorage.setItem(key, String(value))
    } catch {
      /* 存不下不影响本次使用 */
    }
  }

  // ───────────────────────────── 探针面板 ─────────────────────────────
  /**
   * @param {any} ctx
   * @param {{ current: null | (() => void) }} toggleRef
   *   面板把「收起/展开」的实现挂进来，`apply()` 里的快捷键 handler 直接调用。
   *   这样快捷键**不需要**去点 DOM、也不需要面板持有焦点，仍然只作用于插件自己。
   */
  function makePanel(ctx, toggleRef) {
    return function FreeThoughtMapPanel(props) {
      const [width, setWidth] = useState(readStoredWidth)
      const [collapsed, setCollapsed] = useState(readStoredCollapsed)
      const drag = useRef(null)
      const rootRef = useRef(null)

      // ── 卡 2：与宿主权威 overlay 的同步状态 ──
      // `sessionId` 是本席位的**标准 prop**（scope: session），由 scope 适配器注入，
      // 不在 useTabInfo() 里。同一个 pane 组件可能同时为多个会话挂载（后台会话只是 hidden），
      // 所以一切都按 sessionId 键控，绝不把「已挂载的实例」当成「正在显示的会话」。
      const sessionId = props && props.sessionId
      const [authority, setAuthority] = useState({
        sessionId: undefined,
        doc: null,
        rev: -1,
        status: 'idle', // idle | loading | ready | failed | conflict
        notice: '',
      })
      const inflight = useRef(0)
      /** 本面板内的高亮（画布还没做，卡 7 才接真画布） */
      const [highlightId, setHighlightId] = useState(null)
      /** 「跳到气泡」的可见反馈（找不到 / 命中多个 都要说出来，不静默） */
      const [jumpNotice, setJumpNotice] = useState(null)
      /** 卡 8：帮助面板开合 */
      const [showHelp, setShowHelp] = useState(false)
      /** 卡 8：导入/导出的操作结果提示 */
      const [ioNotice, setIoNotice] = useState(null)

      /**
       * 卡 8 的三个动作，全走宿主 RPC。
       *
       * 注意导出的返回值有**两层 ok**：外层是网关的 RemoteResult，内层是我们端点自己的
       * `{ok, text}`。所以是 `r.value.ok` / `r.value.text` —— 少写一层会把 undefined 当成成功。
       */
      const runExport = (kind) => {
        const sid = authority.sessionId
        if (!sid) return
        setIoNotice({ tone: 'info', text: '正在导出…' })
        callRemote(ctx, 'exportDoc', { sessionId: sid, kind }).then((r) => {
          const payload = r && r.ok === true ? r.value : null
          if (!payload) {
            setIoNotice({ tone: 'warn', text: remoteError(r) })
            return
          }
          if (payload.ok !== true) {
            // PNG 会走到这里：明确说明它需要画布
            setIoNotice({ tone: 'warn', text: String(payload.error || '导出失败') })
            return
          }
          const isJson = kind === 'json'
          const name =
            'freethought-map-' + String(sid).slice(-8) + (isJson ? '.json' : '.md')
          const mime = isJson ? 'application/json' : 'text/markdown'
          try {
            const blob = new Blob([payload.text], { type: mime + ';charset=utf-8' })
            const url = URL.createObjectURL(blob)
            const a = document.createElement('a')
            a.href = url
            a.download = name
            document.body.appendChild(a)
            a.click()
            document.body.removeChild(a)
            setTimeout(() => URL.revokeObjectURL(url), 4000)
            setIoNotice({ tone: 'ok', text: '已导出 ' + name })
          } catch (e) {
            setIoNotice({ tone: 'warn', text: '触发下载失败：' + describeError(e) })
          }
        })
      }

      const runImport = () => {
        const sid = authority.sessionId
        if (!sid) return
        try {
          const input = document.createElement('input')
          input.type = 'file'
          input.accept = '.json,application/json'
          input.onchange = () => {
            const file = input.files && input.files[0]
            if (!file) return
            const reader = new FileReader()
            reader.onerror = () => setIoNotice({ tone: 'warn', text: '读文件失败' })
            reader.onload = () => {
              callRemote(ctx, 'importDoc', { sessionId: sid, json: String(reader.result) }).then((r) => {
                const payload = r && r.ok === true ? r.value : null
                if (!payload) {
                  setIoNotice({ tone: 'warn', text: remoteError(r) })
                  return
                }
                if (payload.ok !== true) {
                  setIoNotice({ tone: 'warn', text: String(payload.error || '导入被拒绝') })
                  return
                }
                const st = payload.stats || {}
                setIoNotice({
                  tone: 'ok',
                  text:
                    '导入完成：更新 ' + String(st.updated || 0) + '、新增 ' + String(st.added || 0) +
                    '、保留 ' + String(st.kept || 0) +
                    (payload.warnings && payload.warnings.length ? '；' + payload.warnings.join('；') : ''),
                })
                // 合并已经写进权威了，读回最新的一份
                loadAuthority()
              })
            }
            reader.readAsText(file)
          }
          input.click()
        } catch (e) {
          setIoNotice({ tone: 'warn', text: '打开文件选择器失败：' + describeError(e) })
        }
      }

      /**
       * 重建投影（卡 8 / 规格 §6.5）。
       *
       * 宿主拿不到「当前已加载窗口」这个概念 —— 那是客户端视图状态，所以由这里读出
       * 官方会话事件再传过去。取不到事件时如实说明，不假装重建成功。
       */
      const runRebuild = () => {
        const sid = authority.sessionId
        if (!sid) return
        const events = collectWindowEvents(ctx, sid)
        if (events === null) {
          setIoNotice({
            tone: 'warn',
            text: '拿不到本会话的事件（官方没有公开的"已加载窗口"读取接口）—— 重建已跳过，没有假装成功。',
          })
          return
        }
        setIoNotice({ tone: 'info', text: '正在重建投影（窗口内 ' + String(events.length) + ' 条事件）…' })
        callRemote(ctx, 'rebuild', { sessionId: sid, events }).then((r) => {
          const payload = r && r.ok === true ? r.value : null
          if (!payload || payload.ok !== true) {
            setIoNotice({ tone: 'warn', text: payload ? String(payload.error || '重建失败') : remoteError(r) })
            return
          }
          const v = payload.violations || []
          setIoNotice({
            tone: v.length ? 'warn' : 'ok',
            text:
              '重建完成：补了 ' + String(payload.appended || 0) + ' 个节点，跳过 ' +
              String(payload.skipped || 0) + ' 个' +
              (v.length ? '；**有 ' + String(v.length) + ' 处覆盖了已有结构**：' + v.slice(0, 3).join('；') : ''),
          })
          loadAuthority()
        })
      }

      /**
       * 从宿主的事件日志里取派生标题。
       *
       * 为什么从事件日志拿而不是从 overlay 拿：规格 §6.4 明写派生标题
       * **不写入 title 字段**，所以 overlay 里没有它。宿主在投影时顺手把派生标题
       * 记进事件日志（`SettlementLog`），客户端直接读 —— 两边不必各实现一遍截断规则。
       */
      const [derivedTitles, setDerivedTitles] = useState({})
      const loadDerivedTitles = useCallback(
        (sid) => {
          if (!sid) return
          callRemote(ctx, 'events', { sessionId: sid, sinceSeq: -1 }).then((r) => {
            if (!r || r.ok !== true) return
            const entries = (r.value && r.value.entries) || []
            const idx = {}
            for (const e of entries) {
              if (e && e.eventId && e.title) idx[String(e.eventId)] = String(e.title)
            }
            setDerivedTitles(idx)
          })
        },
        [ctx],
      )

      /**
       * 从宿主读回权威 overlay。
       *
       * 抽成 callback 是因为卡 8 的导入/重建之后也要重读一次（它们已经写进权威了）。
       * 用自增计数丢弃过期响应 —— 切会话时旧请求可能后到，整包丢弃避免串会话。
       */
      const loadAuthority = useCallback(
        (sid) => {
          const target = sid || sessionId
          if (!target) {
            setAuthority({ sessionId: undefined, doc: null, rev: -1, status: 'idle', notice: '' })
            return
          }
          const ticket = ++inflight.current
          setAuthority((s) => ({ ...s, sessionId: target, status: 'loading', notice: '' }))

          callRemote(ctx, 'load', { sessionId: target }).then((r) => {
            if (ticket !== inflight.current) return // 过期响应（已切走）—— 整包丢弃
            if (!r || r.ok !== true) {
              setAuthority({
                sessionId: target,
                doc: null,
                rev: -1,
                status: 'failed',
                notice: '读取宿主权威数据失败：' + remoteError(r),
              })
              return
            }
            const payload = r.value ?? {}
            if (payload.ok !== true) {
              setAuthority({
                sessionId: target,
                doc: null,
                rev: -1,
                status: 'failed',
                notice: '读取宿主权威数据失败：' + (payload.error || '未知错误'),
              })
              return
            }
            setAuthority({
              sessionId: target,
              doc: payload.doc,
              rev: payload.rev,
              status: 'ready',
              notice: '',
            })
            loadDerivedTitles(target)
          }, (e) => {
            if (ticket !== inflight.current) return
            setAuthority({
              sessionId: target,
              doc: null,
              rev: -1,
              status: 'failed',
              notice: '读取宿主权威数据失败：' + describeError(e),
            })
          })
        },
        [ctx, sessionId, loadDerivedTitles],
      )

      // 会话变了（或首次挂载）→ 读一次权威
      useEffect(() => {
        if (!sessionId) {
          setAuthority({ sessionId: undefined, doc: null, rev: -1, status: 'idle', notice: '' })
          return undefined
        }
        loadAuthority(sessionId)
        return undefined
      }, [sessionId, loadAuthority])

      /**
       * 保存到宿主权威。演示卡 2 的完整协议：
       *   - 带 `baseRev` 提交；
       *   - 409 冲突时**不用本地覆盖权威**，而是把权威 doc 换成返回值并提示「已从宿主重载」；
       *   - 其它失败给出可见提示（规格 §9 第 7 条：不得假装已保存）。
       */
      const saveAuthority = useCallback(
        (nextDoc) => {
          if (!sessionId) return
          const baseRev = authority.rev
          const ticket = ++inflight.current
          callRemote(ctx, 'save', { sessionId, doc: nextDoc, baseRev }).then(
            (r) => {
              if (ticket !== inflight.current) return
              if (!r || r.ok !== true) {
                setAuthority((s) => ({ ...s, status: 'failed', notice: '保存失败：' + remoteError(r) }))
                return
              }
              const payload = r.value ?? {}
              if (payload.status === 'ok') {
                setAuthority({ sessionId, doc: payload.doc, rev: payload.rev, status: 'ready', notice: '' })
              } else if (payload.status === 'conflict') {
                // 关键红线：本地不得覆盖权威。换成宿主的 doc 并让用户知道。
                setAuthority({
                  sessionId,
                  doc: payload.doc,
                  rev: payload.rev,
                  status: 'conflict',
                  notice: '宿主数据已更新（版本 ' + String(payload.rev) + '），本地已重载，未覆盖。',
                })
              } else {
                setAuthority((s) => ({
                  ...s,
                  status: 'failed',
                  notice: '保存被拒绝：' + (payload.reason || '未知原因'),
                }))
              }
            },
            (e) => {
              if (ticket !== inflight.current) return
              setAuthority((s) => ({ ...s, status: 'failed', notice: '保存失败：' + describeError(e) }))
            },
          )
        },
        [ctx, sessionId, authority.rev],
      )
      void saveAuthority

      useEffect(() => {
        write(WIDTH_KEY, width)
      }, [width])
      useEffect(() => {
        write(COLLAPSED_KEY, collapsed ? 1 : 0)
      }, [collapsed])

      // 把切换实现交给 apply() 的快捷键 handler；组件卸载时摘掉，避免调用已卸载的 setState。
      useEffect(() => {
        toggleRef.current = () => setCollapsed((v) => !v)
        return () => {
          toggleRef.current = null
        }
      }, [toggleRef])

      /**
       * **唯一的键盘监听**：挂在面板根节点自己身上。
       *
       * 为什么不是 `window.addEventListener('keydown', …)`：
       * 规格 `01-产品与技术规格.md` §5 明令「禁止长期 window 全局 listener 不检查 target」；
       * 挂在根节点上，事件只在面板内部冒泡时才会到这里，宿主与官方输入框完全不受影响。
       * 这也是卡 1 的验收项 D1-4（官方输入框 Enter 仍能发送）。
       */
      useEffect(() => {
        const el = rootRef.current
        if (!el) return undefined
        const onKeyDown = (e) => {
          if (e.key !== 'm' && e.key !== 'M') return
          if (!(e.ctrlKey || e.metaKey) || !e.altKey) return
          const t = e.target
          // 打字时不抢键（与线 A 的 useHotkeys 同一条纪律）
          if (t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName || ''))) return
          e.preventDefault()
          e.stopPropagation()
          setCollapsed((v) => !v)
        }
        el.addEventListener('keydown', onKeyDown)
        return () => el.removeEventListener('keydown', onKeyDown)
      }, [])

      // 拖动改宽：监听器在指针按下时才挂，松手即卸；只影响本插件根节点内的盒宽。
      const onPointerDown = useCallback(
        (e) => {
          e.preventDefault()
          drag.current = { startX: e.clientX, startWidth: width }
          const move = (ev) => {
            const d = drag.current
            if (!d) return
            setWidth(clampWidth(d.startWidth - (ev.clientX - d.startX)))
          }
          const up = () => {
            drag.current = null
            window.removeEventListener('pointermove', move)
            window.removeEventListener('pointerup', up)
          }
          window.addEventListener('pointermove', move)
          window.addEventListener('pointerup', up)
        },
        [width],
      )

      /**
       * 探针 P1 取证：把宿主真实暴露的 slot 名单读出来。
       * 任何枚举 API 不存在都不抛错 —— 只记「未找到」，让面板本身照常渲染。
       */
      const [probe] = useState(() => {
        const out = { slotNames: [], slotSource: '未找到' }
        const slots = ctx && ctx.slots
        if (!slots) return out
        const fns = ['listSlots', 'list', 'keys', 'names', 'listSubTree', 'snapshot']
        for (const fn of fns) {
          if (typeof slots[fn] !== 'function') continue
          try {
            const r = slots[fn]()
            const arr = Array.isArray(r)
              ? r.map((x) => (typeof x === 'string' ? x : x && (x.key || x.name || x.id)))
              : r && typeof r === 'object'
                ? Object.keys(r)
                : null
            const list = (arr || []).filter((x) => typeof x === 'string' && x).sort()
            if (list.length) {
              out.slotNames = list
              out.slotSource = 'ctx.slots.' + fn + '()'
              return out
            }
          } catch (e) {
            out.slotSource = 'ctx.slots.' + fn + '() 抛错：' + (e && e.message)
          }
        }
        return out
      })

      /**
       * 卡 4：把链渲染成可点的行。
       *
       * 每行做三件事：
       *   1. 显示（注解三态由 buildChainView 处理，派生标题从宿主事件日志取）；
       *   2. 点了 → 本面板高亮 + **焦点跟随**（规格 §5：单击节点同时设 focus）；
       *   3. 有 sourceRef 的行 → 「跳到气泡」，走 scrollToBubble（**唯一读宿主 DOM 的地方**，
       *      找不到/命中多个都如实提示，不静默）。
       */
      const chainRows = buildChainView(authority.doc || { nodes: {} }, { derivedTitles })

      const onRowClick = (row) => {
        setHighlightId(row.id)
        // 焦点与选中分离：这里只动本面板的高亮 + 把焦点写回权威
        const doc = authority.doc
        if (!doc || doc.focusId === row.id) return
        saveAuthority({ ...doc, focusId: row.id })
      }

      const onJumpToBubble = (row) => {
        // 作用域给 document：气泡在官方对话列里，不在我们面板内
        const r = scrollToBubble(document, row)
        if (r.ok) {
          setJumpNotice({ tone: 'ok', text: '已跳到对应气泡' })
        } else if (r.reason === 'ambiguous') {
          setJumpNotice({ tone: 'warn', text: '找到多个候选气泡，未跳转（避免跳错）：' + (r.detail || '') })
        } else if (r.reason === 'no-source-ref') {
          setJumpNotice({ tone: 'warn', text: '手建节点没有对应气泡' })
        } else {
          setJumpNotice({
            tone: 'warn',
            text: '没找到对应气泡（官方没有公开的定位 API，这里是按 DOM 属性找的降级路径）',
          })
        }
      }

      const chainList = chainRows.length
        ? h(
            'ul',
            { className: 'ftm-chain', 'data-ftm-chain': String(chainRows.length) },
            chainRows.map((row) =>
              h(
                'li',
                {
                  key: row.id,
                  className:
                    'ftm-chain-row' +
                    (row.isFocus ? ' is-focus' : '') +
                    (highlightId === row.id ? ' is-active' : ''),
                  'data-ftm-node': row.id,
                  'data-ftm-kind': row.kind,
                  style: { paddingLeft: 6 + row.depth * 12 },
                },
                h(
                  'button',
                  {
                    className: 'ftm-chain-main',
                    title: '选中并把焦点移到这里（下一句默认挂到它下面）',
                    onClick: () => onRowClick(row),
                  },
                  h('span', { className: 'ftm-chain-badge' }, row.kind === 'turn' ? '回合' : '手建'),
                  h(
                    'span',
                    { className: 'ftm-chain-title' },
                    // 注解是空串时**显示空**，用一个占位符表明"用户主动清空了"
                    row.title === '' ? (row.hasAnnotation ? '（已清空）' : '（无标题）') : row.title,
                  ),
                ),
                row.sourceRef
                  ? h(
                      'button',
                      {
                        className: 'ftm-chain-jump',
                        title: '跳到官方对话里对应的气泡',
                        onClick: () => onJumpToBubble(row),
                      },
                      '跳到气泡',
                    )
                  : null,
              ),
            ),
          )
        : h('p', { className: 'ftm-hint' }, '这个会话还没有回合。发一句话，链就会长出来。')

      const body = h(
        'div',
        { className: 'ftm-body' },
        // 卡 2 的可见失败面（规格 §9 第 7 条：保存失败必须有可见提示，不是 console only）
        authority.notice
          ? h(
              'p',
              {
                className: 'ftm-notice',
                role: 'status',
                'data-ftm-notice': authority.status,
              },
              authority.notice,
            )
          : null,
        h(
          'p',
          { className: 'ftm-hint' },
          '链（点一行把焦点移过去；有对应气泡的可以跳过去）',
        ),
        // ── 卡 8 操作条 ──
        h(
          'div',
          { className: 'ftm-tools' },
          h(
            'button',
            { className: 'ftm-btn', title: '导出为 JSON', onClick: () => runExport('json') },
            '导出 JSON',
          ),
          h(
            'button',
            { className: 'ftm-btn', title: '导出为 Markdown 大纲', onClick: () => runExport('markdown') },
            '导出 MD',
          ),
          h(
            'button',
            { className: 'ftm-btn', title: '从 JSON 导入（只接受本会话的导出）', onClick: runImport },
            '导入',
          ),
          h(
            'button',
            { className: 'ftm-btn', title: '按官方会话重建投影', onClick: runRebuild },
            '重建投影',
          ),
          h(
            'button',
            {
              className: 'ftm-btn',
              title: '帮助',
              onClick: () => setShowHelp((v) => !v),
            },
            showHelp ? '收起帮助' : '帮助',
          ),
        ),
        ioNotice
          ? h(
              'p',
              { className: 'ftm-notice', role: 'status', 'data-ftm-notice': ioNotice.tone },
              ioNotice.text,
            )
          : null,
        showHelp
          ? h('pre', { className: 'ftm-help', 'data-ftm-help': '1' }, HELP_TEXT)
          : null,
        jumpNotice
          ? h(
              'p',
              {
                className: 'ftm-notice',
                role: 'status',
                'data-ftm-notice': jumpNotice.tone,
              },
              jumpNotice.text,
            )
          : null,
        chainList,
        h(
          'dl',
          { className: 'ftm-kv' },
          h('dt', null, '插件'),
          h('dd', null, PLUGIN_ID),
          h('dt', null, '宿主'),
          h('dd', null, DSH_VERSION),
          h('dt', null, 'commit'),
          h('dd', null, DSH_COMMIT),
          h('dt', null, '会话'),
          h('dd', null, sessionId ? String(sessionId) : '（无）'),
          h('dt', null, '权威状态'),
          h('dd', null, authority.status),
          h('dt', null, '权威 rev'),
          h('dd', null, String(authority.rev)),
          h('dt', null, '节点数'),
          h('dd', null, authority.doc ? String(Object.keys(authority.doc.nodes || {}).length) : '—'),
          h('dt', null, '焦点'),
          h('dd', null, (authority.doc && authority.doc.focusId) || '（无）'),
        ),
      )

      return h(
        'div',
        {
          ref: rootRef,
          [ROOT_ATTR]: '',
          'data-collapsed': collapsed ? '1' : '0',
          // tabIndex=-1：面板可以被程序化聚焦，从而让挂在根上的 keydown 生效；
          // 但不进入 Tab 顺序，不会打断宿主自己的焦点流。
          tabIndex: -1,
          style: { position: 'relative', height: '100%' },
        },
        h(StyleTag),
        h('div', { className: 'ftm-resizer', title: '拖动改宽', onPointerDown }),
        h(
          'div',
          { className: 'ftm-bar' },
          h('span', { className: 'ftm-title' }, 'FreeThought Map'),
          h(
            'button',
            {
              className: 'ftm-btn',
              title: collapsed ? '展开' : '收起',
              onClick: () => setCollapsed((v) => !v),
            },
            collapsed ? '展开' : '收起',
          ),
        ),
        collapsed ? null : body,
      )
    }
  }

  // 运行时 inject 用的是**服务名**（`ctx.<name>`），与 package.json 里
  // `dsh.client.inject`（**包名**列表，管激活顺序）是两套东西，别混。
  //   slots             —— ui-renderer 提供（客户端 UI 组合的底座）
  //   sidebarRight      —— @deepseek-ai/dsh-client-ui-sidebar-right/lib/client.js:9051
  //   sidebarRightTabs  —— 同包 lib/client.js:9050
  //   connection        —— @deepseek-ai/dsh-client-connection/lib/client.js:1477 `ctx.provide("connection", …)`。
  //                        它是所有 api-* 插件的地基，官方 gateway 客户端面也直接用它发 RPC。
  //
  // ⚠️ Cordis **不允许**访问没写进 inject 的服务属性：`ctx.xxx` 会直接抛
  // `cannot get property "xxx" without inject`，而 apply 里的异常会让整行激活失败
  // → 整个 Web 前端拒绝加载。本轮实测连续踩了三次（shortcuts / storageDomain / remote）。
  // 往这里加任何名字之前，先在源码里找到 `provide("<name>")` 或 `super(ctx, "<name>")`。
  const inject = ['slots', 'sidebarRight', 'sidebarRightTabs', 'connection']

  /** 事件目标是否落在本插件的根节点内 —— 所有本插件快捷键的唯一准入判据。 */
  function targetInsidePanel(target) {
    if (!target || typeof target.closest !== 'function') return false
    return target.closest('[' + ROOT_ATTR + ']') !== null
  }

  function describeError(e) {
    if (!e) return 'unknown'
    return e.message ? String(e.message) : String(e)
  }

  function logInfo(ctx, message) {
    try {
      const logger = ctx && ctx.logger
      if (logger && typeof logger.info === 'function') logger.info('[freethought-map] ' + message)
    } catch {
      /* 日志不可用不影响任何事 */
    }
  }

  /**
   * 调宿主 Remote，统一成 `{ ok: true, value } | { ok: false, error }`。
   *
   * 走 `ctx.connection.rpc.call('/api', '<ns>/<method>', { args })` —— 这是
   * `dsh-api-gateway` 客户端面**自己用的**同一条路（`dsh-api-gateway/lib/client.js:1792`），
   * 返回的 `result` 就是官方 `RemoteResult`：`{ ok: true, value }` | `{ ok: false, error }`。
   *
   * 为什么不用更高层的 `ctx.remote.<ns>.<method>()`：那条路要求先把描述符 `$mount` 进去，
   * 而 `ctx.remote.freethoughtMap` 还需要写进 inject（未挂载时 Cordis 会抛
   * `cannot get property "remote.freethoughtMap" without inject`，客户端实测踩到过）。
   * 直连传输少一层时序耦合，代价是自己拼端点名 —— 而端点名本来就是我们定的。
   *
   * 判别一律靠 `ok` 分支 + `error.code`，**禁止 `instanceof`**（载体故障不 reject）。
   */
  function callRemote(ctx, method, args) {
    const connection = ctx && ctx.connection
    if (!connection || !connection.rpc || typeof connection.rpc.call !== 'function') {
      return Promise.resolve({
        ok: false,
        error: { code: 'remote-unavailable', message: 'ctx.connection.rpc 不可用' },
      })
    }
    const endpoint = REMOTE_SERVICE + '/' + method
    try {
      return Promise.resolve(connection.rpc.call('/api', endpoint, { args }, undefined)).then(
        (result) => result,
        (e) => ({ ok: false, error: { code: 'carrier', message: describeError(e) } }),
      )
    } catch (e) {
      return Promise.resolve({ ok: false, error: { code: 'throw', message: describeError(e) } })
    }
  }

  /** 把 Remote 失败结果压成一行可显示的文字。 */
  function remoteError(r) {
    if (!r) return '无返回'
    if (r.error && r.error.message) return r.error.message + (r.error.code ? ' (' + r.error.code + ')' : '')
    return describeError(r)
  }

  function apply(ctx) {
    // 面板把「收起/展开」挂进来，供快捷键 handler 调用（见 makePanel 的注释）。
    const toggleRef = { current: null }
    const Panel = makePanel(ctx, toggleRef)

    // (a) 注册 tab 类型 —— 列的导航控制器靠它认领地址、给出标题。
    ctx.effect(
      () =>
        ctx.sidebarRightTabs.register({
          id: TAB_KIND,
          kind: TAB_KIND,
          patterns: [TAB_ADDRESS + '**'],
          priority: 'builtin',
          canOpen: (address) => typeof address === 'string' && address.indexOf(TAB_ADDRESS) === 0,
          title: () => 'FreeThought Map',
        }),
      'freethought-map: tab type',
    )

    // (b) 注册 tab 正文 —— key 必须等于上面声明的 id。
    ctx.effect(
      () =>
        ctx.slots.inject('sidebar.right.pane.tab', () =>
          ctx.slots.register({ name: 'sidebar.right.pane.tab', key: TAB_KIND }, Panel),
        ),
      'freethought-map: panel body',
    )

    // (c) 「首次出现时打开一次」本插件的 tab（卡 1 验收项 D1-1）。
    //
    // 为什么需要这一段：官方右列是**按会话挂载**的 —— 没有选中会话时，
    // `ctx.sidebarRight.openTab()` 会直接 throw（README 原文：「命令需要一个已挂载的
    // 会话停靠面；没有时它们 throw，而不是写进一个没人绘制的面里」）。
    // 所以只能等：轮询 `sidebarRight.mounted`，一旦挂载面出现就开一次，然后落地标记，
    // 之后用户关掉就不会再被弹回来。
    //
    // 用轮询而不是 hook，是因为这里拿不到 React 的绑定 hook（那是组件内部的东西），
    // 而 `mounted` 是官方文档明确给出的「席位正在屏幕上的那个会话」可观察值。
    const autopen = ctx.effect(() => {
      let done = false
      try {
        done = window.localStorage.getItem(AUTOPEN_KEY) === '1'
      } catch {
        /* 读不到就当作没做过 */
      }
      if (done) return undefined

      let tries = 0
      const timer = window.setInterval(() => {
        tries += 1
        try {
          // mounted 有值 = 会话停靠面已经在屏幕上，此时 openTab 才安全
          const mounted = ctx.sidebarRight.mounted
          if (mounted === undefined || mounted === null) {
            if (tries > 120) window.clearInterval(timer) // 约 1 分钟还没会话就放弃
            return
          }
          ctx.sidebarRight.openTab(TAB_KIND, { params: {} })
          window.localStorage.setItem(AUTOPEN_KEY, '1')
          window.clearInterval(timer)
        } catch (e) {
          // openTab 在竞态下仍可能抛（面刚拆掉）。记一条就放弃，绝不刷屏。
          window.clearInterval(timer)
          const logger = ctx.logger
          if (logger && typeof logger.info === 'function') {
            logger.info('[freethought-map] 自动打开 tab 失败（不影响手动打开）：' + String(e && e.message))
          }
        }
      }, 500)

      return () => window.clearInterval(timer)
    }, 'freethought-map: auto-open tab')

    void autopen

    // (d) 卡 2 的权威读写走 `ctx.connection.rpc.call`（见 callRemote 的注释），
    //     **不需要**把 Remote 描述符 `$mount` 进 `ctx.remote`。
    //
    // 为什么删掉了早先的 `remote.$mount(buildRemoteContribution())`：
    //   1. `ctx.remote` 没写进 inject 时会抛 `cannot get property "remote" without inject`
    //      —— 而 apply 里的异常会让整行激活失败，整个 Web 前端拒绝加载（实测踩到）；
    //   2. 就算加了 inject，`ctx.remote.freethoughtMap` 还需要 `remote.freethoughtMap`
    //      这个**由挂载产生的**服务键，未挂载时同样抛（也实测踩到）。
    // 直连传输只用 `connection` 一个服务，没有这层时序耦合。
    //
    // The descriptor builder is kept in this file so `scripts/verify-host.mjs` can keep
    // 两侧契约比对；将来若要用 `ctx.remote.<ns>.method()` 形态，注释见该函数。
    void buildRemoteContribution
  }

  return { inject, apply: guardedApply(apply) }

  /**
   * 包一层 try/catch 把真实异常打到控制台。
   *
   * 为什么需要：宿主对客户端激活失败只报 `dsh-freethought-map: failed`，**不给原因**
   * （见 docs/HOST.md 的踩坑记录）。不自己把栈打出来，就只能靠猜 —— 本轮就是靠它
   * 一眼看到 `ReferenceError: ctx is not defined`。
   * 这里同时 re-throw，保证激活失败仍然是「响的」而不是被悄悄吞掉。
   */
  function guardedApply(inner) {
    return function applyWithDiagnostics() {
      try {
        return inner.apply(null, arguments)
      } catch (e) {
        try {
          // eslint-disable-next-line no-console
          console.error('[freethought-map] 客户端激活失败（真实异常）：', e)
        } catch {
          /* 连 console 都没有就只能认了 */
        }
        throw e
      }
    }
  }
}

// ───────────────────────── 注册进宿主的模块表 ─────────────────────────
//
// ⚠️ 本文件**不是 ES 模块**，虽然它看起来像。宿主把 `./client` 导出的文件当**普通脚本**
// 注入页面（`<script src="plugins/??<id>/client.js">`），所以：
//   - **不能出现 `export` / `import`**，否则浏览器直接抛
//     `SyntaxError: Unexpected token 'export'`，整个插件静默失效（实测踩过）；
//   - 与宿主的全部交互都通过全局 `window.__ModuleLoader__.load({...})` 完成。
// 这正是 DSH「惰性 CJS 注册」约定的意思：一个注册脚本 + 一个 factory。
//
// ⚠️ 另一个实测教训：宿主的 boot 报错只说 `dsh-freethought-map: failed`，**不给原因**，
// 而客户端激活失败的异常会在 `onEntryState` 那条路径上被吞掉。所以我们自己在
// factory 与 apply 两层各包一次 try/catch，把真实栈打到 console —— 否则只能靠猜。
window.__ModuleLoader__.load({
  id: PLUGIN_ID,
  factory(require) {
    try {
      return createPlugin(require('react'))
    } catch (e) {
      try {
        // eslint-disable-next-line no-console
        console.error('[freethought-map] factory 抛错（真实异常）：', e)
      } catch {
        /* 忽略 */
      }
      throw e
    }
  },
})
