/**
 * dsh-freethought-map · 客户端一半（Client half）· 卡 1 探针壳
 *
 * 这一版**不是产品 UI**，是探针外壳。它只做四件事：
 *   1. 证明客户端模块被宿主加载（注册进一个真实存在的 slot 并渲染出一块可见面板）；
 *   2. 证明 Root / 样式 / 快捷键隔离（所有选择器与监听都限定在本插件的根节点内）；
 *   3. 证明左右布局可收展，且收展宽度持久化；
 *   4. 把宿主实际提供的 slot 名单打到页面上，供 docs/HOST.md 的探针表逐条取证。
 *
 * 宿主版本：dsh 0.1.7-rc.2 · commit c1275515b6b97551ec358c926c479ab750c687c0
 *
 * 纪律（来自宿主官方 skill `cordis-plugin-development`）：
 *   - 不 import 任何 @deepseek-ai/dsh-client-* 包；React 从模块表取。
 *   - 不替换 app root，不往 document.body 追加节点。
 *   - 不在 factory 里做副作用；注册与监听都放在 apply(ctx) 内并用 ctx.effect 归还清理。
 *   - 只用 --dsw-alias-* 主题 token 上色，不写死颜色。
 */

const PLUGIN_ID = 'dsh-freethought-map'
const ROOT_ATTR = 'data-freethought-map-root'
const WIDTH_KEY = 'freethought-map:panel-width:v1'
const COLLAPSED_KEY = 'freethought-map:panel-collapsed:v1'

/** 与 spec 一致：探针阶段先钉住右侧停靠列（宿主原生可 push 挤压会话列）。 */
const PANEL_WIDTH_DEFAULT = 420
const PANEL_WIDTH_MIN = 264
const PANEL_WIDTH_MAX = 900

window.__ModuleLoader__.load({
  id: PLUGIN_ID,
  factory(require) {
    const React = require('react')
    const h = React.createElement
    const { useCallback, useEffect, useMemo, useRef, useState } = React

    // ───────────────────────────── 样式（局部，不污染宿主） ─────────────────────────────
    // 用 CSS 变量 + 根节点前缀，绝不写 html/body/:root。
    // 全部颜色走 --dsw-alias-* token；取不到时回退到中性色，保证不会白屏。
    const CSS = `
[${ROOT_ATTR}] {
  display: flex;
  flex-direction: column;
  height: 100%;
  min-width: 0;
  box-sizing: border-box;
  font-size: inherit;
  color: var(--dsw-alias-text-1, inherit);
  background: var(--dsw-alias-bg-1, transparent);
}
[${ROOT_ATTR}] * { box-sizing: border-box; }
[${ROOT_ATTR}] .ftm-bar {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 6px 8px;
  border-bottom: 1px solid var(--dsw-alias-border-1, rgba(128,128,128,.25));
  flex: 0 0 auto;
}
[${ROOT_ATTR}] .ftm-title { font-weight: 600; margin-right: auto; }
[${ROOT_ATTR}] .ftm-btn {
  font: inherit;
  padding: 2px 8px;
  border-radius: 6px;
  border: 1px solid var(--dsw-alias-border-1, rgba(128,128,128,.35));
  background: transparent;
  color: inherit;
  cursor: pointer;
}
[${ROOT_ATTR}] .ftm-btn:hover { background: var(--dsw-alias-bg-hover, rgba(128,128,128,.12)); }
[${ROOT_ATTR}] .ftm-body { flex: 1 1 auto; overflow: auto; padding: 8px; min-height: 0; }
[${ROOT_ATTR}] .ftm-hint { opacity: .72; margin: 0 0 8px; line-height: 1.5; }
[${ROOT_ATTR}] .ftm-kv { display: grid; grid-template-columns: auto 1fr; gap: 2px 10px; margin: 0 0 10px; }
[${ROOT_ATTR}] .ftm-kv dt { opacity: .72; }
[${ROOT_ATTR}] .ftm-kv dd { margin: 0; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; }
[${ROOT_ATTR}] .ftm-slots { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: .92em; line-height: 1.6; }
[${ROOT_ATTR}] .ftm-slots li { list-style: none; padding-left: 14px; position: relative; }
[${ROOT_ATTR}] .ftm-slots li::before { content: '·'; position: absolute; left: 4px; opacity: .6; }
[${ROOT_ATTR}] .ftm-resizer {
  position: absolute; top: 0; bottom: 0; left: 0; width: 6px;
  cursor: col-resize; z-index: 2;
}
[${ROOT_ATTR}] .ftm-resizer:hover { background: var(--dsw-alias-bg-hover, rgba(128,128,128,.18)); }
[${ROOT_ATTR}][data-collapsed='1'] .ftm-body { display: none; }
`

    function StyleTag() {
      return h('style', { [ROOT_ATTR + '-style']: '' }, CSS)
    }

    // ───────────────────────────── 持久化的小工具 ─────────────────────────────
    function readNumber(key, fallback, min, max) {
      try {
        const raw = window.localStorage.getItem(key)
        if (raw === null) return fallback
        const v = Number(raw)
        if (!Number.isFinite(v)) return fallback
        return Math.min(max, Math.max(min, Math.round(v)))
      } catch {
        return fallback
      }
    }

    function readBool(key, fallback) {
      try {
        const raw = window.localStorage.getItem(key)
        return raw === null ? fallback : raw === '1'
      } catch {
        return fallback
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
     * @param {{ slots: any, layout?: any }} ctx
     */
    function makePanel(ctx) {
      return function FreeThoughtMapPanel(props) {
        const [width, setWidth] = useState(() =>
          readNumber(WIDTH_KEY, PANEL_WIDTH_DEFAULT, PANEL_WIDTH_MIN, PANEL_WIDTH_MAX),
        )
        const [collapsed, setCollapsed] = useState(() => readBool(COLLAPSED_KEY, false))
        const drag = useRef(null)

        // 收展与宽度都持久化（卡 2 再迁到 Host 权威存储）
        useEffect(() => {
          write(WIDTH_KEY, width)
        }, [width])
        useEffect(() => {
          write(COLLAPSED_KEY, collapsed ? 1 : 0)
        }, [collapsed])

        // 拖动改宽：只在本插件的根节点内监听，松手才落一次 persist（上面的 effect 负责）
        const onPointerDown = useCallback(
          (e) => {
            e.preventDefault()
            drag.current = { startX: e.clientX, startWidth: width }
            const move = (ev) => {
              const d = drag.current
              if (!d) return
              const next = d.startWidth - (ev.clientX - d.startX)
              setWidth(Math.min(PANEL_WIDTH_MAX, Math.max(PANEL_WIDTH_MIN, Math.round(next))))
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
         * 探针 P1 的核心取证：把宿主真实暴露的 slot 名单读出来。
         * 先试公开查询 API；任何一个不存在都不抛，只记录「未找到」，让面板本身照常渲染。
         */
        const [{ slotNames, slotSource }] = useState(() => {
          const out = { slotNames: [], slotSource: '未找到' }
          const slots = ctx?.slots
          if (!slots) return [out]
          for (const fn of ['list', 'listSlots', 'keys', 'names', 'listSubTree']) {
            if (typeof slots[fn] !== 'function') continue
            try {
              const r = slots[fn]()
              const arr = Array.isArray(r) ? r : r && typeof r === 'object' ? Object.keys(r) : null
              if (arr && arr.length) {
                out.slotNames = arr.map(String).sort()
                out.slotSource = `ctx.slots.${fn}()`
                return [out]
              }
            } catch (e) {
              out.slotNames = []
              out.slotSource = `ctx.slots.${fn}() 抛错：${e && e.message}`
            }
          }
          return [out]
        })

        const panelStyle = collapsed
          ? { display: 'none' }
          : { width: `${width}px`, flex: `0 0 ${width}px`, position: 'relative' }

        if (collapsed) {
          // 收起态：只留一根窄条，点一下展开。窄条宽度固定，不占用户拖出来的宽度。
          return h(
            'div',
            { [ROOT_ATTR]: '', 'data-collapsed': '1', style: { flex: '0 0 32px', width: 32 } },
            h(StyleTag),
            h(
              'button',
              {
                className: 'ftm-btn',
                style: { margin: 6, padding: '2px 4px' },
                title: '展开 FreeThought Map',
                onClick: () => setCollapsed(false),
              },
              '▸',
            ),
          )
        }

        return h(
          'div',
          { [ROOT_ATTR]: '', 'data-collapsed': '0', style: panelStyle },
          h(StyleTag),
          h('div', {
            className: 'ftm-resizer',
            title: '拖动改宽',
            onPointerDown,
          }),
          h(
            'div',
            { className: 'ftm-bar' },
            h('span', { className: 'ftm-title' }, 'FreeThought Map'),
            h(
              'button',
              { className: 'ftm-btn', title: '收起', onClick: () => setCollapsed(true) },
              '收起',
            ),
          ),
          h(
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
              h('dd', null, 'dsh 0.1.7-rc.2'),
              h('dt', null, 'commit'),
              h('dd', null, 'c1275515'),
              h('dt', null, '面板宽'),
              h('dd', null, String(width)),
              h('dt', null, 'slot 来源'),
              h('dd', null, slotSource),
            ),
            h('div', { className: 'ftm-hint' }, `宿主可见 slot（${slotNames.length}）：`),
            h(
              'ul',
              { className: 'ftm-slots' },
              slotNames.length
                ? slotNames.slice(0, 200).map((n) => h('li', { key: n }, n))
                : h('li', null, '（未找到枚举 API，见 docs/HOST.md 探针 P1）'),
            ),
          ),
        )
      }
    }

    return {
      // 只依赖 slots：拿不到就整个不激活，而不是抛错拖垮宿主。
      inject: ['slots'],
      apply(ctx) {
        const Panel = makePanel(ctx)

        // 声明 → 注册：inject 在 owner 声明出现（或重建）时装一次，dispose 时自动撤。
        ctx.effect(() =>
          ctx.slots.inject('shell.overlay', () =>
            ctx.slots.register(
              { name: 'shell.overlay', id: 'freethought-map-panel' },
              Panel,
            ),
          ),
        )
      },
    }
  },
})
