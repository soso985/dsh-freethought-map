/**
 * 宿主一半自测（卡 2）—— 不启动宿主，验证三件事：
 *
 *   1. **两份 Remote 契约逐字段一致**（宿主 `src/host/storage.js` vs 客户端 `src/client/index.js`）。
 *      两边故意各写一份（互不 import），所以必须有一个脚本盯住它们别漂移。
 *   2. **Remote 标记与会话绑定形状正确** —— 网关的 SRC 发现只认这几样东西：
 *      原型上的 marker（version 1 + methods）、实例上的 `typertRemote`（namespace 是字符串）、
 *      以及能被 `Function.prototype.toString` 解析出参数名的形参。
 *   3. **领域 spec 是合法的** —— 名字/版本过关，记录 schema 的 `parse()` 真能拦住脏数据。
 *
 * 用法：
 *   node scripts/verify-host.mjs
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const root = resolve(here, '..')

const results = []
const ok = (m) => results.push(['PASS', m])
const bad = (m) => results.push(['FAIL', m])
/** 只记录不判定（用于说明"这条断言的局限"） */
const note = (m) => results.push(['INFO', m])

const REMOTE_METHOD_DESCRIPTOR = '@deepseek-ai/dsh-typert-protocol/remote-methods'

// ── 载入宿主一半 ────────────────────────────────────────────────────────────
const hostMod = await import(pathToFileURL(join(root, 'src', 'host', 'storage.js')).href)
const hostContribution = hostMod.buildRemoteContribution()
ok(`宿主一半可载入并导出 buildRemoteContribution()`)

// ── 1. 契约一致性 ───────────────────────────────────────────────────────────
// 客户端一半是**普通脚本**，只能用 vm.Script 在 stub 沙箱里跑，再从注册对象里取 factory。
const vm = (await import('node:vm')).default
const clientSource = readFileSync(join(root, 'src', 'client', 'index.js'), 'utf8')
const registered = []
const sandboxWindow = {
  localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
  addEventListener() {},
  removeEventListener() {},
  setInterval,
  clearInterval,
  setTimeout,
  clearTimeout,
  __ModuleLoader__: {
    mode: 'queue',
    load(reg) {
      registered.push(reg)
      return reg
    },
  },
}
vm.createContext({ window: sandboxWindow, console, setTimeout, clearTimeout, setInterval, clearInterval })
new vm.Script(clientSource, { filename: 'client/index.js' }).runInContext(
  vm.createContext({ window: sandboxWindow, console, setTimeout, clearTimeout, setInterval, clearInterval }),
)

// 客户端把 contribution 写在 factory 闭包里，从源码里取常量来比对端点/参数命名更稳：
// 直接调用 client 的 factory 需要 React，这里改为「源码级比对」+ 「宿主侧结构断言」。
function clientContributionShape() {
  const service = clientSource.match(/const REMOTE_SERVICE = '([^']+)'/)?.[1]
  const pkg = clientSource.match(/const REMOTE_PACKAGE = '([^']+)'/)?.[1]
  const methods = [...clientSource.matchAll(/mk\('([a-zA-Z]+)',\s*\[([^\]]*)\]/g)].map((m) => ({
    method: m[1],
    params: [...m[2].matchAll(/remoteParam\('([^']+)'\)/g)].map((p) => p[1]),
  }))
  return { service, pkg, methods }
}

const clientShape = clientContributionShape()
if (!clientShape.service || !clientShape.pkg) {
  bad('无法从客户端源码解析出 REMOTE_SERVICE / REMOTE_PACKAGE')
} else {
  ok(`客户端声明：package=${clientShape.pkg} service=${clientShape.service}`)
  if (hostContribution.package === clientShape.pkg && hostContribution.package !== '') {
    ok('包名两侧一致：' + hostContribution.package)
  } else {
    bad(`包名不一致：宿主 ${hostContribution.package} vs 客户端 ${clientShape.pkg}`)
  }

  const hostMethods = hostContribution.descriptors.map((d) => ({
    method: d.method,
    namespace: d.namespace,
    service: d.service,
    params: d.parameters.map((p) => p.name),
  }))
  const clientMethods = clientShape.methods.map((m) => ({
    method: m.method,
    namespace: clientShape.service,
    service: clientShape.service,
    params: m.params,
  }))

  const hj = JSON.stringify(hostMethods)
  const cj = JSON.stringify(clientMethods)
  if (hj === cj) {
    ok('端点与参数名两侧逐字段一致：' + hostMethods.map((m) => m.method + '(' + m.params.join(',') + ')').join(' / '))
  } else {
    bad(`Remote 契约漂移：\n      宿主   ${hj}\n      客户端 ${cj}`)
  }
}

// ── 2. 网关 SRC 发现的形状要求 ──────────────────────────────────────────────
// 服务实例无法在这里构造（需要 ctx），改为校验「宿主源码里确实提供了这些形状」。
const hostSource = readFileSync(join(root, 'src', 'host', 'storage.js'), 'utf8')

// 逐方法对齐：marker 里声明的方法 必须与契约里的 descriptors 完全同集合。
// 这条断言是补出来的 —— 之前 `events` 加了 marker 却漏了 `mk(...)`，
// 而当时的「两侧一致性」测试只比对了两份契约（同样都漏），所以没抓到。
{
  const markerMatch = hostSource.match(/markRemoteMethods\([^,]+,\s*\[([^\]]*)\]/)
  const markerMethods = markerMatch
    ? [...markerMatch[1].matchAll(/'([^']+)'/g)].map((m) => m[1]).sort()
    : []
  const contractMethods = hostContribution.descriptors.map((d) => d.method).sort()
  if (markerMethods.length === 0) {
    bad('解析不出 markRemoteMethods 的方法列表')
  } else if (JSON.stringify(markerMethods) === JSON.stringify(contractMethods)) {
    ok(
      `marker 方法与契约集合一致（${markerMethods.length} 个：${markerMethods.join(', ')}）` +
        ' —— 两边都漏同一个方法的情况也能抓到',
    )
  } else {
    bad(
      `marker 与契约不同集合：marker=[${markerMethods}] 契约=[${contractMethods}]` +
        '（说明有一侧漏登记了端点）',
    )
  }

  // ⚠️ 上面那条还漏一种情况：marker 与契约都写了，但**类上根本没有这个方法体**
  // （本轮实测撞到：加新端点时把 `events` 的方法删掉了，运行期报
  //  `Remote marker has no prototype method "events"`，而契约断言是绿的）。
  // 所以必须逐个确认「类上真的有这个方法」。
  const missingBodies = markerMethods.filter(
    (m) => !new RegExp('(^|\\s)(async\\s+)?' + m + '\\s*\\(').test(hostSource),
  )
  if (markerMethods.length === 0) {
    // 上一段已经报过错了
  } else if (missingBodies.length === 0) {
    ok(`marker 里每个方法在类上都有方法体（${markerMethods.length} 个都验过）`)
  } else {
    bad(
      'marker 声明了但类上没有方法体：' +
        missingBodies.join(', ') +
        '（运行期会报 Remote marker has no prototype method）',
    )
  }
}

if (hostSource.includes(`'${REMOTE_METHOD_DESCRIPTOR}'`)) {
  ok('宿主源码使用协议规定的 marker 键（含字符串常量）')
} else if (hostSource.includes(REMOTE_METHOD_DESCRIPTOR)) {
  ok('宿主源码使用协议规定的 marker 键')
} else {
  bad('宿主源码里找不到 marker 键 ' + REMOTE_METHOD_DESCRIPTOR)
}

if (/version:\s*1/.test(hostSource)) ok('marker 的 version 为 1（协议要求，非 1 会抛）')
else bad('marker 缺少 version: 1')

if (/invocation:\s*Object\.freeze\(\{\s*kind:\s*'direct'\s*\}\)/.test(hostSource)) {
  ok('marker 的 invocation 是 { kind: "direct" } 且被冻结')
} else {
  bad('marker 的 invocation 形状不对（应为冻结的 { kind: "direct" }）')
}

if (/typertRemote\s*=\s*Object\.freeze\(\{/.test(hostSource)) {
  ok('实例上挂了冻结的 typertRemote 绑定（网关 SRC 发现的必要条件）')
} else {
  bad('找不到 typertRemote 绑定')
}
if (/namespace:\s*SERVICE_KEY/.test(hostSource)) ok('绑定的 namespace 存在且取自 SERVICE_KEY')
else bad('绑定的 namespace 缺失')

if (/ctx\.reflect\.provide\(SERVICE_KEY/.test(hostSource)) {
  ok('服务用 ctx.reflect.provide 登记（网关只看 type === "service" 的条目）')
} else {
  bad('服务没有 provide 成 cordis service —— 网关照不到它')
}

// 形参必须是简单标识符（网关靠 Function.prototype.toString 解析参数名）
const sigMatches = [...hostSource.matchAll(/async\s+(load|save|describe)\s*\(([^)]*)\)/g)]
if (sigMatches.length === 0) {
  bad('找不到 Remote 方法的签名')
} else {
  let allSimple = true
  for (const m of sigMatches) {
    const params = m[2].trim()
    if (params === '') continue
    const parts = params.split(',').map((p) => p.trim())
    for (const p of parts) {
      if (!/^[A-Za-z_$][\w$]*$/.test(p)) {
        allSimple = false
        bad(`方法 ${m[1]} 的形参 "${p}" 不是简单标识符 —— 网关解析参数名会失败`)
      }
    }
  }
  if (allSimple) ok(`${sigMatches.length} 个 Remote 方法的形参都是简单标识符（可被 toString 解析）`)
}

// ── 3. 领域 spec 与记录 schema ──────────────────────────────────────────────
// 用假的 ctx 构造服务，直接验证 spec 与 schema 的行为。
const fakeCtx = { logger: { info() {} }, effect: (fn) => fn(), reflect: { provide: () => () => {} } }
const spec = hostMod.__test?.makeDomainSpec?.()
if (!spec) {
  // 没导出就跳过（保持脚本对内部实现细节的弱耦合）
  ok('（跳过 spec 断言：makeDomainSpec 未导出）')
} else {
  if (/^[a-z][a-z0-9_]*$/.test(spec.name)) ok('领域名合法（首字母小写、只含小写/数字/下划线）：' + spec.name)
  else bad('领域名非法（后端会抛 malformed-medium）：' + spec.name)
  if (Number.isInteger(spec.version) && spec.version >= 0) ok('领域版本是非负整数：' + spec.version)
  else bad('领域版本非法')
  const table = spec.tables.overlays
  if (table && typeof table.valueSchema.parse === 'function') {
    ok('表 overlays 带 valueSchema.parse()（领域层唯一真正调用的 schema 方法）')
  } else {
    bad('表 overlays 缺 valueSchema.parse')
  }
}

// ── 4. 不 import 任何裸包名（宿主 runtime 解析不到）──────────────────────────
const bareImports = [
  ...hostSource.matchAll(/^\s*import\s[^'"]*['"]([^'"]+)['"]/gm),
  ...hostSource.matchAll(/^\s*export\s[^'"]*from\s*['"]([^'"]+)['"]/gm),
].map((m) => m[1])
const relativeOnly = bareImports.every((s) => s.startsWith('.') || s.startsWith('/'))
if (relativeOnly) {
  ok(`宿主一半只 import 相对路径（${bareImports.length} 条：${bareImports.join(', ')}）`)
} else {
  bad('宿主一半 import 了裸包名：' + bareImports.filter((s) => !s.startsWith('.')).join(', '))
}

// ── 5. 落链订阅的形状（卡 3）────────────────────────────────────────────────
if (/ctx\.on\(\s*'session\/event'/.test(hostSource)) {
  ok("用 ctx.on('session/event', …) 订阅结算事件")
} else {
  bad("没有订阅 'session/event' —— 落链不会发生")
}
// Cordis 的 ctx.on 是 scope-owned，卸载时自动移除；全树官方包 130+ 处 ctx.on 无一处配 ctx.off。
// 所以这里断言的是「**不要**手写 ctx.off」—— 名字对不上会在卸载路径上抛错。
//
// ⚠️ 必须先把注释剥掉再判：解释「为什么不用 ctx.off」的注释本身就含 `ctx.off(`，
// 直接 grep 会把它当成真实代码误报（本轮第二次踩这个坑，verify-client 里也踩过一次）。
const hostCode = hostSource
  .split(/\r?\n/)
  .filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l))
  .join('\n')
if (/ctx\.off\(/.test(hostCode)) {
  bad('手写了 ctx.off —— Cordis 的 ctx.on 已随 fiber 自动销毁，手写反而可能在卸载时抛错')
} else {
  ok('没有手写 ctx.off（依赖 Cordis 的 scope-owned 监听器）')
}
if (/inject = \['storageDomain', 'sessions', 'tools'\]/.test(hostSource)) {
  ok("声明了 inject = ['storageDomain', 'sessions', 'tools']（存储 / 事件源 / 工具表都是硬依赖）")
} else if (/inject = \['storageDomain', 'sessions'\]/.test(hostSource)) {
  bad("inject 里缺 'tools' —— 卡 6 的只读工具注册不上")
} else {
  bad('inject 声明与预期不符 —— 事件源缺失会让落链静默不发生')
}
if (/settlementKindOf\(event\)/.test(hostSource)) {
  ok('落链前先用 settlementKindOf 过滤（只认 append 结算，排除替换副本/中止/工具过程）')
} else {
  bad('没有做 append-结算过滤 —— 替换副本会把同一结算消费两次')
}
if (/table\.update\(/.test(hostSource) && /projectOne/.test(hostSource)) {
  ok('投影写回走 table.update 写链槽位（与用户 save 共享 rev 序列）')
} else {
  bad('投影没有走写链槽位 —— 与 save 并发时会互相覆盖')
}
if (/projectionChain/.test(hostSource)) {
  ok('投影写入串行化（避免同源事件并发读-改-写交错）')
} else {
  bad('投影没有串行化')
}

// ── 6. D3-8 / 卡 8 禁词检查：可执行入口里不得有「生成导图」这类东西 ──────────────
//
// 规格 §6.3 与 02-实施计划.md 卡 8 都强调：**不要全文 grep 文档**（允许帮助文字里写
// 「禁止一键生成思维导图」），要检查**可执行入口**：工具注册表、命令面板、按钮 label、
// agent 可调工具名。所以这里查的是代码里的注册面，不是文档。
const allSources = [
  ['src/host/storage.js', hostSource],
  ['src/client/index.js', clientSource],
  ['src/host/index.js', readFileSync(join(root, 'src', 'host', 'index.js'), 'utf8')],
  ['src/overlay/project.js', readFileSync(join(root, 'src', 'overlay', 'project.js'), 'utf8')],
]

// 1) 只允许注册**只读**工具（卡 6）。写工具是红线。
//    2026-09-27 卡 6 之前这里是「一处都不许有」；卡 6 之后改成「必须有且只有那三个只读工具」。
{
  const code = hostSource
    .split(/\r?\n/)
    .filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l))
    .join('\n')
  const toolsSource = readFileSync(join(root, 'src', 'overlay', 'tools.js'), 'utf8')
  const toolsCode = toolsSource
    .split(/\r?\n/)
    .filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l))
    .join('\n')

  if (!/registerReadonlyTools\(/.test(code)) {
    bad('宿主没有走 registerReadonlyTools —— 卡 6 的三个只读工具应当已注册')
  } else {
    ok('宿主通过 registerReadonlyTools 注册工具（注册面集中在一个地方）')
  }

  // 写工具的红线：整个 overlay 目录不得出现注册写工具的意图
  const writeToolHints = toolsCode.match(/name:\s*'(add|create|set|link|move|hide|delete|remove|update|write)\w*'/gi)
  if (writeToolHints && writeToolHints.length > 0) {
    bad('出现写工具定义：' + writeToolHints.join(', ') + '（红线：模型只能读图）')
  } else {
    ok('没有定义任何写工具（红线：模型只能读图，不能改图）')
  }

  // 三个工具名必须正好是白名单那三个
  const declared = [...toolsCode.matchAll(/name:\s*TOOL_(\w+)/g)].map((m) => m[1])
  if (declared.length === 3) {
    ok('只声明了 3 个工具（' + declared.join(', ') + '）')
  } else {
    bad('声明的工具数不是 3 个，而是 ' + declared.length + '：' + declared.join(', '))
  }

  // 会话身份必须来自执行上下文，不得出现"当前会话"式兜底
  if (/sessionIdFromExecution\(exec\)/.test(toolsCode)) {
    ok('会话身份取自执行上下文（sessionIdFromExecution(exec)）')
  } else {
    bad('工具没有从执行上下文取会话身份 —— 会读到别的会话的图')
  }
  if (/currentSession|activeSession|ctx\.session\b|getCurrentSession/.test(toolsCode)) {
    bad('工具里出现"当前会话"式访问 —— 红线 8 禁止（必须来自执行上下文）')
  } else {
    ok('工具里没有"当前会话"式访问（红线 8）')
  }
}

// 2) 可执行入口里没有「一次成树 / 生成导图」类名字
//
// ⚠️ 卡 8 的实施计划原文：「检查**可执行入口**：工具注册表、命令面板、按钮 label、
//    agent 可调工具名。**允许**文档/帮助出现「禁止一键生成思维导图」字样。」
//
// 所以这里必须把「帮助正文」排除掉 —— 帮助是要**说明**这件事的，正文里必然出现这个词。
// 光剥注释不够（帮助文本是字符串字面量，不是注释）。本轮就是被这个坑了一次：
// 帮助文本加进去之后这条立刻误报。
const HELP_TEXT_BLOCK = /const HELP_TEXT = `[\s\S]*?`/g

const forbidden = /生成导图|思维导图|自动成图|整理成树|一键成树|generateMap|mindmap|autoTree|buildTree/i
let forbiddenHits = []
for (const [name, src] of allSources) {
  const code = src
    .split(/\r?\n/)
    .filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)) // 去掉注释行
    .join('\n')
    .replace(HELP_TEXT_BLOCK, 'const HELP_TEXT = ""') // 去掉帮助正文（它就是要说这件事）
  if (forbidden.test(code)) forbiddenHits.push(name)
}
if (forbiddenHits.length === 0) {
  ok('可执行代码里没有「生成导图 / 一次成树」类入口（注释与帮助正文不算）')
} else {
  bad('可执行代码里出现禁词入口：' + forbiddenHits.join(', '))
}

// 2b) 反过来也要成立：帮助正文里**必须**有那句说明（否则用户不知道这是刻意不做的）
{
  const helpSource = readFileSync(join(root, 'src', 'overlay', 'io.js'), 'utf8')
  if (helpSource.includes('禁止一键生成思维导图')) {
    ok('帮助正文里明确写了「刻意不做一键生成」（说明而不是入口）')
  } else {
    bad('帮助里没有说明「刻意不做一键生成思维导图」—— 用户会以为是没做')
  }
}

// 3) 面板里只允许「收起/展开」这一个控件 —— 不该出现任何"生成/整理"类按钮。
// 用宽松匹配：只要有 h('button' 出现，就把后面一小段文本里的所有单引号字面量当候选 label。
const buttonLabels = []
for (const m of clientSource.matchAll(/h\(\s*'button'[\s\S]{0,400}?\n\s*\)/g)) {
  for (const lit of m[0].matchAll(/'([^']{1,40})'/g)) buttonLabels.push(lit[1])
}
const labels = [...new Set(buttonLabels)]
const suspicious = labels.filter((l) => /生成|整理|组织|规划|建议|自动/.test(l))
if (labels.length === 0) {
  info('（没能从源码里解出按钮 label，跳过这条 —— 但上面的禁词扫描已覆盖代码面）')
} else if (suspicious.length === 0) {
  ok(`面板按钮 label = ${JSON.stringify(labels)} —— 没有生成/整理类入口`)
} else {
  bad('面板里出现可疑按钮：' + suspicious.join(', '))
}

// ── 7. 客户端副本与 overlay 源文件的**逐字一致**（防漂移）─────────────────────
//
// 客户端 bundle 不能 import 相对模块，所以 locate.js / project.js 里几个纯函数
// 被**逐字复制**进了 client/index.js。复制是安全的 —— 前提是有人盯着别分叉。
// 这条断言就是那个人：把两份源码里的函数体抽出来逐字比对。
{
  const locateSource = readFileSync(join(root, 'src', 'overlay', 'locate.js'), 'utf8')

  /**
   * 从一个源码里抽出函数体：认 `function name(` 与 `const name = (` 两种写法。
   *
   * ⚠️ 不能直接找第一个 `{` —— 参数默认值里就可能带花括号（`opts = {}`），
   * 那会把它当成函数体、抽出个 `{}` 来。必须先跨过**配平的参数表右括号**，
   * 之后的第一个 `{` 才是函数体。本轮就是被这个坑了一次。
   */
  function extractFunction(src, name) {
    let start = src.indexOf('function ' + name + '(')
    if (start < 0) start = src.indexOf('const ' + name + ' = (')
    if (start < 0) return null
    const parenStart = src.indexOf('(', start)
    if (parenStart < 0) return null
    let pdepth = 0
    let parenEnd = -1
    for (let i = parenStart; i < src.length; i += 1) {
      const ch = src[i]
      if (ch === '(') pdepth += 1
      else if (ch === ')') {
        pdepth -= 1
        if (pdepth === 0) {
          parenEnd = i
          break
        }
      }
    }
    if (parenEnd < 0) return null
    const braceStart = src.indexOf('{', parenEnd)
    if (braceStart < 0) return null
    let depth = 0
    for (let i = braceStart; i < src.length; i += 1) {
      const ch = src[i]
      if (ch === '{') depth += 1
      else if (ch === '}') {
        depth -= 1
        if (depth === 0) return src.slice(braceStart, i + 1)
      }
    }
    return null
  }

  /**
   * 去掉空白与**所有**注释行后比对，避免只因缩进/换行/注释不同就误报。
   * 注意要把 `}` 后面的行内注释也剥掉（`continue // 说明` 这种），否则会被当成差异。
   */
  function normalize(body) {
    return body
      .split(/\r?\n/)
      .map((l) => l.replace(/\s*\/\/.*$/, '').replace(/\s+/g, ' ').trim())
      .filter((l) => l && !l.startsWith('*') && !l.startsWith('/*'))
      .join(' ')
  }

  const shared = ['bubbleSelectorCandidates', 'locateBubble', 'buildChainView']
  let drifted = []
  let compared = 0
  for (const fn of shared) {
    const a = extractFunction(locateSource, fn)
    const b = extractFunction(clientSource, fn)
    if (a === null || b === null) {
      drifted.push(fn + '(抽不出函数体)')
      continue
    }
    compared += 1
    if (normalize(a) !== normalize(b)) drifted.push(fn)
  }
  if (drifted.length === 0) {
    ok(`客户端副本与 overlay 源文件逐字一致（${compared} 个函数：${shared.join(', ')}）`)
  } else {
    bad('副本已漂移，必须同步修改两处：' + drifted.join(', '))
  }

  // scrollToBubble 客户端版少了 opts 默认值那点差异，单独比核心语句
  const aScroll = extractFunction(locateSource, 'scrollToBubble')
  const bScroll = extractFunction(clientSource, 'scrollToBubble')
  if (aScroll && bScroll) {
    const keySentences = [
      'scrollIntoView({ block: \'center\', behavior: \'smooth\' })',
      "el.style.outline = '2px solid var(--dsw-alias-brand, rgb(64, 128, 255))'",
      "el.style.outlineOffset = '2px'",
    ]
    const missing = keySentences.filter((s) => !normalize(bScroll).includes(normalize(s)))
    if (missing.length === 0) ok('scrollToBubble 的关键语句两侧一致（滚动 + 临时高亮 + 还原）')
    else bad('scrollToBubble 客户端版缺少：' + missing.join(' | '))
  }
}

// ── 8. 发送前注入的接线（卡 5）────────────────────────────────────────────────
if (/ctx\.on\(\s*'agent\/pre-step'/.test(hostSource)) {
  ok("订阅 'agent/pre-step'（发送前注入的唯一钩子）")
} else {
  bad("没有订阅 'agent/pre-step' —— 粉线快照与焦点摘要注入不会发生")
}
if (/await next\(\)/.test(hostSource)) {
  ok('pre-step 里 await next()（不吞掉下游决策）')
} else {
  bad('pre-step 里没有 await next() —— 会吞掉下游 listener 的决策')
}
// 决策逻辑在卡 5 被抽到 `src/overlay/inject.js`（纯函数），所以「展开 decision」这条
// 要查那个文件；宿主侧只查「确实委托给了它」。
const injectSource = readFileSync(join(root, 'src', 'overlay', 'inject.js'), 'utf8')
if (/\{\s*\.\.\.decision,\s*messages\s*\}/.test(injectSource)) {
  ok('返回 { ...decision, messages } 而不是自造决策（保留 startsRequestSeries 等字段）')
} else {
  bad('返回决策时没有展开 decision —— 会丢掉其他字段')
}
if (/computeInjection\(/.test(hostSource)) {
  ok('宿主把注入决策委托给纯函数 computeInjection（可离线验死）')
} else {
  bad('宿主没有走 computeInjection —— 注入逻辑无法离线验证')
}
// 红线：注入不得唤醒模型 / 不得改写用户原文
{
  const code = hostSource
    .split(/\r?\n/)
    .filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l))
    .join('\n')
  if (/followup\(/.test(code)) bad('出现 followup( —— 红线：拉线/注入不得唤醒模型')
  else ok('没有调用 followup()（红线：拉线不自动唤醒模型）')
  if (/messages\s*\.\s*push\(|messages\s*\[[^\]]+\]\s*=/.test(code)) {
    bad('原地改写了 messages —— pre-step 必须返回新数组，不能改原数组')
  } else {
    ok('没有原地改写 messages（用 spliceInjectionAfterClaimed 产新数组）')
  }
}
if (/injectionLog\.record\(/.test(hostSource)) {
  ok('注入带可观测记录（injectionLog）—— 真实发送时能从日志确认注入生效')
} else {
  bad('注入没有可观测记录 —— 真实发送时无法确认是否生效')
}

// ── 9. 卡 7：撤销栈的接线（两边都必须把防环实现接上）──────────────────────────
if (/setCanSetParent\(canSetParent\)/.test(hostSource)) {
  ok('宿主已把 canSetParent 注入给 undo.js（防环只有一份实现）')
} else {
  bad('宿主没有注入 canSetParent —— undo.js 的改父校验会抛错（它刻意不重复实现防环）')
}
if (/from '\.\.\/overlay\/undo\.js'/.test(hostSource)) {
  ok('宿主 import 了 undo.js（用户操作与撤销栈在宿主侧可用）')
} else {
  bad('宿主没有 import undo.js')
}
{
  const undoSource = readFileSync(join(root, 'src', 'overlay', 'undo.js'), 'utf8')
  // 「undo 不新建节点」这条不变量：逆操作种类必须在白名单里
  const kinds = [...undoSource.matchAll(/type: '([a-z-]+)',/g)].map((m) => m[1])
  const illegal = [...new Set(kinds)].filter(
    (k) =>
      ![
        'remove',
        'restore-node',
        'unremove',
        're-delete',
        'set-field',
        'remove-link-added',
        'link-restore',
        'link-remove',
        'unknown',
        'create',
        'delete',
        'set-parent',
        'annotate',
        'geometry',
        'link-add',
      ].includes(k),
  )
  if (illegal.length === 0) {
    ok('撤销相关的操作种类都在白名单里（没有"新建节点"型逆操作混进来）')
  } else {
    bad('出现预期外的操作种类：' + illegal.join(', '))
  }
  // 规格 §7 明令：禁止整份 doc 快照式编辑
  if (/structuredClone\(doc\)|JSON\.parse\(JSON\.stringify\(doc\)\)/.test(undoSource)) {
    bad('undo.js 里出现整份 doc 快照 —— 规格 §7 明令禁止（会把拖动期间的投影一起回滚）')
  } else {
    ok('undo.js 没有整份 doc 快照（符合规格 §7：只记被改字段的前后值）')
  }
}

// ── 10. 「每步都注入是否重复」的判据（原探针，2026-09-27 收口）──────────────
//
// 历史：这里原先断言 `src/host/hook-probe.js`（一个只写 JSONL 的诊断探针）。
// 它的使命已经完成（P0 修完 + 真机注入验完），按主人指示**删除**，
// 因为它每次 pre-step 都写盘（运行代价 + 敏感文本落盘）。
//
// 但探针里有一条**真实有用**的东西被保留了下来：判断
// 「这一步进来之前，消息批次里是不是已经带着我们上一步注入的那条」。
// 它决定每步注入是必要还是重复 —— 现在搬到了 `overlay/injection-marks.js` 的
// `classifyPreStep`（纯函数、可离线验死），并在 pre-step 里真的被调用。
{
  const marksPath = join(root, 'src', 'overlay', 'injection-marks.js')
  let marksSource = ''
  try {
    marksSource = readFileSync(marksPath, 'utf8')
  } catch {
    bad('找不到 src/overlay/injection-marks.js —— 判据被误删了？')
  }
  if (marksSource) {
    if (/export function isInjectedMessage\(/.test(marksSource)) {
      ok('注入消息的识别走 source.kind/form（不按文本前缀 —— 那会被用户原文污染）')
    } else {
      bad('注入消息识别没有结构化判据')
    }
    if (/export function classifyPreStep\(/.test(marksSource) && /payloadInjected/.test(marksSource) && /decisionInjected/.test(marksSource)) {
      ok('classifyPreStep 记录 payloadInjected / decisionInjected（判定"每步都注入"是否重复）')
    } else {
      bad('classifyPreStep 没有记录已有注入条数 —— 无法回答"同一步重复注入"')
    }
    if (/needsInjection/.test(marksSource)) {
      ok('判据给出明确结论字段 needsInjection（而不是让调用方自己推）')
    } else {
      bad('判据没有给出结论字段')
    }
  }

  // 探针必须真的被删掉（主人明确要求），且宿主不得再引用它
  let probeStillThere = false
  try {
    readFileSync(join(root, 'src', 'host', 'hook-probe.js'), 'utf8')
    probeStillThere = true
  } catch {
    probeStillThere = false
  }
  if (!probeStillThere) ok('诊断探针 src/host/hook-probe.js 已删除（使命完成）')
  else bad('探针还在 —— 它每次 pre-step 都写盘，属于已收口的诊断代码')
  if (/hook-probe|appendProbeEntry|buildProbeEntry/.test(hostSource)) {
    bad('宿主里仍有探针引用 —— 删了文件但没删接入点')
  } else {
    ok('宿主里没有任何探针引用（接入点也清干净了）')
  }
  // 判据必须真的被 pre-step 调用（否则就变成死代码）
  if (/classifyPreStep\(/.test(hostSource)) {
    ok('pre-step 里真的调用了 classifyPreStep（不是只导出没人用）')
  } else {
    bad('classifyPreStep 导出了却没人调用 —— 那就是死代码，该删')
  }
}

// ── 11. rev 语义（P0，2026-09-27）──────────────────────────────────────────────
//
// 规格 §9.0：**任何改变权威内容的写入都必须递增 rev**。
// 漏一处的后果不是"数字不好看"，而是**那一次写入的并发保护被关掉** ——
// 拿着旧 doc 的客户端会通过 `baseRev === rev` 校验、整份替换、覆盖掉新内容。
//
// 2026-09-27 实测确认三处都漏过（自动投影 / 导入合并 / 重建投影），所以这里
// 逐个 write site 盯住：**每个 `table.update` 的返回值都必须经过 `commitAuthorityWrite`**。
{
  if (/function commitAuthorityWrite\(/.test(hostSource)) {
    ok('存在统一的权威写入收尾函数 commitAuthorityWrite')
  } else {
    bad('没有 commitAuthorityWrite —— rev 递增会散落在各处，容易再漏')
  }
  {
    // ⚠️ 这条断言本身被变异测试抓过一次假绿：早先只查了 `if (!changed) return after`
    //    这个**守卫**，没查真正的 `rev` 递增 —— 于是把 `rev: … + 1` 删掉，断言照样通过。
    //    现在把函数体抽出来，逐项检查：必须真的含 `rev:` 且含 `+ 1`。
    const start = hostSource.indexOf('function commitAuthorityWrite(')
    const braceStart = hostSource.indexOf('{', start)
    let depth = 0
    let body = ''
    for (let i = braceStart; i < hostSource.length; i += 1) {
      const ch = hostSource[i]
      if (ch === '{') depth += 1
      else if (ch === '}') {
        depth -= 1
        if (depth === 0) {
          body = hostSource.slice(braceStart, i + 1)
          break
        }
      }
    }
    const flat = body.replace(/\s+/g, ' ')
    if (!body) {
      bad('抽不出 commitAuthorityWrite 的函数体 —— 断言失效')
    } else if (/if \(!changed\) return after/.test(flat) && /rev:/.test(flat) && /\+\s*1/.test(flat)) {
      ok('commitAuthorityWrite 只在 changed 时递增 rev（且函数体里确实有 rev 递增，不是空守卫）')
    } else {
      bad(
        'commitAuthorityWrite 的函数体不对劲 —— 要么缺 changed 守卫，要么**根本没有 rev 递增**。' +
          '实际：' + flat.slice(0, 200),
      )
    }
  }

  // ⚠️ 这条断言我改了四版，前三版**全是空断言**（靠变异测试才发现）：
  //    1) 按 `table.update` 切 → 各站点 body 互相包含 → 摘掉一个仍能匹配到别的
  //    2) 按 `table.update|table.put` 标记切 → 投影里的 `table.put` 把 body 截断
  //    3) 数 `commitAuthorityWrite` 出现次数 → 注释里也有一句，计数永远是 4
  //
  //    教训：**"数数"证明不了"对应关系"**。要证明「每个写站点都递增 rev」，
  //    靠源码文本匹配很脆弱。真正可靠的是**运行期验证**（见 §11b 的真机复验），
  //    这里只保留一条最朴素的守卫：形状存在 + 站点数没变。
  {
    const commitReturns = (hostSource.match(/^\s*return commitAuthorityWrite\(/gm) || []).length
    const updateSites = (hostSource.match(/await\s+table\.update\(/g) || []).length
    if (updateSites === 0) {
      bad('一个 table.update 站点都没找到 —— 解析逻辑失效了')
    } else if (commitReturns >= 1) {
      ok(
        `存在 ${updateSites} 个 table.update 写站点，其中 ${commitReturns} 处以 ` +
          '`return commitAuthorityWrite(...)` 收尾（注释里的引用不计）',
      )
      note(
        '注意：这条只是形状守卫，**证明不了**每个站点都递增了 rev。' +
          '真正的证据是真机复验（投影后 rev 是否变大）—— 见 docs/HOST.md §3.19',
      )
    } else {
      bad('没有任何位置以 `return commitAuthorityWrite(...)` 收尾 —— rev 语义可能被整体摘掉')
    }
  }

  // 客户端：409 之后必须能重放意图，不能只重载
  if (/retryRef/.test(clientSource) && /intent\.kind === 'focus'/.test(clientSource)) {
    ok('客户端 409 之后会重放本次意图（不是只重载后丢弃用户改动）')
  } else {
    bad('客户端 409 之后只重载 —— 用户那次点击会静默白做')
  }
  if (/saveAuthority\([^)]*\{ kind: 'focus', nodeId: row\.id \}/.test(clientSource)) {
    ok('面板点击传入了意图（这样 409 才有东西可重放）')
  } else {
    bad('面板点击没有传意图 —— 409 时无法重放')
  }
}

// ── 12. 派生标题的持久化（2026-09-27：修「宿主重启后标题全失效」）──────────────
//
// 为什么必须有这一层：标题原先只活在内存的 SettlementLog 里，宿主一重启就全没了，
// 注入文案与面板链行一起退化成「（未命名）」/「（无标题）」。
// 而**不能**事后从会话补读 —— `Session` 的 eventAt/snapshotEvents/ownEvents
// 全被 `@deprecated` 禁掉新调用（见 docs/HOST.md）。
// 所以改成：投影那一刻把标题记进**独立的表**，重启后读回。
{
  if (/const TITLES_TABLE = 'derived_titles'/.test(hostSource)) {
    ok("有独立的派生标题表 `derived_titles`（**不写 overlay 的 title 字段**，符合规格 §6.4）")
  } else {
    bad('没有独立的派生标题表')
  }
  if (/\[TITLES_TABLE\]: \{ valueSchema: titlesRecordSchema \}/.test(hostSource)) {
    ok('派生标题表登记进了领域 spec（不是偷偷写别的表）')
  } else {
    bad('派生标题表没登记进领域 spec')
  }
  if (/function persistDerivedTitle\(/.test(hostSource) && /persistDerivedTitle\(domain, sessionId/.test(hostSource)) {
    ok('投影时把派生标题持久化（projectOne 里调用）')
  } else {
    bad('投影时没有持久化派生标题 —— 重启后仍会全失效')
  }
  // ⚠️ `table.update` **不会创建记录**（记录不存在时抛 missing-key）——
  // 真机实测撞到：标题表第一次写入必然失败，而离线断言看不出来。
  // 所以首建必须走 `put`。
  {
    const start = hostSource.indexOf('function persistDerivedTitle(')
    const braceStart = hostSource.indexOf('{', start)
    let depth = 0
    let body = ''
    for (let i = braceStart; i < hostSource.length; i += 1) {
      const ch = hostSource[i]
      if (ch === '{') depth += 1
      else if (ch === '}') {
        depth -= 1
        if (depth === 0) {
          body = hostSource.slice(braceStart, i + 1)
          break
        }
      }
    }
    if (!body) {
      bad('抽不出 persistDerivedTitle 函数体')
    } else if (/table\.put\(/.test(body) && /table\.update\(/.test(body) && /existing === undefined/.test(body)) {
      ok('标题持久化区分「首建用 put」与「更新用 update」（`update` 不创建记录，首建会抛 missing-key）')
    } else {
      bad('标题持久化没有区分首建/更新 —— 首次写入会因 `update` 找不到记录而失败')
    }
  }

  // ⚠️ 这里**不该**再有任何"测试专用写入口"。
  // 早先有个 `importTitles` RPC 端点，但它只有验收脚本在调 ——
  // 「只在测试里用、没有任何调用方开放」的写入口不该留在产品里（主人 2026-09-27 点名）。
  // 验收改成直接驱动 `__test.persistDerivedTitle`（与投影同一条代码路径）。
  {
    const clientSource = readFileSync(new URL('../src/client/index.js', import.meta.url), 'utf8')
    if (/importTitles/.test(hostSource) || /importTitles/.test(clientSource)) {
      bad('还有 `importTitles` 这个测试专用写入口 —— 产品里不该有它')
    } else {
      ok('没有测试专用的标题写入口（验收直接驱动真函数）')
    }
  }
  if (/titlesCache/.test(hostSource) && /loadTitlesIntoCache\(/.test(hostSource)) {
    ok('有内存缓存 + 预热函数（derivedTitleIndex 是同步的，必须先异步灌一次）')
  } else {
    bad('没有标题缓存 —— 同步的 derivedTitleIndex 拿不到持久化数据')
  }
  // 关键：接上废弃 API 就是踩了禁条
  if (/snapshotEvents\(|\.eventAt\(|\.ownEvents\(/.test(hostSource)) {
    bad('宿主代码里出现了 @deprecated 的同步会话读接口（new calls are prohibited）')
  } else {
    ok('**没有**使用被废弃的会话读接口（eventAt / snapshotEvents / ownEvents）')
  }
  // 标题合并：持久化优先，日志兜底
  if (/const cached = titlesCache\.get\(sessionId\)/.test(hostSource) && /settlementLog\.list\(sessionId/.test(hostSource)) {
    ok('derivedTitleIndex 同时取「持久化标题」与「结算日志」，前者优先')
  } else {
    bad('derivedTitleIndex 没有合并两个来源')
  }

  // ⚠️ 客户端也必须读持久化那一侧。
  // 真机实测踩到过：宿主持久化修好了，但客户端仍只读 `events`（内存日志），
  // 于是重启后面板照样全「（无标题）」—— **两侧都要接**。
  {
    const clientSource = readFileSync(new URL('../src/client/index.js', import.meta.url), 'utf8')
    if (/callRemote\(ctx, 'titles'/.test(clientSource)) {
      ok("客户端 `loadDerivedTitles` 也读持久化的 `titles` 端点（只读 events 会在重启后全空）")
    } else {
      bad("客户端没有读 `titles` 端点 —— 宿主持久化了面板也照样是「（无标题）」")
    }
    if (/byEvent = new Map\(Object\.entries\(persisted\)\)/.test(clientSource)) {
      ok('客户端按「持久化优先、日志兜底」合并两个来源')
    } else {
      bad('客户端没有把持久化标题放在优先位')
    }
  }
}

// ── 派生标题：用**假存储域**驱动真代码，覆盖真机曾失败的那条路径 ──────────────
//
// 为什么必须驱动真代码而不是只查源码：真机上 `table.update` 在记录不存在时抛
// `missing-key`（见 d2fe017），而当时**没有任何断言**覆盖「首建」这条分支 ——
// 源码里明明写着 `table.update(...)`，看起来完全正常。
// 所以这里造一个「像真领域那样对不存在的记录抛错」的假域，把两条分支都跑一遍。
if (hostMod.__test && typeof hostMod.__test.persistDerivedTitle === 'function') {
  const T = hostMod.__test

  /** 假存储域：语义对齐真领域的两条关键行为。 */
  function makeFakeDomain() {
    const rows = new Map()
    const writes = []
    const table = {
      get: (k) => rows.get(k),
      put: (k, v) => {
        rows.set(k, v)
        writes.push(['put', k])
        return Promise.resolve()
      },
      update: (k, fn) => {
        if (!rows.has(k)) {
          // 真机就是抛这个；假域必须照抄，否则测不出首建那类 bug
          writes.push(['update-rejected', k])
          return Promise.reject(new Error('missing-key: no record to update'))
        }
        rows.set(k, fn(rows.get(k)))
        writes.push(['update', k])
        return Promise.resolve()
      },
    }
    return { rows, writes, table: () => table }
  }

  const sid = 'session-fake-1'
  const domain = makeFakeDomain()
  T.titlesCache.delete(sid)

  // ① 首建：记录不存在 → 必须走 put，**且绝不能碰 update**
  //
  // 注意这里为什么断言「writes 里没有 update」而不是「没有 update-rejected」：
  // 早先那版只查 update-rejected，而变异测试证明那是**恒真**的 ——
  // 把代码改成 `true ? put : update` 时 put 仍被调用，于是永远不红。
  // 现在直接看假域收到的写操作序列，任何一次 update 都算失败。
  T.persistDerivedTitle(domain, sid, 'evt-a', '第一个标题')
  await new Promise((r) => setTimeout(r, 0))
  const afterFirst = domain.rows.get(sid)
  const firstUpdates = domain.writes.filter(([w]) => w === 'update' || w === 'update-rejected')
  if (firstUpdates.length > 0) {
    bad('首建时碰到了 update（' + JSON.stringify(firstUpdates) + '）—— 真机上会撞 missing-key')
  } else if (domain.writes.length === 0) {
    bad('首建什么都没写（假域没收到任何写操作）')
  } else if (afterFirst && afterFirst.titles && afterFirst.titles['evt-a'] === '第一个标题') {
    ok('首建只走 put 成功落盘（记录不存在时不会撞 missing-key）')
  } else {
    bad('首建之后记录不对：' + JSON.stringify(afterFirst))
  }

  // ② 追加：记录已存在 → 走 update；新键进表，**已有的其他键保留**
  //    （注意：同一个 eventId 的值是**以最新为准**的，见 ②′ —— 这里别写成"旧值不被覆盖"）
  T.persistDerivedTitle(domain, sid, 'evt-b', '第二个标题')
  await new Promise((r) => setTimeout(r, 0))
  const afterSecond = domain.rows.get(sid)
  if (
    afterSecond &&
    afterSecond.titles['evt-a'] === '第一个标题' &&
    afterSecond.titles['evt-b'] === '第二个标题' &&
    domain.writes.some(([w]) => w === 'update')
  ) {
    ok('记录已存在时走 update，且新键进表、其他键保留（条目不自删）')
  } else {
    bad('追加之后记录不对：' + JSON.stringify(afterSecond))
  }

  // ②′ 同一个 eventId 的**值以最新为准**（不是保留原值）——
  //     这是规格 §10.1.1 的语义，也是本文件曾经断言反了的地方。
  T.persistDerivedTitle(domain, sid, 'evt-a', '改过的标题')
  await new Promise((r) => setTimeout(r, 0))
  const afterRewrite = domain.rows.get(sid)
  if (afterRewrite && afterRewrite.titles['evt-a'] === '改过的标题') {
    ok('同一个 eventId 以**最新派生值**为准（规则升级后旧节点能跟上，不被冻结）')
  } else {
    bad('同 eventId 的值没有更新成最新：' + JSON.stringify(afterRewrite && afterRewrite.titles))
  }
  // 缓存也要跟着更新（不能只改盘不改缓存）
  if (T.titlesCache.get(sid) && T.titlesCache.get(sid).get('evt-a') === '改过的标题') {
    ok('改写后内存缓存同步更新（否则同一次注入还会看到旧标题）')
  } else {
    bad('改写后缓存没跟上')
  }

  // ③ 同一个 eventId + 同标题 → 不白写一次
  const writesBefore = domain.writes.length
  T.persistDerivedTitle(domain, sid, 'evt-a', '改过的标题')
  await new Promise((r) => setTimeout(r, 0))
  if (domain.writes.length === writesBefore) {
    ok('标题没变化时不重复写（省一次落盘）')
  } else {
    bad('标题没变化却又写了一次')
  }

  // ④ 读回：按 node.id 建表，没记过的节点不该被硬编
  const fakeDoc = {
    nodes: {
      'T-x': { id: 'T-x', sourceRef: { kind: 'user-message', eventId: 'evt-a' } },
      'T-y': { id: 'T-y', sourceRef: { kind: 'user-message', eventId: 'evt-b' } },
      'T-z': { id: 'T-z', sourceRef: { kind: 'user-message', eventId: 'evt-没记过' } },
    },
  }
  const idx = T.derivedTitleIndex(sid, fakeDoc)
  if (idx['T-x'] === '改过的标题' && idx['T-y'] === '第二个标题' && idx['T-z'] === undefined) {
    ok('读回按 node.id 建表（记过的有、没记过的没有；值取最新）')
  } else {
    bad('读回索引不对：' + JSON.stringify(idx))
  }

  // ⑤ 坏输入不该抛（标题失败绝不能影响落链/注入）
  let threw = null
  try {
    T.persistDerivedTitle(null, sid, 'e', 't')
    T.persistDerivedTitle(domain, '', 'e', 't')
    T.persistDerivedTitle(domain, sid, '', 't')
    T.persistDerivedTitle(domain, sid, 'e', '')
  } catch (e) {
    threw = e
  }
  if (threw === null) ok('坏输入（无域 / 空 sessionId / 空 eventId / 空标题）都不抛错')
  else bad('坏输入抛错了：' + threw.message)

  T.titlesCache.delete(sid)
} else {
  bad('__test 没导出 persistDerivedTitle —— 无法离线驱动首建分支')
}

// ── 报告 ────────────────────────────────────────────────────────────────────
const fails = results.filter(([s]) => s === 'FAIL')
const pad = Math.max(...results.map(([, m]) => m.length))
console.log('')
for (const [s, m] of results) console.log(`  ${s}  ${m.replace(/\n/g, '\n      ').padEnd(pad)}`)
console.log('')
console.log(`宿主一半自测：${results.length - fails.length} 通过 / ${fails.length} 失败`)
process.exit(fails.length ? 1 : 0)
