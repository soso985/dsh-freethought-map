/**
 * 临时（用完即删）：读 dsh-session 里 Session 的读接口实现，确认增量语义。
 */
import { readFileSync } from 'node:fs'

const f = (process.env.TEMP || '') + '/dsh-asar-extract/dsh/node_modules/@deepseek-ai/dsh-session/lib/index.js'
const s = readFileSync(f, 'utf8')

function show(name) {
  const needle = '\t' + name + '('
  let idx = s.indexOf(needle)
  let n = 0
  while (idx >= 0 && n < 3) {
    const line = s.slice(0, idx).split('\n').length
    console.log('=== ' + name + '  (行 ' + line + ') ===')
    console.log(s.slice(idx, idx + 460))
    console.log('')
    idx = s.indexOf(needle, idx + 1)
    n += 1
  }
  if (n === 0) console.log('（没找到 ' + name + '）\n')
}

show('snapshotEvents')
show('eventAt')
show('ownEvents')

// seq 是 getter 还是字段？
const seqIdx = s.indexOf('\tget seq()')
if (seqIdx >= 0) {
  console.log('=== get seq() ===')
  console.log(s.slice(seqIdx, seqIdx + 240))
}
