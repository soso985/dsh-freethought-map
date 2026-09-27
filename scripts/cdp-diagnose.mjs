/**
 * CDP 诊断驱动 —— 在真实页面里手动跑插件的 factory/apply，把被宿主吞掉的异常挖出来。
 *
 * 为什么需要它：宿主的 boot 报错只写 `dsh-freethought-map: failed`，不给原因；
 * 而客户端激活失败的**真实异常**在 `onEntryState` 那条路径上被吞掉了。
 * 页面里没有全局 React，所以这里用**引导期的 module loader** 自己造一个模块系统
 * （`__ModuleLoader__.create({...})` 会把 queue 模式切到 live，并自带官方静态模块表），
 * 再 `modules.import('<我的 id>')` 拿到真正的 exports —— 这才是宿主走的同一条路。
 *
 * 参数：argv[2]=wsUrl argv[3]=origin argv[4]=token argv[5]=ws 模块目录
 */
import { createRequire } from 'node:module'
import { join } from 'node:path'

const [, , wsUrl, origin, token, wsModuleDir] = process.argv
const require = createRequire(join(wsModuleDir, 'noop.js'))
const WebSocket = require('ws')

const ws = new WebSocket(wsUrl, { perMessageDeflate: false, maxPayload: 64 * 1024 * 1024 })
let nextId = 1
const pending = new Map()
const consoleTexts = []

function send(method, params = {}) {
  const id = nextId++
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject })
    ws.send(JSON.stringify({ id, method, params }))
  })
}

ws.on('message', (raw) => {
  let msg
  try {
    msg = JSON.parse(raw.toString())
  } catch {
    return
  }
  if (msg.id && pending.has(msg.id)) {
    const { resolve, reject } = pending.get(msg.id)
    pending.delete(msg.id)
    if (msg.error) reject(new Error(msg.error.message))
    else resolve(msg.result)
    return
  }
  if (msg.method === 'Runtime.consoleAPICalled') {
    consoleTexts.push(
      `[${msg.params.type}] ` +
        (msg.params.args ?? []).map((a) => a.value ?? a.description ?? '').join(' '),
    )
  }
})

await new Promise((r) => ws.on('open', r))
await send('Runtime.enable')
await send('Page.enable')
await send('Page.navigate', { url: `${origin}/?token=${encodeURIComponent(token)}` })
await new Promise((r) => setTimeout(r, 5000))

async function evaluate(expression) {
  const r = await send('Runtime.evaluate', {
    expression,
    returnByValue: true,
    awaitPromise: true,
  })
  if (r.exceptionDetails) {
    return { __evalError: r.exceptionDetails.exception?.description ?? 'eval failed' }
  }
  return r.result?.value
}

const out = await evaluate(`(async () => {
  const report = { steps: [] };
  const log = (m) => report.steps.push(m);
  try {
    const boot = globalThis.__DSH_BOOT__;
    const entry = (boot?.entries || []).find(e => e.id === 'dsh-freethought-map');
    report.entry = entry || null;
    if (!entry) { report.fatal = 'boot 里没有本包的 entry'; return report; }

    // 用引导 loader 造一个模块系统：create() 会把 queue 模式切到 live。
    // 注意 create() 会从 pendingQueue 里**移除** client-modules 那条并当场求值它，
    // 所以如果页面已经自己 boot 过，这里可能会失败 —— 那就退回 fetch+Function 路线。
    const loader = globalThis.__ModuleLoader__;
    report.loaderModeBefore = loader.mode;
    if (loader.mode !== 'queue') { report.note = 'loader 已 live，无法再 create；仅报告 entry'; return report; }

    let modules = null;
    try {
      modules = loader.create({ boot, staticModules: {} });
      report.createOk = true;
    } catch (e) {
      report.createError = String(e && e.stack || e);
      return report;
    }

    // 用同一个模块系统 import 我们的 bundle —— 这才是宿主走的路径
    try {
      const mod = await modules.import(entry.id);
      report.importOk = true;
      report.exportsKeys = mod ? Object.keys(mod) : null;
      report.inject = mod && mod.inject;
      log('import ok, exports=' + JSON.stringify(report.exportsKeys));
      if (mod && typeof mod.apply === 'function') {
        // 用一个会记录每一步的假 ctx，看 apply 在哪一步炸
        const calls = [];
        const rec = (label) => { calls.push(label); };
        const fakeCtx = {
          effect(fn, label) {
            rec('effect:' + label);
            try { return fn(); }
            catch (e) { throw new Error('effect[' + label + '] 抛错: ' + (e && e.stack || e)); }
          },
          logger: { info: (m) => calls.push('log:' + String(m).slice(0, 90)) },
          slots: {
            inject(key, cb) { rec('inject:' + key); return cb(); },
            register(opts) { rec('register:' + opts.name); return () => {}; },
          },
          sidebarRightTabs: { register(d) { rec('tabType:' + d.kind); return () => {}; } },
          sidebarRight: { mounted: undefined, openTab() { rec('openTab'); } },
        };
        try {
          mod.apply(fakeCtx);
          report.applyOk = true;
        } catch (e) {
          report.applyError = String(e && e.stack || e);
        }
        report.calls = calls;
      }
    } catch (e) {
      report.importError = String(e && e.stack || e);
    }
    return report;
  } catch (e) {
    report.fatal = String(e && e.stack || e);
    return report;
  }
})()`)

console.log(JSON.stringify(out, null, 2))
if (consoleTexts.length) {
  console.log('\n--- 页面控制台 ---')
  for (const t of consoleTexts.slice(0, 25)) console.log(t.slice(0, 400))
}
ws.close()
