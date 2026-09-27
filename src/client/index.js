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
    return function FreeThoughtMapPanel() {
      const [width, setWidth] = useState(readStoredWidth)
      const [collapsed, setCollapsed] = useState(readStoredCollapsed)
      const drag = useRef(null)
      const rootRef = useRef(null)

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
        h(
          'p',
          { className: 'ftm-hint' },
          '卡 1 探针壳：这里暂时只显示宿主信息。真正的思路链画布在卡 3 之后落地。',
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
          h('dt', null, 'tab kind'),
          h('dd', null, TAB_KIND),
          h('dt', null, '面板宽'),
          h('dd', null, String(width)),
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
  //
  // ⚠️ 不要凭猜往这里加名字。宿主在激活前会**等待**注入的服务出现，等不到就把这一行判为
  // pending/failed，而失败会让整个 Web 前端拒绝加载（页面显示 "Failed to load plugins"）。
  // 实测踩过：加了没核实的 'shortcuts' 之后，插件整包停止激活。
  // 加任何新服务名之前，先在源码里找到 `provide("<name>")` 或 `super(ctx, "<name>")`。
  const inject = ['slots', 'sidebarRight', 'sidebarRightTabs']

  /** 事件目标是否落在本插件的根节点内 —— 所有本插件快捷键的唯一准入判据。 */
  function targetInsidePanel(target) {
    if (!target || typeof target.closest !== 'function') return false
    return target.closest('[' + ROOT_ATTR + ']') !== null
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
  }

  return { inject, apply }
}

// ───────────────────────── 注册进宿主的模块表 ─────────────────────────
//
// ⚠️ 本文件**不是 ES 模块**，虽然它看起来像。宿主把 `./client` 导出的文件当**普通脚本**
// 注入页面（`<script src="plugins/??<id>/client.js">`），所以：
//   - **不能出现 `export` / `import`**，否则浏览器直接抛
//     `SyntaxError: Unexpected token 'export'`，整个插件静默失效（实测踩过）；
//   - 与宿主的全部交互都通过全局 `window.__ModuleLoader__.load({...})` 完成。
// 这正是 DSH「惰性 CJS 注册」约定的意思：一个注册脚本 + 一个 factory。
window.__ModuleLoader__.load({
  id: PLUGIN_ID,
  factory(require) {
    return createPlugin(require('react'))
  },
})
