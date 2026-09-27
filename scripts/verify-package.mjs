/**
 * 卡 0 验收脚本：不启动宿主，只做「这个包能不能被宿主安全加载」的静态检查。
 *
 * 检查四件事：
 *   1. package.json / cordis.patch.yml 能解析，且关键字段齐全；
 *   2. 宿主一半与客户端一半都能作为 ESM **解析**（不是执行）；
 *   3. ./ 与 ./client 两个导出指向的文件真的存在；
 *   4. 客户端 module loader 的 id 与包名一致（宿主要求 id === 包名）。
 *
 * 用法：
 *   node scripts/verify-package.mjs
 */
import { readFileSync, existsSync } from 'node:fs'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { dirname, join, resolve } from 'node:path'
import vm from 'node:vm'

const here = dirname(fileURLToPath(import.meta.url))
const root = resolve(here, '..')

const fails = []
const passes = []

function ok(msg) {
  passes.push(msg)
}
function bad(msg) {
  fails.push(msg)
}

// 1. package.json
const pkgPath = join(root, 'package.json')
let pkg
try {
  pkg = JSON.parse(readFileSync(pkgPath, 'utf8'))
  ok('package.json 可解析')
} catch (e) {
  bad(`package.json 无法解析：${e.message}`)
}

if (pkg) {
  if (typeof pkg.name === 'string' && pkg.name) ok(`包名 = ${pkg.name}`)
  else bad('package.json 缺 name')

  if (pkg.type === 'module') ok('type = module')
  else bad(`type 应为 module，实际 ${JSON.stringify(pkg.type)}`)

  const exp = pkg.exports ?? {}
  for (const key of ['.', './client']) {
    const target = typeof exp[key] === 'string' ? exp[key] : exp[key]?.default
    if (!target) {
      bad(`exports["${key}"] 缺失`)
      continue
    }
    const abs = join(root, target)
    if (existsSync(abs)) ok(`exports["${key}"] → ${target} 存在`)
    else bad(`exports["${key}"] → ${target} 不存在`)
  }

  const patch = pkg.dsh?.bundle?.patch
  if (patch && existsSync(join(root, patch))) ok(`dsh.bundle.patch → ${patch} 存在`)
  else bad(`dsh.bundle.patch 缺失或指向不存在的文件：${JSON.stringify(patch)}`)

  const client = pkg.dsh?.client
  if (client?.platform === 'web') ok('dsh.client.platform = web')
  else bad(`dsh.client.platform 应为 web，实际 ${JSON.stringify(client?.platform)}`)

  // 4. loader id === 包名
  const clientFile = join(root, typeof exp['./client'] === 'string' ? exp['./client'] : exp['./client'].default)
  if (existsSync(clientFile)) {
    const text = readFileSync(clientFile, 'utf8')
    // 模块 id 可以写成字面量，也可以写成常量；两种写法都认，但值必须等于包名。
    //
    // 注意：`load(` 之后的花括号里可能夹着注释块，所以**不能**要求 `id` 与 `{` 邻接。
    // 只取 load({ 之后的第一处 id —— 那才是模块 id；文件里后面还有 slot 注册的 id
    // （如 'freethought-map-panel'），用贪婪匹配会误抓。
    const call = text.match(/__ModuleLoader__\s*\.\s*load\s*\(\s*\{([\s\S]*)/)
    if (!call) {
      bad('客户端文件里找不到 window.__ModuleLoader__.load({ ... })')
    } else {
      const head = call[1].slice(0, 1200)
      const lit = head.match(/\bid\s*:\s*['"]([^'"]+)['"]/)
      const ref = head.match(/\bid\s*:\s*([A-Za-z_$][\w$]*)/)
      let value = lit?.[1]
      if (!value && ref) {
        const constDecl = text.match(
          new RegExp(`(?:const|let|var)\\s+${ref[1]}\\s*=\\s*['"]([^'"]+)['"]`),
        )
        value = constDecl?.[1]
      }
      if (!value) bad('无法解析 module loader 的 id 取值')
      else if (value === pkg.name) ok(`module loader id = 包名 = ${value}`)
      else bad(`module loader id (${value}) 与包名 (${pkg.name}) 不一致`)
    }
  }
}

// 2. 语法解析
//    ⚠️ 两个入口的**语义不同**，不能用同一把尺子：
//      - src/host/index.js  ← 真 ESM，按模块解析
//      - src/client/index.js ← **普通脚本**（宿主用 <script src> 注入页面），
//        出现 export/import 反而会让浏览器抛 SyntaxError，所以必须按脚本解析。
const esmTargets = ['src/host/index.js']
const scriptTargets = ['src/client/index.js']
const ctx = vm.createContext({ console })

for (const rel of esmTargets) {
  const abs = join(root, rel)
  if (!existsSync(abs)) {
    bad(`${rel} 不存在`)
    continue
  }
  try {
    new vm.SourceTextModule(readFileSync(abs, 'utf8'), {
      identifier: pathToFileURL(abs).href,
      context: ctx,
    })
    ok(`${rel} ESM 模块语法解析通过`)
  } catch (e) {
    bad(`${rel} 解析失败：${e.message}`)
  }
}

for (const rel of scriptTargets) {
  const abs = join(root, rel)
  if (!existsSync(abs)) {
    bad(`${rel} 不存在`)
    continue
  }
  const text = readFileSync(abs, 'utf8')
  try {
    new vm.Script(text, { filename: abs })
    ok(`${rel} 普通脚本语法解析通过`)
  } catch (e) {
    bad(`${rel} 解析失败：${e.message}`)
  }
  if (/^\s*(export|import)\s/m.test(text)) {
    bad(`${rel} 出现 export/import —— 它会被当普通脚本注入，浏览器会抛 SyntaxError`)
  } else if (rel.includes('client')) {
    ok(`${rel} 没有 export/import（符合普通脚本约定）`)
  }
}

// 3. cordis.patch.yml 的插入行形状（不引 yaml 依赖，只做最小结构断言）
try {
  const yml = readFileSync(join(root, 'cordis.patch.yml'), 'utf8')
  if (/^\s*-\s*insert:/m.test(yml)) ok('cordis.patch.yml 含 insert 行')
  else bad('cordis.patch.yml 未发现 insert 行')
  if (yml.includes(`name: '${pkg?.name}'`)) ok('patch 行 name 指向本包')
  else bad(`patch 行 name 未指向 ${pkg?.name}`)
} catch (e) {
  bad(`cordis.patch.yml 读取失败：${e.message}`)
}

// 报告
console.log('')
for (const p of passes) console.log('  PASS  ' + p)
for (const f of fails) console.log('  FAIL  ' + f)
console.log('')
console.log(`卡 0 静态检查：${passes.length} 通过 / ${fails.length} 失败`)
process.exit(fails.length ? 1 : 0)
