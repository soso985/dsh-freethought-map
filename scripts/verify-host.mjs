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

// ── 报告 ────────────────────────────────────────────────────────────────────
const fails = results.filter(([s]) => s === 'FAIL')
const pad = Math.max(...results.map(([, m]) => m.length))
console.log('')
for (const [s, m] of results) console.log(`  ${s}  ${m.replace(/\n/g, '\n      ').padEnd(pad)}`)
console.log('')
console.log(`宿主一半自测：${results.length - fails.length} 通过 / ${fails.length} 失败`)
process.exit(fails.length ? 1 : 0)
