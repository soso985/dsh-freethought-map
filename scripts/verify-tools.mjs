/**
 * 卡 6 只读工具自测 —— 用**宿主真实的** `ToolRuntime.register` 校验我们的工具定义。
 *
 * 为什么这一套特别有价值：`ctx.tools.register` 有两道真实校验
 * （`output.render` 必须是函数；schema 要过 `assertSupportedJsonSchema` 的白名单），
 * 而那个白名单**不含 `maximum` / `minimum`** 这类关键字 —— 手写 schema 很容易踩。
 * 直接把宿主那份 `dsh-tools` + `cordis` 载进来真跑一遍，比读文档猜可靠得多。
 *
 * 注意：这是唯一一处允许 `import` 裸包名的地方，它是**测试脚本**而不是插件代码。
 * 插件本身绝不能 import 裸包名（宿主 runtime 解析不到，见 docs/HOST.md §3.9）。
 *
 * 用法：
 *   node scripts/verify-tools.mjs
 */
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { join } from 'node:path'

import { createOverlay } from '../src/overlay/index.js'
import { addFreeLink } from '../src/overlay/links.js'
import {
  READONLY_TOOL_NAMES,
  TOOL_GET,
  TOOL_OVERVIEW,
  TOOL_SEARCH,
  buildReadonlyTools,
  registerReadonlyTools,
  renderGet,
  renderOverview,
  renderSearch,
  sessionIdFromExecution,
} from '../src/overlay/tools.js'

const results = []
let passed = 0
function test(name, fn) {
  try {
    fn()
    passed += 1
    results.push(['PASS', name, ''])
  } catch (e) {
    results.push(['FAIL', name, e.message])
  }
}

// ───────────────────────────── 夹具 ─────────────────────────────

function fixtureDoc() {
  let doc = createOverlay('session-AAAA')
  doc.nodes = {
    R: { id: 'R', kind: 'manual', parentId: null, position: { x: 0, y: 0 }, title: '中心主题', body: '' },
    A: {
      id: 'A',
      kind: 'turn',
      parentId: 'R',
      position: { x: 0, y: 120 },
      body: '关于注意力残留的一段正文',
      tags: ['认知'],
      sourceRef: { kind: 'user-message', eventId: 'u1' },
    },
    B: { id: 'B', kind: 'manual', parentId: 'A', position: { x: 0, y: 240 }, title: '' },
    C: { id: 'C', kind: 'manual', parentId: null, position: { x: 300, y: 0 }, title: '另一个顶层' },
  }
  doc.focusId = 'A'
  doc = addFreeLink(doc, 'A', 'C', { newId: () => 'L1' }).doc
  return doc
}

const derivedTitles = { A: '注意力残留', B: '被清空的节点' }

// ───────────────────────────── 会话身份（红线 8） ─────────────────────────────

test('sessionId 取自 exec.agent.session.header.id（官方同款表达式）', () => {
  assert.equal(sessionIdFromExecution({ agent: { session: { header: { id: 's-1' } } } }), 's-1')
})

test('sessionId 退化顺序：session.id 再 agent.id', () => {
  assert.equal(sessionIdFromExecution({ agent: { session: { id: 's-2' } } }), 's-2')
  assert.equal(sessionIdFromExecution({ agent: { id: 's-3' } }), 's-3')
})

test('拿不到执行上下文就返回 null（调用方必须拒绝，不得猜）', () => {
  assert.equal(sessionIdFromExecution({}), null)
  assert.equal(sessionIdFromExecution({ agent: {} }), null)
  assert.equal(sessionIdFromExecution(null), null)
  assert.equal(sessionIdFromExecution({ agent: { session: { header: { id: '' } } } }), null)
})

// ───────────────────────────── 载入宿主真实实现 ─────────────────────────────

const EXTRACT = join(process.env.TEMP || '', 'dsh-asar-extract', 'dsh', 'node_modules')

let ToolRuntime = null
let Context = null
let loadError = null
try {
  const req = createRequire(join(EXTRACT, 'noop.js'))
  const toolsMod = req(join(EXTRACT, '@deepseek-ai', 'dsh-tools', 'lib', 'index.js'))
  ToolRuntime = toolsMod.ToolRuntime || toolsMod.default
  if (typeof ToolRuntime !== 'function') {
    throw new Error('拿不到 ToolRuntime（导出：' + Object.keys(toolsMod).join(',') + '）')
  }
  const cordis = req(join(EXTRACT, '@deepseek-ai', 'cordis', 'lib', 'index.js'))
  Context = cordis.Context || (cordis.default && cordis.default.Context) || cordis.default
  if (typeof Context !== 'function') {
    throw new Error('拿不到 cordis Context（导出：' + Object.keys(cordis).join(',') + '）')
  }
} catch (e) {
  loadError = e
}

if (loadError) {
  results.push(['SKIP', '载入宿主真实的 ToolRuntime / cordis', loadError.message])
} else {
  results.push(['PASS', '载入宿主真实的 ToolRuntime / cordis', ''])
}

/**
 * 造一个够用的环境：**真的** cordis Context + 一个够用的 systemPrompt 替身。
 *
 * 为什么这个替身要"照着真实调用点做"而不是随手写：
 * `ToolRuntime` 的构造路径上 `static inject = ['systemPrompt']`，并且**无条件**调用
 * `ctx.systemPrompt.tools((context) => this.wireSchemas(context.scope))`
 * （`dsh-tools/lib/index.js:2707`）。而 `section()` / `getSectionOrder()` 只在
 * **非 native 模式**（PTC）下才走（同一份源码的 `if (this.defaultMode !== "native")`），
 * 所以我们默认的 native 模式碰不到它们 —— 但仍然给上，免得将来改配置就炸。
 *
 * `tools(provider)` 的真实语义是 `layers.effect(ctx, (layer) => layer.toolProviders.append(provider))`
 * （`dsh-system-prompt/lib/index.js:286`），所以替身里照着 append 到一个数组。
 */
function makeRuntimeEnv() {
  const ctx = new Context()
  const registeredProviders = []
  ctx.provide('systemPrompt', {
    tools(provider) {
      registeredProviders.push(provider)
      return () => {}
    },
    section() {
      return () => {}
    },
    variable() {
      return () => {}
    },
    context() {
      return () => {}
    },
    getSectionOrder() {
      return 0
    },
  })
  return { ctx, registeredProviders }
}

if (ToolRuntime && Context) {
  test('三个工具定义都能通过宿主真实的 ToolRuntime.register 校验', () => {
    const runtime = new ToolRuntime(makeRuntimeEnv().ctx)
    const tools = buildReadonlyTools({ getDoc: async () => null, derivedTitles: () => ({}) })
    assert.equal(tools.length, 3)
    for (const tool of tools) runtime.register(tool)
  })

  test('output.schema 用了不支持的关键字会被拒 —— 证明校验面是活的', () => {
    // ⚠️ 一个容易搞错的点：`register()` 的 `assertSupportedJsonSchema` 只管 **output.schema**。
    // `parameters` 那道白名单在 `defineTool` 内部的 `parameterSchemaSpecToJsonSchema` 里；
    // **手写**定义（像我们这样）会绕过参数校验 —— 所以参数的规范只能靠自测守（见下面两条）。
    const runtime = new ToolRuntime(makeRuntimeEnv().ctx)
    const bad = {
      name: 'bad_tool',
      description: 'x',
      parameters: { type: 'object', properties: {}, required: [], additionalProperties: false },
      output: { schema: { type: 'integer', maximum: 5 }, render: () => [] },
      async execute() {
        return ''
      },
    }
    assert.throws(() => runtime.register(bad), /not a supported keyword|maximum/)
  })

  test('记录事实：parameters 里的非法关键字**不会**被 register 拦下', () => {
    // 这条不是"功能验证"，是**把真实差异写下来**：参数 schema 的合法性没有经过 register。
    // 所以我们必须自己守白名单 —— 下一条断言就是那个守卫。
    const runtime = new ToolRuntime(makeRuntimeEnv().ctx)
    const loose = {
      name: 'loose_params',
      description: 'x',
      parameters: {
        type: 'object',
        properties: { n: { type: 'integer', maximum: 5 } },
        required: [],
        additionalProperties: false,
      },
      output: { schema: { type: 'string' }, render: () => [] },
      async execute() {
        return ''
      },
    }
    runtime.register(loose) // 不抛，正是要记录的事实
  })

  test('自建白名单守卫：我们三个工具的 parameters 只用宿主支持的 8 个关键字', () => {
    // 与 `dsh-tools` 的 CONSTRAINT_KEYWORDS / ANNOTATION_KEYWORDS 保持一致
    const ALLOWED = new Set([
      'type',
      'oneOf',
      'properties',
      'required',
      'additionalProperties',
      'items',
      'enum',
      'const',
      'description',
      'title',
      'default',
      'examples',
    ])
    const bad = []
    const walk = (node, path) => {
      if (node === null || typeof node !== 'object') return
      if (Array.isArray(node)) {
        node.forEach((v, i) => walk(v, path + '[' + i + ']'))
        return
      }
      for (const key of Object.keys(node)) {
        if (!ALLOWED.has(key)) bad.push(path + '.' + key)
      }
      for (const key of ['properties']) {
        if (node[key] && typeof node[key] === 'object') {
          for (const [k, v] of Object.entries(node[key])) walk(v, path + '.' + key + '.' + k)
        }
      }
      for (const key of ['items', 'oneOf']) {
        if (node[key]) walk(node[key], path + '.' + key)
      }
    }
    const tools = buildReadonlyTools({ getDoc: async () => null })
    for (const t of tools) {
      walk(t.parameters, t.name + '.parameters')
      walk(t.output.schema, t.name + '.output.schema')
    }
    assert.deepEqual(bad, [], '出现宿主不支持的关键字：' + bad.join(', '))
  })

  test('缺 output.render 会被拒 —— 证明 register 的校验面是活的', () => {
    const runtime = new ToolRuntime(makeRuntimeEnv().ctx)
    const bad = {
      name: 'bad2',
      description: 'x',
      parameters: { type: 'object', properties: {}, required: [], additionalProperties: false },
      output: { schema: { type: 'string' } },
      async execute() {
        return ''
      },
    }
    assert.throws(() => runtime.register(bad))
  })
}

// ───────────────────────────── 注册面 ─────────────────────────────

test('registerReadonlyTools：只注册 3 个，且全是只读', () => {
  const registered = []
  const ctx = { tools: { register: (t) => registered.push(t) } }
  const n = registerReadonlyTools(ctx, { getDoc: async () => null })
  assert.equal(n, 3)
  assert.deepEqual(
    registered.map((t) => t.name).sort(),
    [...READONLY_TOOL_NAMES].sort(),
  )
  for (const t of registered) {
    assert.equal(typeof t.execute, 'function')
    assert.equal(t.isConcurrencySafe({}), true, '只读工具应允许并发')
  }
})

test('ctx.tools 不可用时不抛错（插件仍能激活）', () => {
  assert.equal(registerReadonlyTools({}, { getDoc: async () => null }), 0)
  assert.equal(registerReadonlyTools(null, { getDoc: async () => null }), 0)
})

// ───────────────────────────── 三个视图的内容 ─────────────────────────────

test('map_overview：带 [用户图数据] 前缀、统计与树形大纲、标出焦点', () => {
  const text = renderOverview(fixtureDoc(), { derivedTitles })
  assert.ok(text.startsWith('[用户图数据]'), text)
  assert.ok(text.includes('4 个节点'), text)
  assert.ok(text.includes('1 条自由联想线'), text)
  assert.ok(text.includes('← 焦点'), text)
  assert.ok(text.includes('中心主题'), text)
  assert.ok(text.includes('注意力残留'), '缺失注解的节点要用派生标题')
})

test('map_overview：空图给出可读说明而不是空白', () => {
  const text = renderOverview(createOverlay('s'), {})
  assert.ok(text.startsWith('[用户图数据]'))
  assert.ok(text.includes('还是空的'), text)
})

test('map_get：按 id 取详情，含父/子/联想', () => {
  const r = renderGet(fixtureDoc(), 'A', { derivedTitles })
  assert.equal(r.ok, true)
  assert.ok(r.text.includes('注意力残留'), r.text)
  assert.ok(r.text.includes('中心主题'), '要显示父节点')
  assert.ok(r.text.includes('关于注意力残留的一段正文'), '要显示正文')
  assert.ok(r.text.includes('另一个顶层'), '要显示自由联想的那一端')
})

test('map_get：按标题片段取；命中多个时报歧义并列候选（不猜）', () => {
  const doc = fixtureDoc()
  const one = renderGet(doc, '中心', { derivedTitles })
  assert.equal(one.ok, true)
  assert.ok(one.text.includes('中心主题'))

  const doc2 = fixtureDoc()
  doc2.nodes.C.title = '中心主题二号'
  const ambiguous = renderGet(doc2, '中心主题', { derivedTitles })
  assert.equal(ambiguous.ok, false)
  assert.ok(ambiguous.error.includes('匹配到 2 个节点'), ambiguous.error)
})

test('map_get：找不到时给可读的拒绝（不抛异常给模型）', () => {
  const r = renderGet(fixtureDoc(), '不存在的名字', { derivedTitles })
  assert.equal(r.ok, false)
  assert.ok(r.error.includes('没有找到'), r.error)
})

test('map_get：空 selector 被拒', () => {
  assert.equal(renderGet(fixtureDoc(), '', {}).ok, false)
  assert.equal(renderGet(fixtureDoc(), '   ', {}).ok, false)
})

test('map_search：命中标题/正文/标签，带 id 与片段', () => {
  const doc = fixtureDoc()
  const byTitle = renderSearch(doc, '注意力', { derivedTitles })
  assert.equal(byTitle.ok, true)
  assert.ok(byTitle.text.includes('注意力残留'), byTitle.text)

  const byTag = renderSearch(doc, '认知', { derivedTitles })
  assert.ok(byTag.hits >= 1, '标签也要能被搜到')

  const byBodyText = renderSearch(doc, '正文', { derivedTitles })
  assert.ok(byBodyText.hits >= 1, '正文也要能被搜到')
})

test('map_search：无命中给出可读说明；空查询被拒', () => {
  const doc = fixtureDoc()
  const none = renderSearch(doc, 'zzz不存在zzz', { derivedTitles })
  assert.equal(none.ok, true)
  assert.equal(none.hits, 0)
  assert.ok(none.text.includes('没有找到'))

  assert.equal(renderSearch(doc, '', {}).ok, false)
})

test('显示名三态：注解为空串时用占位，不回退派生标题', () => {
  const doc = fixtureDoc()
  const r = renderGet(doc, 'B', { derivedTitles })
  assert.equal(r.ok, true)
  assert.ok(r.text.includes('（未命名）'), '空注解应显示占位')
  assert.ok(!r.text.includes('被清空的节点'), '不得回退到派生标题')
})

// ───────────────────────────── 红线：拿不到会话就拒绝 ─────────────────────────────

test('红线：执行上下文里没有会话，三个工具都拒绝调用（绝不读别的会话）', async () => {
  const tools = buildReadonlyTools({ getDoc: async () => fixtureDoc() })
  for (const tool of tools) {
    const r = await tool.execute({ selector: 'A', query: 'x' }, {})
    assert.equal(r.ok, false, tool.name + ' 必须拒绝')
    assert.ok(r.error.includes('无法确定'), tool.name + '：' + r.error)
  }
})

test('红线：getDoc 只按执行上下文给的会话 id 取图，不读任何当前会话', async () => {
  const asked = []
  const tools = buildReadonlyTools({
    getDoc: async (sid) => {
      asked.push(sid)
      return fixtureDoc()
    },
  })
  const exec = { agent: { session: { header: { id: 'session-BBBB' } } } }
  await tools[0].execute({}, exec)
  await tools[1].execute({ selector: 'A' }, exec)
  await tools[2].execute({ query: '注意力' }, exec)
  assert.deepEqual(asked, ['session-BBBB', 'session-BBBB', 'session-BBBB'])
})

test('getDoc 抛错时返回可读拒绝，不把异常抛给模型', async () => {
  const tools = buildReadonlyTools({
    getDoc: async () => {
      throw new Error('领域没打开')
    },
  })
  const r = await tools[0].execute({}, { agent: { session: { header: { id: 's' } } } })
  assert.equal(r.ok, false)
  assert.ok(r.error.includes('领域没打开'))
})

test('该会话还没有图，给可读拒绝（不是空结果）', async () => {
  const tools = buildReadonlyTools({ getDoc: async () => null })
  const r = await tools[0].execute({}, { agent: { session: { header: { id: 's' } } } })
  assert.equal(r.ok, false)
  assert.ok(r.error.includes('还没有图'))
})

// ───────────────────────────── 红线：没有写工具 ─────────────────────────────

test('红线：注册的工具里没有任何写操作（名字与描述都只有读）', () => {
  const tools = buildReadonlyTools({ getDoc: async () => null })
  const names = tools.map((t) => t.name)
  assert.deepEqual(names, [TOOL_OVERVIEW, TOOL_GET, TOOL_SEARCH])
  for (const n of names) {
    assert.ok(
      !/add|create|set|link|move|hide|delete|remove|update|write|insert/i.test(n),
      '工具名不得含写操作词汇：' + n,
    )
  }
  for (const t of tools) assert.ok(t.description.includes('只读'), t.name + ' 描述应标明只读')
})

// ───────────────────────────── 限额（规格 §10.4） ─────────────────────────────

test('限额：概览行数有上限，超出要截断并说明', () => {
  const doc = createOverlay('s')
  const nodes = {}
  for (let i = 0; i < 120; i += 1) {
    nodes['n' + i] = {
      id: 'n' + i,
      kind: 'manual',
      parentId: null,
      position: { x: 0, y: 0 },
      title: '节点' + i,
    }
  }
  doc.nodes = nodes
  const text = renderOverview(doc, {})
  const bodyLines = text.split('\n').length
  assert.ok(bodyLines <= 60 + 4, '概览不该无限长，实际 ' + bodyLines + ' 行')
  assert.ok(text.includes('截断'), '截断要说明')
})

test('限额：搜索最多列 20 条，超出要说明总数', () => {
  const doc = createOverlay('s')
  const nodes = {}
  for (let i = 0; i < 40; i += 1) {
    nodes['n' + i] = {
      id: 'n' + i,
      kind: 'manual',
      parentId: null,
      position: { x: 0, y: 0 },
      title: '共同的词' + i,
    }
  }
  doc.nodes = nodes
  const r = renderSearch(doc, '共同的词', {})
  assert.equal(r.hits, 40)
  const listed = r.text.split('\n').filter((l) => l.startsWith('- ')).length
  assert.equal(listed, 20, '只列 20 条')
  assert.ok(r.text.includes('共 40 条命中'), '要告诉模型总共有多少')
})

test('限额：节点正文截断到 500 字', () => {
  const doc = fixtureDoc()
  doc.nodes.A.body = 'y'.repeat(900)
  const r = renderGet(doc, 'A', { derivedTitles })
  const bodyLine = r.text.split('\n').find((l) => l.startsWith('正文：'))
  assert.ok(bodyLine.length <= 500 + 8, '正文行不该超长，实际 ' + bodyLine.length)
  assert.ok(bodyLine.endsWith('…'), '截断要有省略号')
})

// ───────────────────────────── 报告 ─────────────────────────────
const fails = results.filter(([s]) => s === 'FAIL')
const pad = Math.max(...results.map(([, n]) => n.length))
console.log('')
for (const [status, name, msg] of results) {
  console.log(`  ${status}  ${name.padEnd(pad)}${msg ? '  ← ' + msg : ''}`)
}
console.log('')
console.log(`只读工具自测：${passed} 通过 / ${fails.length} 失败（共 ${results.length} 条）`)
process.exit(fails.length ? 1 : 0)
