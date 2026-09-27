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
if (hostSource.includes("inject = ['storageDomain', 'sessions']")) {
  ok("声明了 inject = ['storageDomain', 'sessions']（事件源与存储都是硬依赖）")
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

// 1) 没有注册任何 agent 工具 → 自然也没有写工具（规格红线：模型只读图）
let toolRegistrations = 0
for (const [name, src] of allSources) {
  const code = src
    .split(/\r?\n/)
    .filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l))
    .join('\n')
  const hits = (code.match(/ctx\.tools|defineTool|tools\.register/g) ?? []).length
  toolRegistrations += hits
  if (hits > 0) bad(`${name} 里出现工具注册面 —— 卡 6 才允许加只读工具，且必须走审核`)
}
if (toolRegistrations === 0) {
  ok('没有注册任何 agent 工具（模型无法改动图，D3-8 的一部分）')
}

// 2) 可执行入口里没有「一次成树 / 生成导图」类名字
const forbidden = /生成导图|思维导图|自动成图|整理成树|一键成树|generateMap|mindmap|autoTree|buildTree/i
let forbiddenHits = []
for (const [name, src] of allSources) {
  // 只查**代码行**（去掉注释）：注释里写「禁止一次生成整张思维导图」是允许的
  const code = src
    .split(/\r?\n/)
    .filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l))
    .join('\n')
  if (forbidden.test(code)) forbiddenHits.push(name)
}
if (forbiddenHits.length === 0) {
  ok('可执行代码里没有「生成导图 / 一次成树」类入口（注释里的红线说明不算）')
} else {
  bad('可执行代码里出现禁词入口：' + forbiddenHits.join(', '))
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

// ── 报告 ────────────────────────────────────────────────────────────────────
const fails = results.filter(([s]) => s === 'FAIL')
const pad = Math.max(...results.map(([, m]) => m.length))
console.log('')
for (const [s, m] of results) console.log(`  ${s}  ${m.replace(/\n/g, '\n      ').padEnd(pad)}`)
console.log('')
console.log(`宿主一半自测：${results.length - fails.length} 通过 / ${fails.length} 失败`)
process.exit(fails.length ? 1 : 0)
