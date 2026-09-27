/**
 * 「可靠打开插件面板」的可复用助手（headless CDP 用）。
 *
 * 为什么需要单独一个模块：打开面板踩过**两个叠加的坑**，都不直观：
 *
 *   1. **官方右列收起时，dockkit 的 tab 与内容根本不渲染**
 *      （`[data-dockkit-tab]` / `[data-dockkit-content]` 都是空数组）。
 *      插件面板挂在右列里，所以右列不收起来就永远看不到面板 ——
 *      而且 DOM 里**同时存在**「打开右侧边栏」和「收起右侧边栏」两个按钮，
 *      按文本找按钮会找错，必须只在 tab 数为 0 时才去点"打开"。
 *
 *   2. **`autopen-done` 标记一旦落地，自动打开逻辑就永久跳过**（按设计：
 *      用户关掉 tab 后不该被反复弹回）。测试 profile 复用时会一直带着这个标记，
 *      于是**看不到自动打开**，而不是自动打开失败 —— 极易误判成功能坏了。
 *      想验"自动打开"就必须清掉标记并刷新。
 *
 * 本模块把这两条封起来，暴露 `ensurePanelOpen()` / `openSession()`。
 */

export const AUTOPEN_KEY = 'freethought-map:autopen-done:v1'

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/**
 * @param {(expr: string) => Promise<any>} evaluate 页面内求值（返回 by value）
 * @param {(method: string, params?: object) => Promise<any>} send CDP 直发
 */
export function createPanelOpener(evaluate, send) {
  /** 当前 dockkit tab 数 */
  const tabCount = () => evaluate(`document.querySelectorAll('[data-dockkit-tab]').length`)
  const rootCount = () => evaluate(`document.querySelectorAll('[data-freethought-map-root]').length`)
  const bubbles = () => evaluate(`document.querySelectorAll('[data-chat-node-key]').length`)

  /**
   * 点会话行进入会话画面。`wantSessionId` 为空则取第一行。
   * @returns {Promise<{ok: boolean, picked?: string, bubbles?: number, have?: string[]}>}
   */
  async function openSession(wantSessionId, timeoutMs = 30000) {
    if ((await bubbles()) > 0) return { ok: true, alreadyOpen: true, bubbles: await bubbles() }
    const clicked = await evaluate(`(() => {
      const rows = [...document.querySelectorAll('[data-row-key^="session:"]')].filter(e => e.offsetParent !== null);
      const want = ${JSON.stringify(wantSessionId || '')};
      const row = want ? rows.find(e => (e.getAttribute('data-row-key') || '').includes(want)) : rows[0];
      if (!row) return { ok: false, have: rows.map(e => (e.getAttribute('data-row-key') || '').slice(0, 50)) };
      row.scrollIntoView({ block: 'center' });
      row.click();
      return { ok: true, picked: row.getAttribute('data-row-key') };
    })()`)
    if (!clicked || clicked.ok !== true) return { ok: false, have: clicked && clicked.have }
    const dl = Date.now() + timeoutMs
    while (Date.now() < dl) {
      await sleep(1000)
      if ((await bubbles()) > 0) break
    }
    return { ok: true, picked: clicked.picked, bubbles: await bubbles() }
  }

  /** 展开官方右列（只有 tab 数为 0 时才点，避免两按钮同时存在时点错）。 */
  async function expandRightRail(attempts = 4) {
    for (let i = 0; i < attempts; i += 1) {
      if ((await tabCount()) > 0) return { ok: true, tabs: await tabCount() }
      const r = await evaluate(`(() => {
        const vis = (e) => e.offsetParent !== null;
        const btn = [...document.querySelectorAll('button,[role="button"]')].filter(vis)
          .find(b => /打开右侧边栏|展开右侧|open right/i.test((b.getAttribute('aria-label')||'') + ' ' + (b.title||'')));
        if (!btn) return { clicked: false };
        btn.click();
        return { clicked: true, label: (btn.getAttribute('aria-label')||btn.title||'').trim() };
      })()`)
      await sleep(1500)
      if ((await tabCount()) > 0) return { ok: true, tabs: await tabCount(), clicked: r && r.clicked }
    }
    return { ok: false, tabs: await tabCount() }
  }

  /** 面板当前挂载在哪个会话（读面板正文里的 session-… 串）。 */
  async function panelSession() {
    return await evaluate(`(() => {
      const root = document.querySelector('[data-freethought-map-root]');
      if (!root) return null;
      const m = (root.innerText || '').match(/session-[0-9a-f-]{8,}/i);
      return m ? m[0] : null;
    })()`)
  }

  /**
   * 确保插件面板挂载，**并且挂在指定的会话上**。
   *
   * ⚠️ 「已经挂载」不等于「挂对了会话」：
   * 插件面板是**按会话**挂载的，而 `ensurePanelOpen` 早先只要看到根节点就直接返回
   * ⇒ 上一次验收留下的会话会被当成"已经准备好"，于是整轮验收在**错的会话**上跑，
   * 报出一堆莫名其妙的失败（2026-09-27 实际踩到：验注解时打开的是测试会话，
   * 面板里只有 1 行，三条断言全红）。
   *
   * 所以这里必须先比对会话；不一致就切过去（切会话会重挂面板）。
   *
   * @param {{sessionId?: string, timeoutMs?: number, forceAutopen?: boolean}} [opts]
   * @returns {Promise<{ok: boolean, how?: string, tabId?: string|null, notes: string[]}>}
   */
  async function ensurePanelOpen(opts = {}) {
    const notes = []
    const timeoutMs = opts.timeoutMs || 20000
    const want = opts.sessionId || ''

    // 已经开着**且会话对**才直接返回
    if ((await rootCount()) > 0) {
      const cur = await panelSession()
      if (!want || cur === want) return { ok: true, how: 'already-mounted', notes }
      notes.push('面板挂在 ' + cur + '，要的是 ' + want + ' → 切会话')
      const s0 = await openSession(want)
      notes.push('切会话=' + JSON.stringify(s0))
      // 切会话会重挂，等它回来
      for (let i = 0; i < 12; i += 1) {
        await sleep(1000)
        if ((await rootCount()) > 0 && (await panelSession()) === want) {
          const info = await currentTab()
          return { ok: true, how: 'switched-session', tabId: info.tabId, notes }
        }
      }
      notes.push('切会话后面板没回来，继续按"未挂载"流程走')
    }

    // 1) 进会话
    const s = await openSession(want)
    notes.push('openSession=' + JSON.stringify(s))
    if (!s.ok) return { ok: false, notes }

    // 2) 展开右列
    const e = await expandRightRail()
    notes.push('expandRightRail=' + JSON.stringify(e))
    if (!e.ok) return { ok: false, notes }

    // 3) 等一会儿（自动打开逻辑在 apply 时轮询 mounted，间隔 500ms）
    for (let i = 0; i < Math.ceil(timeoutMs / 1500); i += 1) {
      await sleep(1500)
      if ((await rootCount()) > 0) {
        const info = await currentTab()
        return { ok: true, how: 'autopened', tabId: info.tabId, notes }
      }
    }

    // 4) 还没出来 → 多半是 autopen 标记已落地（设计上会永久跳过）。清掉刷新重来。
    if (opts.forceAutopen === false) {
      notes.push('未挂载，且不允许刷新重来')
      return { ok: false, notes }
    }
    notes.push('未自动挂载 → 清 autopen 标记并刷新')
    const cleared = await evaluate(`(() => {
      try {
        const before = window.localStorage.getItem(${JSON.stringify(AUTOPEN_KEY)});
        window.localStorage.removeItem(${JSON.stringify(AUTOPEN_KEY)});
        return { before, after: window.localStorage.getItem(${JSON.stringify(AUTOPEN_KEY)}) };
      } catch (e) { return { err: String(e && e.message) }; }
    })()`)
    notes.push('clearFlag=' + JSON.stringify(cleared))

    await send('Page.enable')
    await send('Page.reload', { ignoreCache: true })
    await sleep(12000)

    const s2 = await openSession(want)
    notes.push('reload 后 openSession=' + JSON.stringify(s2))
    const e2 = await expandRightRail()
    notes.push('reload 后 expandRightRail=' + JSON.stringify(e2))

    for (let i = 0; i < Math.ceil(timeoutMs / 1500); i += 1) {
      await sleep(1500)
      if ((await rootCount()) > 0) {
        const info = await currentTab()
        return { ok: true, how: 'autopened-after-reload', tabId: info.tabId, notes }
      }
    }
    return { ok: false, notes }
  }

  /** 当前我们的 tab 在 dockkit 里的样子（id / 是否选中）。 */
  async function currentTab() {
    return await evaluate(`(() => {
      const tabs = [...document.querySelectorAll('[data-dockkit-tab]')].map(t => ({
        id: t.getAttribute('data-dockkit-tab'),
        title: (t.querySelector('[data-dockkit-tab-title]') || {}).textContent || '',
        selected: t.getAttribute('aria-selected'),
      }));
      const mine = tabs.find(t => /FreeThought/i.test(t.title));
      return { tabs, tabId: mine ? mine.id : null, selected: mine ? mine.selected : null };
    })()`)
  }

  /** 点开我们的 tab（面板已挂载但可能不是当前 tab 时用）。 */
  async function focusOurTab() {
    return await evaluate(`(() => {
      const tabs = [...document.querySelectorAll('[data-dockkit-tab]')];
      const mine = tabs.find(t => /FreeThought/i.test(((t.querySelector('[data-dockkit-tab-title]') || {}).textContent || '')));
      if (!mine) return { ok: false, count: tabs.length };
      if (mine.getAttribute('aria-selected') === 'true') return { ok: true, already: true, id: mine.getAttribute('data-dockkit-tab') };
      mine.click();
      return { ok: true, clicked: true, id: mine.getAttribute('data-dockkit-tab') };
    })()`)
  }

  return { openSession, expandRightRail, ensurePanelOpen, currentTab, focusOurTab, panelSession, tabCount, rootCount, bubbles }
}
