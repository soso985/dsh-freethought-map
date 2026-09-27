/**
 * 把 `src/overlay/io.js` 的 `helpText()` 编译进客户端 bundle。
 *
 * 为什么要"编译"而不是运行期取：客户端 bundle 是单文件自包含的惰性 CJS 注册，
 * **不能 import 相对模块**（官方 README 明令）。所以 bundle 里放一份逐字副本，
 * 由 `verify-io.mjs` 的断言锁住两边完全一致 —— 改了一边不改另一边会直接红。
 *
 * 用法：
 *   node scripts/build-help.mjs
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { helpText } from '../src/overlay/io.js'

const here = dirname(fileURLToPath(import.meta.url))
const target = join(here, '..', 'src', 'client', 'index.js')

const text = helpText()
// 模板字面量安全化：反斜杠、反引号、`${` 三个都要转，否则会被当转义或插值
const escaped = text
  .replace(/\\/g, '\\\\')
  .replace(/`/g, '\\`')
  .replace(/\$\{/g, '\\${')

const MARKER = 'const HELP_TEXT = `'
let source = readFileSync(target, 'utf8')
const start = source.indexOf(MARKER)

if (start >= 0) {
  const close = source.indexOf('`', start + MARKER.length)
  source = source.slice(0, start + MARKER.length) + escaped + source.slice(close)
  process.stdout.write('已替换现有 HELP_TEXT（' + String(text.length) + ' 字符）\n')
} else {
  const anchor = "const ROOT_ATTR = 'data-freethought-map-root'\n"
  if (!source.includes(anchor)) {
    process.stderr.write('找不到锚点 ROOT_ATTR，放弃\n')
    process.exit(1)
  }
  const block = [
    '',
    '/**',
    ' * 帮助短文 —— 由 `src/overlay/io.js` 的 `helpText()` **编译**过来（`scripts/build-help.mjs`）。',
    ' *',
    ' * 为什么是编译而不是运行期取：客户端 bundle 是单文件自包含的惰性 CJS 注册，',
    ' * **不能 import 相对模块**（官方 README 明令）。所以这里放一份逐字副本，',
    ' * 并由 `verify-io.mjs` 的断言锁住它与 `helpText()` 完全一致 ——',
    ' * 改了一边不改另一边会直接红。',
    ' */',
    'const HELP_TEXT = `' + escaped + '`',
    '',
  ].join('\n')
  source = source.replace(anchor, anchor + block)
  process.stdout.write('已插入 HELP_TEXT（' + String(text.length) + ' 字符）\n')
}

writeFileSync(target, source, 'utf8')
