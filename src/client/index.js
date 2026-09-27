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

function createPlugin(React) {
  const h = React.createElement
  const { useCallback, useEffect, useRef, useState } = React

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

      // 会话变了（或首次挂载）→ 从宿主 load 权威。用自增计数丢弃过期响应。
      useEffect(() => {
        if (!sessionId) {
          setAuthority({ sessionId: undefined, doc: null, rev: -1, status: 'idle', notice: '' })
          return undefined
        }
        const ticket = ++inflight.current
        setAuthority((s) => ({ ...s, sessionId, status: 'loading', notice: '' }))

        callRemote(ctx, 'load', { sessionId }).then(
          (r) => {
            if (ticket !== inflight.current) return // 过期响应（已切走）—— 整包丢弃
            if (!r || r.ok !== true) {
              setAuthority({
                sessionId,
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
                sessionId,
                doc: null,
                rev: -1,
                status: 'failed',
                notice: '读取宿主权威数据失败：' + (payload.error || '未知错误'),
              })
              return
            }
            setAuthority({ sessionId, doc: payload.doc, rev: payload.rev, status: 'ready', notice: '' })
          },
          (e) => {
            if (ticket !== inflight.current) return
            setAuthority({
              sessionId,
              doc: null,
              rev: -1,
              status: 'failed',
              notice: '读取宿主权威数据失败：' + describeError(e),
            })
          },
        )
        return undefined
      }, [sessionId])

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
          '卡 2：宿主权威存储已接通。思路链画布在卡 3 之后落地。',
        ),
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
          h('dt', null, '权威节点数'),
          h('dd', null, authority.doc ? String(Object.keys(authority.doc.nodes || {}).length) : '—'),
          h('dt', null, 'slot 来源'),
          h('dd', null, probe.slotSource),
        ),
        h('div', { className: 'ftm-hint' }, '宿主可见 slot（' + probe.slotNames.length + '）：'),
        h(
          'ul',
          { className: 'ftm-slots' },
          probe.slotNames.length
            ? probe.slotNames.slice(0, 300).map((n) => h('li', { key: n }, n))
            : h('li', null, '（未找到枚举 API —— 见 docs/HOST.md 探针 P1）'),
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
