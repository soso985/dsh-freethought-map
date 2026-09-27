/**
 * 探针 P5 验收脚本 —— 「构建加载」：插件 add 后，web 客户端能不能真的拿到并注册我们的 bundle。
 *
 * 这是卡 1 里唯一可以**全自动**判定的探针（P1–P4 需要人眼看页面）。
 * 它回答四个可判定问题，任何一条失败就以非零码退出：
 *
 *   1. profile 的 package.json 里，本包进了 `dsh.profile.bundles`
 *   2. 登录页的 `window.__DSH_BOOT__` 里，本包进了一个 `entries` 条目（id 必须等于包名）
 *   3. 该条目的 url 真的能取到，且内容里带 `__ModuleLoader__.load({ id: "<包名>" })`
 *   4. bundle 里带我们自己的根节点标记（证明送到的是**我们的**代码，不是别人的）
 *
 * 用法：
 *   node scripts/verify-boot.mjs <token>
 *
 * token 从 `dsh web` 的启动输出里拿：`dsh web: http://127.0.0.1:19388/?token=XXXX`
 * 端口可用 --port=<n> 覆盖（默认 19388）。
 */
import { readFileSync } from 'node:fs'

const args = process.argv.slice(2)
const token = args.find((a) => !a.startsWith('--'))
const portArg = args.find((a) => a.startsWith('--port='))
const PORT = portArg ? Number(portArg.slice('--port='.length)) : 19388
const ORIGIN = `http://127.0.0.1:${PORT}`
const PKG_NAME = 'dsh-freethought-map'
const PROFILE_PKG = 'C:\\Users\\Administrator\\.dsh\\profiles\\web\\package.json'
const ROOT_ATTR = 'data-freethought-map-root'

const results = []
const ok = (m) => results.push(['PASS', m])
const bad = (m) => results.push(['FAIL', m])

if (!token) {
  console.error('用法: node scripts/verify-boot.mjs <token> [--port=19388]')
  process.exit(2)
}

// ── 1. profile 的 bundles 清单 ────────────────────────────────────────────
try {
  const profile = JSON.parse(readFileSync(PROFILE_PKG, 'utf8'))
  const bundles = profile?.dsh?.profile?.bundles ?? []
  if (bundles.includes(PKG_NAME)) ok(`profile bundles 含 ${PKG_NAME}`)
  else bad(`profile bundles 不含 ${PKG_NAME}（实际：${JSON.stringify(bundles)}）`)

  const dep = profile?.dependencies?.[PKG_NAME]
  if (dep) ok(`profile dependencies 含 ${PKG_NAME} → ${dep}`)
  else bad(`profile dependencies 不含 ${PKG_NAME}`)
} catch (e) {
  bad(`读取 profile package.json 失败：${e.message}`)
}

// ── 2. boot payload ──────────────────────────────────────────────────────
/**
 * 宿主的 browser-trust 门禁有两步，别按「一次 fetch 就完」写：
 *   1. `GET /?token=<token>` → **303 See Other** + `set-cookie: dsh-auth-…`（HttpOnly）
 *   2. 带着那个 cookie 再请求 `./` → 200 + HTML（里面才有 `window.__DSH_BOOT__`）
 * node 的 fetch **不会**自动存 cookie，所以要自己接住 303 的 set-cookie 再发第二次。
 */
let sessionCookie = null
let html = ''
try {
  const first = await fetch(`${ORIGIN}/?token=${encodeURIComponent(token)}`, { redirect: 'manual' })
  const raw = first.headers.getSetCookie?.() ?? []
  const setCookie = raw.length ? raw : [first.headers.get('set-cookie')].filter(Boolean)
  sessionCookie = setCookie.map((c) => String(c).split(';')[0]).join('; ') || null

  if (first.status === 303 || first.status === 302) {
    if (sessionCookie) ok(`token 换 cookie 成功（HTTP ${first.status}，收到 ${setCookie.length} 条 set-cookie）`)
    else bad('token 换来 303，但没有 set-cookie —— 门禁机制可能变了')
  } else if (first.status === 200) {
    // 有些版本直接放行，那就直接用这次的正文
    html = await first.text()
    ok(`token 直接放行（HTTP 200，${html.length} 字节）`)
  } else {
    bad(`token 请求 HTTP ${first.status}（token 是否过期？重启 dsh web 会换新 token）`)
  }

  if (!html && sessionCookie) {
    const second = await fetch(`${ORIGIN}/`, {
      headers: { Cookie: sessionCookie },
      redirect: 'follow',
    })
    html = await second.text()
    if (second.ok) ok(`带 cookie 取到登录页（HTTP ${second.status}，${html.length} 字节）`)
    else bad(`带 cookie 取登录页 HTTP ${second.status}`)
  }
} catch (e) {
  bad(`取登录页失败：${e.message}`)
}

let entry = null
if (html) {
  const m = html.match(/globalThis\["__DSH_BOOT__"\]\s*=\s*(\{[\s\S]*?\})<\/script>/)
  if (!m) bad('登录页里找不到 window.__DSH_BOOT__')
  else {
    let boot = null
    try {
      boot = JSON.parse(m[1])
    } catch (e) {
      bad(`__DSH_BOOT__ 不是合法 JSON：${e.message}`)
    }
    if (boot) {
      const entries = boot.entries ?? []
      entry = entries.find((x) => x.id === PKG_NAME) ?? null
      if (entry) ok(`__DSH_BOOT__.entries 含 ${PKG_NAME}（共 ${entries.length} 条）`)
      else bad(`__DSH_BOOT__.entries 不含 ${PKG_NAME}（共 ${entries.length} 条）`)

      const batches = boot.batches ?? []
      const inBatch = batches.some((b) => (b.entries ?? []).includes(PKG_NAME))
      if (inBatch) ok('本包已在某个 application batch 的 entries 里')
      else bad('本包不在任何 batch 的 entries 里')
    }
  }
}

// ── 3. bundle 可取 ───────────────────────────────────────────────────────
let bundle = ''
const bundleHeaders = sessionCookie ? { Cookie: sessionCookie } : {}
if (entry?.url) {
  const url = `${ORIGIN}/${entry.url}`
  try {
    const res = await fetch(url, { headers: bundleHeaders })
    bundle = await res.text()
    if (res.ok) ok(`客户端 bundle 可取（HTTP ${res.status}，${bundle.length} 字节）`)
    else bad(`客户端 bundle HTTP ${res.status}（${url}）`)
  } catch (e) {
    bad(`取客户端 bundle 失败：${e.message}`)
  }
} else {
  bad('没有 entry.url，无法取 bundle')
}

// ── 4. bundle 内容 ───────────────────────────────────────────────────────
if (bundle) {
  // 说明：bundle 是 DSH 私有的「惰性 CJS 注册」格式，`load(` 之后可能夹着注释块，
  // 所以不对花括号内的邻接做断言，只取**第一处** id 的值 —— 那才是模块 id
  // （文件后面还有 slot 注册的 id，用贪婪匹配会误抓到 'freethought-map-panel'）。
  const head = bundle.slice(bundle.indexOf('__ModuleLoader__'), bundle.indexOf('__ModuleLoader__') + 800)
  const lit = head.match(/\bid\s*:\s*['"]([^'"]+)['"]/)
  const ref = head.match(/\bid\s*:\s*([A-Za-z_$][\w$]*)/)
  let moduleId = lit?.[1]
  if (!moduleId && ref) {
    const constDecl = bundle.match(
      new RegExp(`(?:const|let|var)\\s+${ref[1]}\\s*=\\s*['"]([^'"]+)['"]`),
    )
    moduleId = constDecl?.[1]
  }
  if (!bundle.includes('__ModuleLoader__')) {
    bad('bundle 里没有 __ModuleLoader__（不是 DSH 客户端格式）')
  } else if (moduleId === PKG_NAME) {
    ok(`bundle 里 __ModuleLoader__.load 的 id 等于包名（${moduleId}）`)
  } else if (moduleId) {
    bad(`bundle 的 module id 是 ${moduleId}，与包名 ${PKG_NAME} 不一致`)
  } else {
    bad('无法从 bundle 里解析出 module id')
  }

  if (bundle.includes(ROOT_ATTR)) ok(`bundle 里带本插件的根节点标记 ${ROOT_ATTR}`)
  else bad(`bundle 里没有根节点标记 ${ROOT_ATTR}（可能送错了文件）`)

  if (bundle.includes('sidebar.right.pane.tab')) ok('bundle 里带右侧停靠列席位 sidebar.right.pane.tab')
  else bad('bundle 里没有 sidebar.right.pane.tab —— 面板不会挂在任何地方')
}

// ── 报告 ─────────────────────────────────────────────────────────────────
const fails = results.filter(([s]) => s === 'FAIL')
const pad = Math.max(...results.map(([, m]) => m.length))
console.log('')
for (const [s, m] of results) console.log(`  ${s}  ${m}`)
console.log('')
console.log(`探针 P5（构建加载）：${results.length - fails.length} 通过 / ${fails.length} 失败`)
process.exit(fails.length ? 1 : 0)
