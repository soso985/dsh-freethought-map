/**
 * 只读三工具（卡 6）—— `map_overview` / `map_get` / `map_search`。
 *
 * 规格来源：`docs/01-产品与技术规格.md` §3 红线 2（模型只读图）、§10.4（短上下文与工具限额）。
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * 两条铁律，这个文件的存在就是为了守住它们：
 *
 *   1. **只有只读工具**。没有 add / link / move / hide / delete 之类能改图的工具 ——
 *      「模型写结构」是红线。写工具一旦存在，无论提示词怎么写，模型都可能用它。
 *
 *   2. **会话身份来自执行上下文**，不是浏览器当前打开的会话
 *      （规格 §3 红线 8）。取的表达式是 `exec.agent?.session.header.id`
 *      —— 见 `dsh-tool-fs-search/lib/index.js:287`、`dsh-tool-todo/lib/index.js:172`
 *      的官方同款写法。取不到就**拒绝调用**，绝不猜、绝不退回"当前会话"。
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * 实现细节（都是从宿主源码核对的，不是猜的）：
 *
 *   · `ctx.tools.register(definition)` 的校验（`dsh-tools/lib/index.js` 的 `register`）：
 *       必须 `output { schema, render, presentationMeta? }`，其中 `output.render` 是函数；
 *       `schema` 要过 `assertSupportedJsonSchema`。
 *   · **支持的关键字白名单**：`type` / `oneOf` / `properties` / `required` /
 *       `additionalProperties` / `items` / `enum` / `const`，加四个注解
 *       `description` / `title` / `default` / `examples`。
 *       ⚠️ **没有 `maximum` / `minimum`** —— 上限只能写在 `description` 里靠自己截断。
 *   · 不 import `defineTool`：它只是把 DSL 编译成 JSON Schema（`parameterSchemaSpecToJsonSchema`），
 *       我们直接手写编译后的形状，少一个裸包依赖（宿主 runtime 解析不到任何裸包名）。
 */

/** 注入文案与工具输出统一的标记（规格 §10.4：均标记为用户图数据）。 */
export const USER_GRAPH_PREFIX = '[用户图数据]'

/** 各工具的返回条数上限（规格 §10.4 的限额精神：工具输出必须短）。 */
export const LIMITS = {
  overviewLines: 60,
  getBodyChars: 500,
  getNodes: 5,
  searchHits: 20,
  searchSnippet: 80,
}

/** 工具名常量（避免手写字符串漂移）。 */
export const TOOL_OVERVIEW = 'map_overview'
export const TOOL_GET = 'map_get'
export const TOOL_SEARCH = 'map_search'

// ───────────────────────────── 会话身份（红线 8） ─────────────────────────────

/**
 * 从执行上下文里取会话 id。
 *
 * **这是唯一允许的来源。** 取不到就返回 null，调用方必须拒绝这次调用 ——
 * 绝不 fallback 到"浏览器当前打开的会话"（那会让会话 A 的 agent 读到 B 的图）。
 *
 * @param {any} exec ToolExecution / ToolRunContext
 * @returns {string | null}
 */
export function sessionIdFromExecution(exec) {
  const agent = exec && exec.agent
  if (!agent) return null
  const session = agent.session
  if (session) {
    if (session.header && typeof session.header.id === 'string' && session.header.id) {
      return session.header.id
    }
    if (typeof session.id === 'string' && session.id) return session.id
  }
  // agent.id 也是 SessionId（`Agent { readonly id: SessionId; … }`），作为最后一道
  if (typeof agent.id === 'string' && agent.id) return agent.id
  return null
}

/** 统一的拒绝返回（工具不抛异常给模型，而是回一条可读的说明）。 */
function refuse(reason) {
  return { ok: false, error: reason }
}

// ───────────────────────────── 纯函数：三个视图 ─────────────────────────────

/** 显示名三态：注解非空用注解；`""` 用占位（**不回退**派生）；缺失才用派生标题。 */
function nameOf(node, derivedTitles) {
  const annotated = node && node.title
  if (annotated !== undefined && annotated !== null) {
    return annotated === '' ? '（未命名）' : annotated
  }
  const d = derivedTitles && node ? derivedTitles[node.id] : undefined
  return d ? d : '（未命名）'
}

/**
 * 大纲视图：树形缩进 + 统计。**只读**，不改任何东西。
 *
 * @param {import('./index.js').OverlayDoc} doc
 * @param {{ derivedTitles?: Record<string,string> }} [opts]
 * @returns {string}
 */
export function renderOverview(doc, opts = {}) {
  const derived = opts.derivedTitles || {}
  if (!doc || !doc.nodes || Object.keys(doc.nodes).length === 0) {
    return USER_GRAPH_PREFIX + '\n这张图还是空的（没有节点）。'
  }

  const kids = new Map()
  for (const node of Object.values(doc.nodes)) {
    const list = kids.get(node.parentId) || []
    list.push(node.id)
    kids.set(node.parentId, list)
  }
  const roots = Object.values(doc.nodes)
    .filter((n) => !n.parentId || !doc.nodes[n.parentId])
    .map((n) => n.id)

  const lines = []
  let truncated = false
  const walk = (id, depth) => {
    if (lines.length >= LIMITS.overviewLines) {
      truncated = true
      return
    }
    const node = doc.nodes[id]
    if (!node) return
    const mark = doc.focusId === id ? '← 焦点' : ''
    const kind = node.kind === 'manual' ? '手建' : '回合'
    lines.push(
      '  '.repeat(depth) + '- [' + kind + '] ' + nameOf(node, derived) + (mark ? '  ' + mark : ''),
    )
    for (const c of kids.get(id) || []) walk(c, depth + 1)
  }
  for (const r of roots) walk(r, 0)

  const total = Object.keys(doc.nodes).length
  const head =
    USER_GRAPH_PREFIX +
    '\n图概览：' +
    String(total) +
    ' 个节点、' +
    String(doc.freeLinks.length) +
    ' 条自由联想线' +
    (doc.focusId ? '，当前焦点是标了「← 焦点」的那个' : '，当前没有设焦点')
  const tail = truncated ? '\n（还有更多节点，已截断到 ' + String(LIMITS.overviewLines) + ' 行）' : ''
  return head + '\n' + lines.join('\n') + tail
}

/**
 * 取单个节点的详情 + 它的直接关联。
 *
 * `id` 可以是节点 id，也可以是**标题片段**（用户口头引用时更方便）。
 * 匹配到多个时报歧义并列出候选，**不猜**。
 *
 * @param {import('./index.js').OverlayDoc} doc
 * @param {string} selector
 * @param {{ derivedTitles?: Record<string,string> }} [opts]
 * @returns {{ ok: true, text: string } | { ok: false, error: string }}
 */
export function renderGet(doc, selector, opts = {}) {
  const derived = opts.derivedTitles || {}
  if (!doc || !doc.nodes) return refuse('这张图还没有任何节点。')
  const want = String(selector || '').trim()
  if (!want) return refuse('需要给出节点 id 或标题片段。')

  let target = doc.nodes[want]
  if (!target) {
    const lower = want.toLowerCase()
    const hits = Object.values(doc.nodes).filter((n) =>
      nameOf(n, derived).toLowerCase().includes(lower),
    )
    if (hits.length === 0) return refuse('没有找到匹配「' + want + '」的节点。')
    if (hits.length > 1) {
      return refuse(
        '「' +
          want +
          '」匹配到 ' +
          String(hits.length) +
          ' 个节点，请说得更具体一些：' +
          hits
            .slice(0, LIMITS.getNodes)
            .map((n) => nameOf(n, derived))
            .join('、'),
      )
    }
    target = hits[0]
  }

  const kids = Object.values(doc.nodes).filter((n) => n.parentId === target.id)
  const parent = target.parentId ? doc.nodes[target.parentId] : null
  const links = doc.freeLinks
    .filter((l) => l.a === target.id || l.b === target.id)
    .map((l) => doc.nodes[l.a === target.id ? l.b : l.a])
    .filter(Boolean)

  const body = typeof target.body === 'string' ? target.body : ''
  const clipped = body.length > LIMITS.getBodyChars ? body.slice(0, LIMITS.getBodyChars) + '…' : body

  const parts = [
    USER_GRAPH_PREFIX,
    '节点：' + nameOf(target, derived) + '（' + (target.kind === 'manual' ? '手建' : '回合') + '）',
    'id：' + target.id,
    '父节点：' + (parent ? nameOf(parent, derived) : '（顶层）'),
    '正文：' + (clipped || '（空）'),
  ]
  if (kids.length) {
    parts.push(
      '子节点（' +
        String(kids.length) +
        '）：' +
        kids
          .slice(0, LIMITS.getNodes)
          .map((n) => nameOf(n, derived))
          .join('、') +
        (kids.length > LIMITS.getNodes ? ' 等' : ''),
    )
  }
  if (links.length) {
    parts.push(
      '自由联想（' +
        String(links.length) +
        '）：' +
        links
          .slice(0, LIMITS.getNodes)
          .map((n) => nameOf(n, derived))
          .join('、') +
        (links.length > LIMITS.getNodes ? ' 等' : ''),
    )
  }
  return { ok: true, text: parts.join('\n') }
}

/**
 * 全文搜索（标题 / 正文 / 标签）。
 *
 * @param {import('./index.js').OverlayDoc} doc
 * @param {string} query
 * @param {{ derivedTitles?: Record<string,string> }} [opts]
 * @returns {{ ok: true, text: string, hits: number } | { ok: false, error: string }}
 */
export function renderSearch(doc, query, opts = {}) {
  const derived = opts.derivedTitles || {}
  if (!doc || !doc.nodes) return refuse('这张图还没有任何节点。')
  const q = String(query || '').trim().toLowerCase()
  if (!q) return refuse('需要一个搜索词。')

  const hits = []
  for (const node of Object.values(doc.nodes)) {
    const name = nameOf(node, derived)
    const body = typeof node.body === 'string' ? node.body : ''
    const tags = Array.isArray(node.tags) ? node.tags.join(' ') : ''
    const hay = (name + '\n' + body + '\n' + tags).toLowerCase()
    const at = hay.indexOf(q)
    if (at < 0) continue
    // 命中位置附近截一小段做片段
    const flat = (name + ' ' + body + ' ' + tags).replace(/\s+/g, ' ')
    const pos = flat.toLowerCase().indexOf(q)
    const from = Math.max(0, pos - 20)
    const snippet = flat.slice(from, from + LIMITS.searchSnippet)
    hits.push({ node, name, snippet })
  }

  if (hits.length === 0) {
    return { ok: true, text: USER_GRAPH_PREFIX + '\n没有找到包含「' + query + '」的节点。', hits: 0 }
  }
  const lines = hits
    .slice(0, LIMITS.searchHits)
    .map((h) => '- ' + h.name + '（id: ' + h.node.id + '）：' + h.snippet)
  const tail =
    hits.length > LIMITS.searchHits
      ? '\n（共 ' + String(hits.length) + ' 条命中，只列了前 ' + String(LIMITS.searchHits) + ' 条）'
      : ''
  return {
    ok: true,
    hits: hits.length,
    text:
      USER_GRAPH_PREFIX +
      '\n命中 ' +
      String(hits.length) +
      ' 个节点：\n' +
      lines.join('\n') +
      tail,
  }
}

// ───────────────────────────── 工具定义（手写编译后的形状） ─────────────────────────────

/** 参数 schema：手写 `defineTool` 编译后的形状，只用在白名单里的关键字。 */
const OVERVIEW_PARAMS = { type: 'object', properties: {}, required: [], additionalProperties: false }
const GET_PARAMS = {
  type: 'object',
  properties: {
    selector: {
      type: 'string',
      description: '节点 id，或标题里的一个片段（片段匹配到多个节点时工具会要求你说得更具体）',
    },
  },
  required: ['selector'],
  additionalProperties: false,
}
const SEARCH_PARAMS = {
  type: 'object',
  properties: {
    query: { type: 'string', description: '搜索词，会在节点标题、正文、标签里查找' },
  },
  required: ['query'],
  additionalProperties: false,
}

/** 结果 schema：统一是「一个文本块」。`output.render` 负责把它变成模型看得见的内容。 */
const TEXT_SCHEMA = { type: 'string' }

/**
 * 把一段文本包成工具结果的 render 输出。
 * 官方形状：`render(args, value) => [{ type: 'text', text }]`。
 */
function textRender(_args, value) {
  return [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value) }]
}

/**
 * 造三个只读工具定义。
 *
 * @param {object} deps
 * @param {(sessionId: string) => Promise<import('./index.js').OverlayDoc | null>} deps.getDoc
 *        按会话取权威 overlay。**由宿主注入**，工具自己不碰存储。
 * @param {(sessionId: string) => Record<string, string>} [deps.derivedTitles]
 * @returns {any[]} 三个工具定义
 */
export function buildReadonlyTools(deps) {
  const getDoc = deps.getDoc
  const derivedFor = deps.derivedTitles || (() => ({}))

  /** 三个工具共用的前半段：取会话 → 取图。任何一步失败都返回可读的拒绝。 */
  async function withDoc(exec, fn) {
    const sessionId = sessionIdFromExecution(exec)
    if (!sessionId) {
      // 红线 8：拿不到执行上下文里的会话身份就拒绝，绝不退回"当前会话"
      return refuse(
        '无法确定这次调用属于哪个会话（执行上下文里没有 agent/session），为确保不读到别的会话的图，本次调用被拒绝。',
      )
    }
    let doc
    try {
      doc = await getDoc(sessionId)
    } catch (e) {
      return refuse('读取该会话的图失败：' + (e && e.message ? e.message : String(e)))
    }
    if (!doc) return refuse('该会话还没有图。先在右侧面板里说一句话，链就会长出来。')
    return fn(doc, sessionId)
  }

  return [
    {
      name: TOOL_OVERVIEW,
      description:
        '只读：看当前会话的图概览（节点数、自由联想数、当前焦点、树形大纲）。不会修改任何东西。',
      parameters: OVERVIEW_PARAMS,
      output: {
        schema: TEXT_SCHEMA,
        render: textRender,
      },
      // 只读 → 允许并发（官方 read 工具同款：dsh-tool-fs/lib/index.js:344）
      isConcurrencySafe: () => true,
      async execute(_args, exec) {
        return withDoc(exec, (doc, sessionId) =>
          renderOverview(doc, { derivedTitles: derivedFor(sessionId) }),
        )
      },
    },
    {
      name: TOOL_GET,
      description:
        '只读：看某个节点的详情（标题、正文、父节点、子节点、自由联想）。selector 可以是节点 id 或标题片段。不会修改任何东西。',
      parameters: GET_PARAMS,
      output: {
        schema: TEXT_SCHEMA,
        render: textRender,
      },
      isConcurrencySafe: () => true,
      async execute(args, exec) {
        return withDoc(exec, (doc, sessionId) =>
          renderGet(doc, args && args.selector, { derivedTitles: derivedFor(sessionId) }),
        )
      },
    },
    {
      name: TOOL_SEARCH,
      description:
        '只读：在节点的标题、正文、标签里搜索。不会修改任何东西。',
      parameters: SEARCH_PARAMS,
      output: {
        schema: TEXT_SCHEMA,
        render: textRender,
      },
      isConcurrencySafe: () => true,
      async execute(args, exec) {
        return withDoc(exec, (doc, sessionId) =>
          renderSearch(doc, args && args.query, { derivedTitles: derivedFor(sessionId) }),
        )
      },
    },
  ]
}

/**
 * 把三个工具注册到宿主。
 *
 * @param {any} ctx
 * @param {object} deps 见 buildReadonlyTools
 * @returns {number} 注册了几个
 */
export function registerReadonlyTools(ctx, deps) {
  if (!ctx || !ctx.tools || typeof ctx.tools.register !== 'function') return 0
  const tools = buildReadonlyTools(deps)
  for (const tool of tools) ctx.tools.register(tool)
  return tools.length
}

/** 供自测断言：这三个名字就是全部写进注册表的工具，**一个写工具都没有**。 */
export const READONLY_TOOL_NAMES = [TOOL_OVERVIEW, TOOL_GET, TOOL_SEARCH]
