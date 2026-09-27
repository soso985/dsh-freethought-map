/**
 * 客户端一半的自测 —— 在 Node 里用**真实的 React**（宿主浏览器模块表里也是同一个）
 * 把探针面板渲染成 HTML，从而在不烧 token、不开浏览器的前提下回答两个问题：
 *
 *   1. `apply(ctx)` 到底登记了什么？（tab 类型 + 右列席位，且 key 与 id 一致）
 *   2. 那个组件渲染出来长什么样？（根节点标记 / 收展 / 宽度 / 主题 token / 无内联写死色）
 *
 * 这**不能**替代真浏览器验收：官方 skill 明说「安装与 slot 注册成立，不等于用户看得见」。
 * 真浏览器那一步见 scripts/verify-render.ps1。
 *
 * React 用宿主 runtime 里那一份，避免"测试用的 React 和宿主的不是同一个"。
 *
 * 用法：
 *   node scripts/verify-client.mjs
 */
import { existsSync, readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import vm from 'node:vm'

const here = dirname(fileURLToPath(import.meta.url))
const root = resolve(here, '..')

const RUNTIME = 'E:\\Harness\\resources\\runtime\\primary-runtime\\dependencies\\node'
const EXTRACT = join(process.env.TEMP ?? '', 'dsh-asar-extract')
const DSH_NM = join(EXTRACT, 'dsh', 'node_modules')
const PROFILES_NM = 'C:\\Users\\Administrator\\.dsh\\profiles\\node_modules'
const DESKTOP_NM = 'C:\\Users\\Administrator\\.dsh\\profiles\\desktop\\node_modules'

const results = []
const ok = (m) => results.push(['PASS', m])
const bad = (m) => results.push(['FAIL', m])
const skip = (m) => results.push(['SKIP', m])

// ── 解析 React / react-dom ───────────────────────────────────────────────────
// 本包**不装** React（客户端从宿主浏览器模块表里取，官方明令不得自带一份）。
// 自测时去宿主已经装好的地方借一份同版本的：
//   1. `profiles/node_modules`  — 正常情况；但本机这些是**指向旧安装路径的失效 junction**
//      （Target 写着 `E:\Harness\DSH Desktop\...`，该目录已不存在），所以只当"文件存在"看，
//      真正 require 得靠下面的解包树。
//   2. 解包树 — 从 app.asar 解出来的真实文件，最可靠。
// 两处都借不到就 SKIP 渲染断言，而不是 FAIL —— 那不是插件的缺陷。
function resolveModule(name) {
  const tries = [
    join(EXTRACT, 'node_modules', name),
    join(DSH_NM, name),
    join(RUNTIME, 'node_modules', name),
  ]
  for (const t of tries) {
    try {
      if (existsSync(join(t, 'package.json'))) return t
    } catch {
      /* 失效 junction 会让 existsSync 抛错，跳过 */
    }
  }
  return null
}

const reactDir = resolveModule('react')
const reactDomDir = resolveModule('react-dom')
let canRender = Boolean(reactDir && reactDomDir)

let React = null
let renderToStaticMarkup = null
if (canRender) {
  try {
    React = createRequire(join(reactDir, 'noop.js'))(reactDir)
    renderToStaticMarkup = createRequire(join(reactDomDir, 'noop.js'))(join(reactDomDir, 'server.js'))
    ok(`借到宿主 React（${reactDir}）`)
  } catch (e) {
    React = null
    renderToStaticMarkup = null
    canRender = false
    skip(`借到的 React 无法加载（${e.message}）—— 跳过渲染断言`)
  }
} else {
  skip('找不到可用的 React/react-dom —— 跳过「渲染成 HTML」的断言（不影响其余检查）')
}

// ── stub 最小 window（客户端模块是给浏览器写的）──────────────────────────────
const store = new Map()
const registered = []

globalThis.window = {
  localStorage: {
    getItem: (k) => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => store.set(k, String(v)),
    removeItem: (k) => store.delete(k),
  },
  addEventListener() {},
  removeEventListener() {},
  __ModuleLoader__: {
    mode: 'queue',
    load(reg) {
      registered.push(reg)
      return reg
    },
  },
}

// ── 载入客户端一半 ───────────────────────────────────────────────────────────
// ⚠️ src/client/index.js **不是 ES 模块**（宿主当普通脚本注入页面，见该文件顶部注释），
// 所以不能 `import`，也不能用 import()。这里用 vm.Script 按**脚本**语义编译并执行，
// 只提供 window / React 两个全局，其余一律不给 —— 顺带证明了它没有偷偷依赖别的东西。
const clientPath = join(root, 'src', 'client', 'index.js')
if (!existsSync(clientPath)) {
  console.error('找不到 src/client/index.js')
  process.exit(2)
}
const clientSource = readFileSync(clientPath, 'utf8')

// 硬红线：客户端 bundle 里出现 export/import，浏览器会直接抛 SyntaxError
if (/^\s*(export|import)\s/m.test(clientSource)) {
  bad('客户端源码里出现 export/import —— 它会被当普通脚本注入，浏览器会抛 SyntaxError')
} else {
  ok('客户端源码里没有 export/import（符合普通脚本约定）')
}

const sandboxWindow = {
  localStorage: {
    getItem: (k) => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => store.set(k, String(v)),
    removeItem: (k) => store.delete(k),
  },
  addEventListener() {},
  removeEventListener() {},
  __ModuleLoader__: {
    mode: 'queue',
    load(reg) {
      registered.push(reg)
      return reg
    },
  },
}

const sandbox = { window: sandboxWindow, console, setTimeout, clearTimeout }
try {
  vm.createContext(sandbox)
  new vm.Script(clientSource, { filename: clientPath }).runInContext(sandbox)
  ok('客户端脚本按普通脚本语义执行成功')
} catch (e) {
  bad(`客户端脚本执行失败：${e.message}`)
}

if (registered.length === 1) ok('模块载入时恰好调用一次 __ModuleLoader__.load')
else bad(`__ModuleLoader__.load 被调用 ${registered.length} 次（应为 1）`)

const reg = registered[0]
if (!reg) {
  console.error('没有拿到注册对象，后续断言无法进行')
  process.exit(1)
}
if (reg.id === 'dsh-freethought-map') ok(`module id = ${reg.id}`)
else bad(`module id 是 ${reg.id}，应为 dsh-freethought-map`)

// ── 跑 factory，拿到 plugin face ─────────────────────────────────────────────
// React 借不到时给一个"一旦真被调用就报错"的替身：这样 module id / 注册结构 /
// 样式隔离这些断言仍然能跑，只有"渲染成 HTML"会 SKIP。
const reactStub = new Proxy(
  {},
  {
    get(_t, prop) {
      if (prop === 'createElement') return () => null
      if (prop === 'useState') return (v) => [typeof v === 'function' ? v() : v, () => {}]
      if (prop === 'useEffect' || prop === 'useLayoutEffect') return () => {}
      if (prop === 'useRef') return (v) => ({ current: v })
      if (prop === 'useCallback') return (f) => f
      if (prop === 'useMemo') return (f) => f()
      return undefined
    },
  },
)

const fakeRequire = (name) => {
  if (name === 'react' || name === 'react/jsx-runtime') return React ?? reactStub
  throw new Error(`客户端 bundle 请求了未声明的外部模块：${name}（应写进 dsh.client.external）`)
}

let plugin = null
try {
  plugin = reg.factory(fakeRequire)
} catch (e) {
  bad(`factory 抛错：${e.message}`)
}

if (typeof plugin?.apply === 'function') ok('factory 返回带 apply() 的插件面')
else bad('factory 没有返回 apply()')

const expectedInject = ['slots', 'sidebarRight', 'sidebarRightTabs']
const got = plugin?.inject ?? []
if (JSON.stringify([...got].sort()) === JSON.stringify([...expectedInject].sort())) {
  ok(`运行时 inject = ${JSON.stringify(got)}`)
} else {
  bad(`运行时 inject = ${JSON.stringify(got)}，期望 ${JSON.stringify(expectedInject)}`)
}

// ── 跑 apply(ctx)，记录登记了什么 ────────────────────────────────────────────
const slotRegistrations = []
const tabTypeRegistrations = []
const effects = []

const ctx = {
  effect(fn, label) {
    effects.push(label)
    return fn()
  },
  sidebarRightTabs: {
    register(decl) {
      tabTypeRegistrations.push(decl)
      return () => {}
    },
  },
  slots: {
    inject(key, cb) {
      slotRegistrations.push({ viaInject: key, ran: false })
      const d = cb()
      slotRegistrations[slotRegistrations.length - 1].ran = true
      return d
    },
    register(options, Component) {
      slotRegistrations.push({ options, Component })
      return () => {}
    },
  },
}

try {
  plugin.apply(ctx)
  ok('apply(ctx) 未抛错')
} catch (e) {
  bad(`apply(ctx) 抛错：${e.message}`)
}

// tab 类型
const tabType = tabTypeRegistrations[0]
if (tabTypeRegistrations.length === 1 && tabType) ok('登记了恰好 1 个 sidebarRightTabs 类型')
else bad(`登记了 ${tabTypeRegistrations.length} 个 tab 类型（应为 1）`)

if (tabType) {
  if (tabType.id === tabType.kind && tabType.kind === 'freethoughtmap') {
    ok('tab 的 id === kind === freethoughtmap（右列要求 id 与正文 key 一致）')
  } else {
    bad(`tab id/kind 异常：id=${tabType.id} kind=${tabType.kind}`)
  }
  if (typeof tabType.canOpen === 'function' && tabType.canOpen('freethoughtmap://session')) {
    ok('canOpen 认领自己的地址')
  } else {
    bad('canOpen 不认自己的地址')
  }
  if (typeof tabType.canOpen === 'function' && !tabType.canOpen('file:///x')) {
    ok('canOpen 不误认别人的地址')
  } else {
    bad('canOpen 会误认别人的地址')
  }
  if (typeof tabType.title === 'function' && tabType.title() === 'FreeThought Map') {
    ok('tab 标题 = FreeThought Map')
  } else {
    bad('tab 标题不对')
  }
}

// 正文席位
const bodyReg = slotRegistrations.find((r) => r.options)
if (bodyReg) {
  if (bodyReg.options.name === 'sidebar.right.pane.tab') ok('正文登记进 sidebar.right.pane.tab')
  else bad(`正文登记到了 ${bodyReg.options.name}`)
  if (bodyReg.options.key === tabType?.id) ok('正文的 key 与 tab 类型的 id 一致')
  else bad(`正文 key (${bodyReg.options.key}) 与 tab id (${tabType?.id}) 不一致`)
  if (typeof bodyReg.Component === 'function') ok('正文是一个组件')
  else bad('正文不是组件')
} else {
  bad('没有登记正文（面板不会出现在任何地方）')
}

if (slotRegistrations.some((r) => r.viaInject === 'sidebar.right.pane.tab')) {
  ok('用 ctx.slots.inject 等 sidebar.right.pane.tab 被声明（不是直接注册）')
} else {
  bad('没有对 sidebar.right.pane.tab 做 slots.inject')
}

// ── 渲染组件 ─────────────────────────────────────────────────────────────────
const Panel = bodyReg?.Component
let html = ''
if (Panel && canRender) {
  try {
    html = renderToStaticMarkup(React.createElement(Panel, {}))
    ok(`组件渲染成功（${html.length} 字节 HTML）`)
  } catch (e) {
    bad(`组件渲染抛错：${e.message}`)
  }
} else if (Panel) {
  skip('无 React，未渲染组件')
}

const checks = [
  ['带根节点标记 data-freethought-map-root', /data-freethought-map-root=""/],
  ['带拖宽热区 .ftm-resizer', /class="ftm-resizer"/],
  ['带标题栏 .ftm-bar 与标题文本', /class="ftm-bar"[\s\S]*FreeThought Map/],
  ['带收起按钮', /收起/],
  ['内联了本插件自己的 <style>', /<style>[\s\S]*data-freethought-map-root/],
]
if (html) {
  for (const [label, re] of checks) {
    if (re.test(html)) ok(label)
    else bad(`渲染结果缺少：${label}`)
  }
} else {
  skip('没有 HTML 可断言（见上）')
}

// 隔离硬红线：样式里不得出现全局选择器（不依赖是否渲染成功 —— 从源码里取样式文本）
const styleBody = html
  ? (html.match(/<style>([\s\S]*?)<\/style>/) ?? [, ''])[1]
  : (clientSource.match(/const CSS = `([\s\S]*?)`/) ?? [, ''])[1]

if (!styleBody) {
  bad('取不到样式文本，无法验证隔离红线')
} else {
  const cleaned = styleBody.replace(/\/\*[\s\S]*?\*\//g, '')
  const globalSelectors = [
    ['html 选择器', /(^|[},;\s])html\s*[,{]/m],
    ['body 选择器', /(^|[},;\s])body\s*[,{]/m],
    [':root 选择器', /(^|[},;\s]):root\s*[,{]/m],
    ['裸 button 选择器', /(^|[},;\s])button\s*\{/],
  ]
  for (const [label, re] of globalSelectors) {
    if (re.test(styleBody)) bad(`样式里出现全局 ${label}（会污染宿主）`)
    else ok(`样式里没有全局 ${label}`)
  }

  // 主题纪律：颜色只能走 token 或 rgba 兜底，不许写死十六进制
  const hexColors = styleBody.match(/#[0-9a-fA-F]{3,8}\b/g) ?? []
  if (hexColors.length === 0) ok('样式里没有写死的十六进制颜色（只用主题 token）')
  else bad(`样式里写死了颜色：${hexColors.join(', ')}`)

  // 每条规则都必须挂在插件根节点下。
  // 选择器就在「以 { 结尾的行」上 —— 本插件的样式是格式化过的多行 CSS，
  // 一行一个选择器，所以逐行判定比正则切块稳得多（也避免了跨行匹配的假阳性）。
  const selectorLines = cleaned
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.endsWith('{'))
    .map((l) => l.slice(0, -1).trim())
    .filter((sel) => sel && !sel.startsWith('@'))

  // 注意两种形态都算合格：渲染后的 HTML 里是字面量 `[data-freethought-map-root]`，
  // 而源码里是模板插值 `[${ROOT_ATTR}]`。两个都认，否则会误报。
  const scopeMarkers = ['data-freethought-map-root', '${ROOT_ATTR}']
  const unscoped = selectorLines.filter((sel) => !scopeMarkers.some((m) => sel.includes(m)))
  if (selectorLines.length === 0) {
    bad('一条 CSS 规则都没解析出来（断言无效）')
  } else if (unscoped.length === 0) {
    ok(`全部 ${selectorLines.length} 条 CSS 规则都限定在插件根节点下`)
  } else {
    bad(`有 ${unscoped.length} 条规则未限定作用域：${unscoped.slice(0, 3).join(' | ')}`)
  }
}

// ── 宽度钳制（与 overlay 侧常量必须一致）────────────────────────────────────
const overlay = await import(pathToFileURL(join(root, 'src', 'overlay', 'index.js')).href)
const { clampPanelWidth, PANEL_WIDTH_MIN, PANEL_WIDTH_MAX, PANEL_WIDTH_DEFAULT } = overlay
const widthCases = [
  [-1, PANEL_WIDTH_MIN],
  [0, PANEL_WIDTH_MIN],
  [300, 300],
  [10000, PANEL_WIDTH_MAX],
  [Number.NaN, PANEL_WIDTH_DEFAULT],
  ['abc', PANEL_WIDTH_DEFAULT],
  [420.6, 421],
]
for (const [input, want] of widthCases) {
  const gotW = clampPanelWidth(input)
  if (gotW === want) ok(`clampPanelWidth(${String(input)}) = ${want}`)
  else bad(`clampPanelWidth(${String(input)}) = ${gotW}，期望 ${want}`)
}

// ── 报告 ─────────────────────────────────────────────────────────────────────
const fails = results.filter(([s]) => s === 'FAIL')
const pad = Math.max(...results.map(([, m]) => m.length))
console.log('')
for (const [s, m] of results) console.log(`  ${s}  ${m.padEnd(pad)}`)
console.log('')
console.log(`客户端自测：${results.length - fails.length} 通过 / ${fails.length} 失败`)
process.exit(fails.length ? 1 : 0)
