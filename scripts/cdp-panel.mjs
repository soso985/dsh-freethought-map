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
  // `rootCount` 定义在下面（它要过滤**可见**的根 —— 隐藏的根不算"面板已挂载"）
  const bubbles = () => evaluate(`document.querySelectorAll('[data-chat-node-key]').length`)

  /**
   * 官方正文容器当前显示的会话 id（`[data-conversation-session]`）。
   *
   * 这是判断「我到底进了哪个会话」的**权威依据** —— 比"页面上有没有气泡"可靠得多。
   */
  async function conversationSession() {
    return await evaluate(`(() => {
      const els = [...document.querySelectorAll('[data-conversation-session]')];
      const vis = els.find(e => e.offsetParent !== null) || els[0];
      return vis ? vis.getAttribute('data-conversation-session') : null;
    })()`)
  }

  /**
   * 点会话行进入会话画面。
   *
   * @param {string} wantSessionId 目标会话；**为空时退化**为"第一个可见会话行"
   * @returns {Promise<{ok: boolean, picked?: string, have?: string[], switched?: boolean, now?: string|null, note?: string}>}
   *
   * ⚠️ 早先这里的早退判据是「页面上有没有气泡」—— 它与 `wantSessionId` **无关**。
   * 后果：残留会话**恰好有聊天记录**时，函数直接 `alreadyOpen` 返回、**根本没点**，
   * 于是调用方以为已经切到目标会话，实际还停在旧会话上；
   * 而 `ensurePanelOpen` 随后看到面板根节点存在就报 `ok:true` —— **静默跑错会话**。
   * （真机实证：`verify-session` 把测试节点写进了两个**不该碰**的空白会话。）
   *
   * 现在改成**先看当前会话对不对**：对了才早退；不对就**必须真的点**，
   * 点完再**核实**（核实不过就报 ok:false，不假装成功）。
   */
  async function openSession(wantSessionId, timeoutMs = 30000) {
    const want = wantSessionId || ''
    const now = await conversationSession()
    if (want && now === want) {
      return { ok: true, alreadyOpen: true, switched: false, now, bubbles: await bubbles() }
    }
    if (!want && now !== null && (await bubbles()) > 0) {
      // 没指定目标：只要已经在一个有内容的会话里就算就绪（保持旧的宽松行为）
      return { ok: true, alreadyOpen: true, switched: false, now, bubbles: await bubbles() }
    }

    const clicked = await evaluate(`(() => {
      const rows = [...document.querySelectorAll('[data-row-key^="session:"]')].filter(e => e.offsetParent !== null);
      const want = ${JSON.stringify(want)};
      const row = want ? rows.find(e => (e.getAttribute('data-row-key') || '').includes(want)) : rows[0];
      if (!row) return { ok: false, have: rows.map(e => (e.getAttribute('data-row-key') || '').slice(0, 50)) };
      row.scrollIntoView({ block: 'center' });
      row.click();
      return { ok: true, picked: row.getAttribute('data-row-key') };
    })()`)
    if (!clicked || clicked.ok !== true) {
      return { ok: false, have: clicked && clicked.have, note: '没找到目标会话行' }
    }

    // 等：既要等到有内容，也要等到**会话 id 对上**
    const dl = Date.now() + timeoutMs
    let last = null
    while (Date.now() < dl) {
      await sleep(1000)
      last = await conversationSession()
      if (!want) {
        if ((await bubbles()) > 0) break
      } else if (last === want && (await bubbles()) >= 0) {
        break
      }
    }
    const nowAfter = await conversationSession()
    const b = await bubbles()
    if (want && nowAfter !== want) {
      // **不假装成功** —— 这正是早先那个洞的根源
      return {
        ok: false,
        picked: clicked.picked,
        switched: true,
        now: nowAfter,
        bubbles: b,
        note: '点了会话行，但正文容器的会话 id 仍是 ' + JSON.stringify(nowAfter) + '，期望 ' + JSON.stringify(want),
      }
    }
    return { ok: true, picked: clicked.picked, switched: true, now: nowAfter, bubbles: b }
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

  /**
   * 面板的**所有**根节点及其可见性。
   *
   * 为什么不能只 `querySelector`：插件自己写着「同一个 pane 组件可能同时为多个会话挂载
   * （后台只是 hidden）」。只取第一个可能读到**隐藏的那个**，于是"面板显示的会话"
   * 与"实际可见的会话"对不上 —— 又一种静默跑错会话。
   */
  async function allRoots() {
    return await evaluate(`(() => {
      return [...document.querySelectorAll('[data-freethought-map-root]')].map(r => ({
        visible: r.offsetParent !== null,
        session: ((r.innerText || '').match(/session-[0-9a-f-]{8,}/i) || [null])[0],
        rows: r.querySelectorAll('[data-ftm-node]').length,
      }));
    })()`)
  }

  /** 可见的面板根数量（0 = 还没挂载）。 */
  const rootCount = async () =>
    await evaluate(`[...document.querySelectorAll('[data-freethought-map-root]')].filter(r => r.offsetParent !== null).length`)

  /** 面板**可见那个根**挂载在哪个会话（读它正文里的 session-… 串）。 */
  async function panelSession() {
    return await evaluate(`(() => {
      const roots = [...document.querySelectorAll('[data-freethought-map-root]')];
      const root = roots.find(r => r.offsetParent !== null) || roots[0];
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

    /** 抽查一次「面板可见根」与「正文容器」的会话是否都等于 want。 */
    const bothRight = async () => {
      const p = await panelSession()
      const c = await conversationSession()
      const n = await rootCount()
      if (want) return n > 0 && p === want && c === want
      return n > 0
    }

    // 已经开着**且会话对**才直接返回
    if ((await rootCount()) > 0) {
      const roots = await allRoots()
      if (roots.length > 1) notes.push('⚠️ 面板有 ' + roots.length + ' 个根（' + JSON.stringify(roots) + '）—— 只认可见的那个')
      if (await bothRight()) return { ok: true, how: 'already-mounted', notes }

      const cur = await panelSession()
      notes.push('面板挂在 ' + cur + '，要的是 ' + want + ' → 切会话')
      const s0 = await openSession(want)
      notes.push('切会话=' + JSON.stringify(s0))
      for (let i = 0; i < 12; i += 1) {
        await sleep(1000)
        if (await bothRight()) {
          const info = await currentTab()
          return { ok: true, how: 'switched-session', tabId: info.tabId, notes }
        }
      }
      notes.push('切会话后面板没回来（或会话仍不对），继续按"未挂载"流程走')
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
      if (await bothRight()) {
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
      if (await bothRight()) {
        const info = await currentTab()
        return { ok: true, how: 'autopened-after-reload', tabId: info.tabId, notes }
      }
    }
    // **不假装成功**：把最终状态报出来，让调用方能判断
    return {
      ok: false,
      notes: notes.concat([
        '最终 panelSession=' + JSON.stringify(await panelSession()),
        '最终 conversationSession=' + JSON.stringify(await conversationSession()),
        '最终可见根数=' + String(await rootCount()),
      ]),
    }
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

  return {
    openSession,
    expandRightRail,
    ensurePanelOpen,
    currentTab,
    focusOurTab,
    panelSession,
    conversationSession,
    allRoots,
    tabCount,
    rootCount,
    bubbles,
  }
}
