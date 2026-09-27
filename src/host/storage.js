/**
 * 宿主一半的权威存储（卡 2）—— overlay 领域 + 乐观并发 + Remote 端点。
 *
 * 设计依据（都有实测证据，见 docs/HOST.md §3.6 / §3.9）：
 *
 * 1. **宿主存储没有任何内建乐观并发。** `ctx.storageDomain` 只有「每领域一条写链」做串行化，
 *    没有 CAS、没有 revision。所以规格 §9 要求的 `rev` + 409 必须由本插件自己实现
 *    （`applySave` 在 `src/overlay/index.js` 里，纯函数、有单测）。
 *
 * 2. **原子性靠 `table.update()` 的写链槽位。** 存储领域 README 原文：「`update` 的变换在链上
 *    自己的槽位运行，因此并发更新绝不会交错」。所以「读当前 → 比对 baseRev → 写回」必须整段
 *    放进一个 `update` 回调；拆成 `get()` 之后再 `put()` 的话，两个并发 save 会双双通过比对。
 *
 * 3. **不 import 任何裸包名。** 实测：宿主 runtime 与本 profile 都解析不到 `@deepseek-ai/*`、
 *    `zod`、`schemastery`（`app.asar.unpacked/dsh/node_modules` 只有 3 个包）。所以：
 *      · 不 import `defineDomain` / `domainTable`，改为**手写等价 spec 对象**
 *        （领域层只读 `spec.name/version/tables[].valueSchema`，并在 `valueSchema.parse()`
 *         处校验记录 —— 那是它唯一真正调用的 schema 方法）；
 *      · 不 import `zod`，记录 schema 用鸭子类型（只要 `parse()` 能「返回记录或抛错」）；
 *      · 不 import `@deepseek-ai/dsh-typert-protocol`，Remote 元数据按协议实现手写。
 *    这些形状都是从随包发布的**生成产物**与协议实现里逐字核对过的，不是猜的。
 */

import {
  SAVE_CONFLICT,
  SAVE_OK,
  SAVE_REJECTED,
  applySave,
  canSetParent,
  createOverlay,
  validateOverlay,
} from '../overlay/index.js'
import { setCanSetParent } from '../overlay/undo.js'
import {
  SettlementLog,
  applyProjection,
  backfill,
  planProjection,
  settlementKindOf,
} from '../overlay/project.js'
import { createPending, pendingAdd, pendingRemove } from '../overlay/links.js'
import { INJECT_DONE, computeInjection, consumeInjectedSnapshot } from '../overlay/inject.js'
import { registerReadonlyTools } from '../overlay/tools.js'
import { appendProbeEntry, buildProbeEntry } from './hook-probe.js'
import {
  exportJson,
  exportMarkdown,
  mergeImport,
  parseJsonSafely,
  rebuildProjection,
  validateImport,
} from '../overlay/io.js'

/**
 * 领域层与 json 后端实际强制执行的名称正则（`dsh-storage/lib/index.js:80`）：
 * `/^[a-z][a-z0-9_]*$/` —— **首字母小写字母开头，其余只能是小写字母、数字、下划线**。
 * 连字符会让后端在打开单元时抛 `malformed-medium: invalid unit name`。
 * 这里复制一份，好在模块加载时就报错，而不是等开机后才发现。
 */
const UNIT_NAME_RE = /^[a-z][a-z0-9_]*$/

/** 领域名与表名都必须匹配 `UNIT_NAME_RE`。**不能用连字符** —— 实测踩过。 */
const DOMAIN_NAME = 'freethought_map'
const DOMAIN_VERSION = 1
const TABLE = 'overlays'
const SERVICE_KEY = 'freethoughtMap'
const PACKAGE_NAME = 'dsh-freethought-map'

// ───────────────────────────── 记录 schema（鸭子类型） ─────────────────────────────

/**
 * 领域层真正调用的只有 `valueSchema.parse(raw)`（`dsh-storage-domain/lib/index.js:371`），
 * 失败会被包成 `invalid-record` 并指出表与键。`safeParse` 只在 `global` schema 上用到，
 * 这里没有 global schema，但一并提供以便形状与 zod 一致（也让测试能直接调用）。
 */
const overlayRecordSchema = {
  parse(raw) {
    const result = validateOverlay(raw)
    if (!result.ok) {
      const err = new Error('overlay 记录不合法：' + result.errors.slice(0, 5).join('；'))
      err.issues = result.errors
      throw err
    }
    return raw
  },
  safeParse(raw) {
    try {
      return { success: true, data: this.parse(raw) }
    } catch (e) {
      return { success: false, error: e }
    }
  },
}

/**
 * 领域 spec。字段与 `defineDomain({name, version, tables})` 的产物一致；
 * `defineDomain` 在模块加载时做的那几条校验（名字正则、版本非负整数）这里自己复制一遍 ——
 * 代价是三行，换来「不依赖宿主能解析到任何包」。
 */
function makeDomainSpec() {
  if (!UNIT_NAME_RE.test(DOMAIN_NAME)) throw new Error('非法领域名（须匹配 ' + UNIT_NAME_RE + '）：' + DOMAIN_NAME)
  if (!UNIT_NAME_RE.test(TABLE)) throw new Error('非法表名（须匹配 ' + UNIT_NAME_RE + '）：' + TABLE)
  if (!Number.isInteger(DOMAIN_VERSION) || DOMAIN_VERSION < 0) {
    throw new Error('领域版本必须是非负整数')
  }
  return {
    name: DOMAIN_NAME,
    version: DOMAIN_VERSION,
    tables: { [TABLE]: { valueSchema: overlayRecordSchema } },
  }
}

// ───────────────────────────── Remote 元数据 ─────────────────────────────

/**
 * Remote 方法的原型标记键。这是 typert 协议的**私有约定**（一个字符串常量）。
 * 官方 README 只承诺「字符串属性名稳定」，未承诺 version 1 永久 —— 见风险表。
 */
const REMOTE_METHOD_DESCRIPTOR = '@deepseek-ai/dsh-typert-protocol/remote-methods'

/**
 * 给服务原型打上 Remote 方法标记。形状对照协议实现的 `mark()`
 * （`dsh-typert-protocol/lib/index.js:248-268`）：
 * `{ version: 1, methods: [{ method, invocation: { kind: 'direct' } }] }`，
 * 用 `Object.defineProperty` 写成不可枚举的 own property（与 `mark()` 一致）。
 *
 * ⚠️ 网关用 `Function.prototype.toString` 解析**参数名**当 wire 字段名
 * （`dsh-api-gateway/lib/index.js:1458-1484`），因此被标记的方法：
 *   - 参数只能是**简单标识符**（不能有默认值、解构、剩余参数）；
 *   - 参数名一旦改动，客户端契约就断了 —— 必须与 `buildRemoteContribution()` 同步。
 */
function markRemoteMethods(Ctor, methods) {
  Object.defineProperty(Ctor.prototype, REMOTE_METHOD_DESCRIPTOR, {
    configurable: true,
    value: Object.freeze({
      version: 1,
      methods: Object.freeze(
        methods.map((method) =>
          Object.freeze({ method, invocation: Object.freeze({ kind: 'direct' }) }),
        ),
      ),
    }),
  })
}

// ───────────────────────────── 服务 ─────────────────────────────

/**
 * 权威存储服务。
 *
 * **不 `class extends Service`**（那需要 import cordis 的基类），改为普通类 + 手动 provide
 * + 手动挂 `typertRemote`。网关的 SRC 发现只做两件事
 * （`dsh-api-gateway/lib/index.js:698-711`）：
 *   1. 遍历 `ctx.reflect.props` 里 `type === 'service'` 的条目，`ctx.get(key)` 拿实例；
 *   2. 读实例上的 `typertRemote`，要求是对象且 `namespace` 是字符串。
 * 再加上原型上的 marker，端点就被认领了。
 */
class FreethoughtMapHostService {
  /**
   * @param {any} ctx
   * @param {() => Promise<any>} getDomain 惰性拿领域句柄（首次打开是异步的）
   */
  constructor(ctx, getDomain) {
    this.ctx = ctx
    this.getDomain = getDomain
    // 绑定形状对照 bindTypertRemote()：{ service, serviceKey, namespace }，frozen。
    this.typertRemote = Object.freeze({
      service: this,
      serviceKey: SERVICE_KEY,
      namespace: SERVICE_KEY,
    })
  }

  /**
   * 读取某个会话的权威 overlay。不存在则按需铸造一份空的并落盘。
   *
   * @param {string} sessionId
   */
  async load(sessionId) {
    if (typeof sessionId !== 'string' || !sessionId) {
      return { ok: false, error: 'sessionId 必须是非空字符串' }
    }
    try {
      const domain = await this.getDomain()
      const table = domain.table(TABLE)
      const existing = table.get(sessionId)
      if (existing !== undefined && existing !== null) {
        return { ok: true, doc: existing, rev: existing.rev }
      }
      // 没有记录 = 这个会话第一次用。落一份空的权威，之后的 save 才有 baseRev 可比。
      const fresh = createOverlay(sessionId)
      await table.put(sessionId, fresh)
      return { ok: true, doc: fresh, rev: fresh.rev }
    } catch (e) {
      return { ok: false, error: describeError(e) }
    }
  }

  /**
   * 乐观并发保存（规格 §9 第 3 条）。
   *
   * 整段「读当前 → 比对 → 写回」放在**同一个 `update` 槽位**里，所以并发 save 不会双双通过。
   * 冲突时**绝不写入**，并把权威 doc + rev 回给客户端，由它决定重载还是提示用户。
   *
   * @param {string} sessionId
   * @param {object} doc      客户端提交的 OverlayDoc
   * @param {number} baseRev  客户端认为的当前版本号
   */
  async save(sessionId, doc, baseRev) {
    if (typeof sessionId !== 'string' || !sessionId) {
      return { ok: false, error: 'sessionId 必须是非空字符串' }
    }
    if (!Number.isInteger(baseRev) || baseRev < 0) {
      return { ok: false, error: 'baseRev 必须是非负整数' }
    }
    try {
      const domain = await this.getDomain()
      const table = domain.table(TABLE)

      // 先确保记录存在：不存在时补一份空权威，否则 update 会报 missing-key。
      let current = table.get(sessionId)
      if (current === undefined || current === null) {
        current = createOverlay(sessionId)
        await table.put(sessionId, current)
      }

      // 关键：结果由写链槽位里的纯函数算出，再决定是否真的换掉记录。
      let outcome = null
      const result = await table.update(sessionId, (authoritative) => {
        outcome = applySave(authoritative, doc, baseRev)
        // 只有 ok 才换记录；conflict / rejected 一律原样返回（= 不写，权威不动）
        return outcome.status === SAVE_OK ? outcome.doc : authoritative
      })

      if (!outcome) {
        return { ok: true, status: SAVE_CONFLICT, doc: result, rev: result && result.rev ? result.rev : 0 }
      }
      if (outcome.status === SAVE_OK) {
        return { ok: true, status: SAVE_OK, doc: result, rev: result.rev }
      }
      if (outcome.status === SAVE_CONFLICT) {
        return { ok: true, status: SAVE_CONFLICT, doc: result, rev: result.rev }
      }
      return { ok: true, status: SAVE_REJECTED, reason: outcome.reason, doc: result }
    } catch (e) {
      return { ok: false, error: describeError(e) }
    }
  }

  /** 探针/诊断用：报告领域与表名，便于在磁盘上找到落盘位置。 */
  async describe() {
    return {
      domain: DOMAIN_NAME,
      version: DOMAIN_VERSION,
      table: TABLE,
      service: SERVICE_KEY,
    }
  }

  /**
   * 读某个会话最近见过的结算事件（卡 3 的验收面）。
   *
   * 为什么需要这个出口：只看 overlay 分不清「宿主没收到事件」和「收到了但按去重/摘除
   * 跳过了」。有了它，验收脚本能把「事件流」与「图」两侧对齐着看。
   *
   * @param {string} sessionId
   * @param {number} sinceSeq
   */
  async events(sessionId, sinceSeq) {
    if (typeof sessionId !== 'string' || !sessionId) {
      return { ok: false, error: 'sessionId 必须是非空字符串' }
    }
    const since = Number.isInteger(sinceSeq) ? sinceSeq : -1
    return { ok: true, entries: settlementLog.list(sessionId, since) }
  }

  /**
   * 拉/删粉线后同步「待注入」集合（卡 5）。客户端拥有 pending 语义，
   * 这里只保存一份，好让 `agent/pre-step` 注入时取得到。
   *
   * @param {string} sessionId
   * @param {object} payload `{ add?: string[], remove?: string[] }`
   */
  async setPendingLinks(sessionId, payload) {
    if (typeof sessionId !== 'string' || !sessionId) {
      return { ok: false, error: 'sessionId 必须是非空字符串' }
    }
    const add = payload && Array.isArray(payload.add) ? payload.add : []
    const remove = payload && Array.isArray(payload.remove) ? payload.remove : []
    let p = pendingBySession.get(sessionId) || createPending()
    for (const id of add) p = pendingAdd(p, String(id))
    for (const id of remove) p = pendingRemove(p, String(id))
    pendingBySession.set(sessionId, p)
    return { ok: true, pending: [...p.ids] }
  }

  /**
   * 注入诊断面：把「本轮准备注入什么」记下来，供验收读取。
   *
   * 为什么需要：注入是否真的生效，**只有真实发送才能验**。有了这张表，
   * 用户下一次真实发送时，我们能立刻从日志确认注入内容与条数，而不必靠猜。
   *
   * @param {string} sessionId
   * @param {number} sinceSeq
   */
  async injections(sessionId, sinceSeq) {
    if (typeof sessionId !== 'string' || !sessionId) {
      return { ok: false, error: 'sessionId 必须是非空字符串' }
    }
    const since = Number.isInteger(sinceSeq) ? sinceSeq : -1
    return { ok: true, entries: injectionLog.list(sessionId, since) }
  }
  /**
   * 导出：`kind` 取 `'json'` | `'markdown'`（卡 8）。
   *
   * PNG 不在宿主侧 —— 它需要真画布，只能由客户端渲染。宿主**不做假的空图**，
   * 而是明确返回一个可读的说明（见下面的 png 分支）。
   */
  async exportDoc(sessionId, kind) {
    if (typeof sessionId !== 'string' || !sessionId) {
      return { ok: false, error: 'sessionId 必须是非空字符串' }
    }
    const domain = await readyDomain(this.getDomain)
    if (!domain) return { ok: false, error: '存储领域尚未就绪' }
    const doc = domain.table(TABLE).get(sessionId)
    if (!doc) return { ok: false, error: '该会话还没有图' }

    if (kind === 'png') {
      return {
        ok: false,
        error: 'PNG 导出需要画布，画布还没做 —— 这里刻意不导出空图（那会给你一张假的图）。',
      }
    }
    if (kind === 'markdown') {
      return { ok: true, kind, text: exportMarkdown(doc, { derivedTitles: derivedTitleIndex(sessionId) }) }
    }
    return { ok: true, kind: 'json', text: exportJson(doc, { now: Date.now() }) }
  }

  /**
   * 导入：校验 + 合并（卡 8，规格 §11）。
   *
   * 合并**不是**整份替换：文件里的 manual/parentId/position/注解/hidden/粉线采用文件，
   * 但 canonical 仍需要且未在 hidden 中的投影**不得删除**（`mergeImport` 负责）。
   *
   * @param {string} sessionId
   * @param {string} json 导入的 JSON 文本
   */
  async importDoc(sessionId, json) {
    if (typeof sessionId !== 'string' || !sessionId) {
      return { ok: false, error: 'sessionId 必须是非空字符串' }
    }
    const parsed = parseJsonSafely(json)
    if (!parsed.ok) return { ok: false, error: 'JSON 解析失败：' + String(parsed.detail || parsed.reason) }

    const v = validateImport(parsed.value, {
      sessionId,
      jsonBytes: typeof json === 'string' ? json.length : 0,
    })
    if (!v.ok) {
      return { ok: false, error: '导入被拒绝（' + v.reason + '）' + (v.detail ? '：' + v.detail : '') }
    }

    const domain = await readyDomain(this.getDomain)
    if (!domain) return { ok: false, error: '存储领域尚未就绪' }
    const table = domain.table(TABLE)

    let merged = null
    await table.update(sessionId, (current) => {
      const base = current === undefined || current === null ? createOverlay(sessionId) : current
      const r = mergeImport(base, v.doc)
      merged = r
      // 导入改了权威内容 → 递增 rev（规格 §9.0）。判断依据用 stats：
      // 更新/新增/隐藏项任一非零就算内容变了。
      const st = r.stats || {}
      const changed = (st.updated || 0) + (st.added || 0) + (st.kept || 0) + (st.hidden || 0) > 0
      return commitAuthorityWrite(base, r.doc, changed)
    })

    return {
      ok: true,
      warnings: v.warnings,
      stats: merged ? merged.stats : null,
      doc: merged ? merged.doc : null,
    }
  }

  /**
   * 重建投影（卡 8 / 规格 §6.5）：对**当前已加载窗口**跑落链算法。
   *
   * `events` 由客户端从官方会话读取后传入 —— 宿主拿不到"当前已加载窗口"这个概念，
   * 那是客户端视图状态。
   *
   * @param {string} sessionId
   * @param {any[]} events
   */
  async rebuild(sessionId, events) {
    if (typeof sessionId !== 'string' || !sessionId) {
      return { ok: false, error: 'sessionId 必须是非空字符串' }
    }
    if (!Array.isArray(events)) return { ok: false, error: 'events 必须是数组' }
    const domain = await readyDomain(this.getDomain)
    if (!domain) return { ok: false, error: '存储领域尚未就绪' }
    const table = domain.table(TABLE)

    let out = null
    await table.update(sessionId, (current) => {
      const base = current === undefined || current === null ? createOverlay(sessionId) : current
      out = rebuildProjection(base, events, { backfill })
      // 补链新增了节点才算内容变了 → 递增 rev（规格 §9.0）。
      // `appended === 0` 时不动 rev：空跑递增会让用户操作无谓地撞 409。
      return commitAuthorityWrite(base, out.doc, (out.appended || 0) > 0)
    })
    return { ok: true, appended: out ? out.appended : 0, skipped: out ? out.skipped : 0, violations: out ? out.violations : [] }
  }
}

/**
 * 结算事件环形缓冲：host 侧单例，记录每个会话见过的结算与处置结果。
 * 放在模块级是因为它只是诊断面，生命周期跟着进程走即可。
 */
const settlementLog = new SettlementLog(200)

/** 每会话的「待注入粉线」集合（卡 5）。 */
const pendingBySession = new Map()

/**
 * 每会话「最近一次注入用掉的快照 id」。
 * 等对应的 `user/message` 真正落盘后再消费（规格 §10.3 第 2 条）。
 */
const injectedSnapshots = new Map()

/** 注入诊断日志（卡 5）：记「哪一轮注入了什么」。 */
const injectionLog = new SettlementLog(200)

// 端点名由 marker 决定，见 docs/HOST.md §3.15。
markRemoteMethods(FreethoughtMapHostService, [
  'load',
  'save',
  'describe',
  'events',
  'setPendingLinks',
  'injections',
  'exportDoc',
  'importDoc',
  'rebuild',
])

function describeError(e) {
  if (!e) return 'unknown'
  const code = e && e.code ? String(e.code) + ': ' : ''
  return code + (e && e.message ? String(e.message) : String(e))
}

// ───────────────────────────── Remote 契约（客户端要挂的形状） ─────────────────────────────

/**
 * 恒等 codec：真正的结构校验在宿主侧 `applySave` / `validateOverlay` 里做，客户端不做第二份。
 * 但 `create` 与 `typeSymbol` 都不能省 —— 否则客户端注册表会直接抛
 * （`dsh-typert-registry/lib/client.js:1356-1357`）。
 */
const IDENTITY_CODEC = () => ({ parse: (v) => v })

function remoteParam(name) {
  return {
    name,
    wire: name,
    source: 'json',
    codec: { mode: 'strict', typeSymbol: PACKAGE_NAME + '#' + name, create: IDENTITY_CODEC },
  }
}

/**
 * 客户端一半要挂载的 Remote 描述符。形状对照随包发布的生成产物
 * （`dsh-client-ui-plugin-manager/lib/typert.remote-client.js`）。
 *
 * 客户端一half 里有一份**逐字段相同**的副本（它们不能互相 import）；
 * `scripts/verify-host.mjs` 会把两份拉出来做深度比对，防止漂移。
 */
export function buildRemoteContribution() {
  const mk = (method, parameters) => ({
    id: PACKAGE_NAME + '#' + SERVICE_KEY + '/' + method,
    service: SERVICE_KEY,
    namespace: SERVICE_KEY,
    method,
    invocation: { kind: 'direct' },
    parameters,
    // 结果不强制 strict；宿主返回的就是普通 JSON。
    result: { mode: 'src-json' },
  })
  return {
    package: PACKAGE_NAME,
    descriptors: [
      mk('load', [remoteParam('sessionId')]),
      mk('save', [remoteParam('sessionId'), remoteParam('doc'), remoteParam('baseRev')]),
      mk('describe', []),
      mk('events', [remoteParam('sessionId'), remoteParam('sinceSeq')]),
      mk('setPendingLinks', [remoteParam('sessionId'), remoteParam('payload')]),
      mk('injections', [remoteParam('sessionId'), remoteParam('sinceSeq')]),
      mk('exportDoc', [remoteParam('sessionId'), remoteParam('kind')]),
      mk('importDoc', [remoteParam('sessionId'), remoteParam('json')]),
      mk('rebuild', [remoteParam('sessionId'), remoteParam('events')]),
    ],
  }
}

// ───────────────────────────── 插件入口 ─────────────────────────────

function log(ctx, message) {
  try {
    const logger = ctx && ctx.logger
    if (logger && typeof logger.info === 'function') logger.info('[freethought-map] ' + message)
  } catch {
    /* 日志不可用绝不能影响激活 */
  }
}

/**
 * 插件声明依赖的服务。
 *
 * ⚠️ Cordis 不会让你「碰运气访问」一个没声明的服务：`ctx.storageDomain` 在没写进 `inject`
 * 时会直接抛 `cannot get property "storageDomain" without inject`，而 `apply()` 里的异常
 * 会让**整行激活失败** → 整个 Web 前端拒绝加载。本轮实测踩到过（宿主日志里的原文）。
 *
 * `storageDomain` 由 `@deepseek-ai/dsh-storage-domain` 提供，而它在 `dsh-base` 的 bundle 里
 * 是默认挂载的（config: `backend: json`，root 指向 `$DSH_HOME/storages`），所以 web profile
 * 一定有它。真遇到没有它的 profile，让这一行明确失败比默默降级更好排查。
 *
 * `sessions` 是会话事件源（`'session/event'` 从它上面发），用于卡 3 的落链订阅。
 * `tools` 是工具注册表，卡 6 的只读三工具挂在它上面。
 */
export const inject = ['storageDomain', 'sessions', 'tools']

/**
 * 宿主插件入口。
 *
 * ⚠️ 纪律：`apply()` 里**不要 await**。宿主在组合阶段判定一行是否激活，`apply` 里冒出的异常
 * （包括 await 出来的）会把整行判为激活失败，而激活失败会让**整个 Web 前端拒绝加载**
 * （实测踩过：页面只剩 "Failed to load plugins"）。所以这里只同步登记，
 * 异步打开放进 effect 里的 promise，失败只记日志 + 让 RPC 返回错误。
 *
 * @param {any} ctx
 */
export function apply(ctx) {
  // 先把防环实现接给 undo.js（客户端 bundle 不能 import 相对模块，所以用注入而非 import）。
  // 两侧都必须接：宿主这一半，以及客户端的副本。
  setCanSetParent(canSetParent)

  const spec = makeDomainSpec()

  /** 惰性打开的领域句柄：多次调用共享同一个 promise。 */
  let domainPromise = null
  const getDomain = () => {
    if (domainPromise === null) {
      domainPromise = ctx.storageDomain.open(spec).catch((e) => {
        // 打开失败要把错误交给调用方，而不是留一个永远 pending 的 promise
        domainPromise = null
        throw e
      })
    }
    return domainPromise
  }

  // 提前打开一次：启动日志里就能看出领域是否可用（配置错/后端缺失会在此暴露）
  ctx.effect(
    () => {
      let disposed = false
      getDomain().then(
        () => {
          if (!disposed) log(ctx, 'overlay 领域已打开：' + DOMAIN_NAME + '/' + TABLE)
        },
        (e) => {
          if (!disposed) {
            log(ctx, 'overlay 领域打开失败（插件仍会激活，RPC 会返回错误）：' + describeError(e))
          }
        },
      )
      return () => {
        disposed = true
        const p = domainPromise
        domainPromise = null
        if (p) {
          p.then(
            (domain) => {
              try {
                domain.close()
              } catch {
                /* 已关闭就忽略 */
              }
            },
            () => {},
          )
        }
      }
    },
    'freethought-map: overlay domain',
  )

  const service = new FreethoughtMapHostService(ctx, getDomain)

  // provide 成 cordis service —— 网关的 SRC 发现只认 `ctx.reflect.props` 里
  // `type === 'service'` 的条目（`dsh-api-gateway/lib/index.js:698-707`）。
  ctx.effect(
    () => {
      const dispose = ctx.reflect.provide(SERVICE_KEY, service)
      return () => {
        if (typeof dispose === 'function') dispose()
      }
    },
    'freethought-map: host service',
  )

  // (c) 落链：订阅会话事件，把结算投影成链（卡 3 / 规格 §6.3–6.5）。
  //
  // 事件名与服务都有实证：`'session/event'(session, event)`，服务 `ctx.sessions`
  // （`dsh-tool-cordis/lib/types/api-catalog.js:4056-4061`；监听实证 `dsh-agent-loop/lib/index.js:319`）。
  //
  // 三条纪律：
  //   1. 只认 `isAppendSurfaceEvent`（surfaceOp === 'append'）。替换副本也会发同一个事件，
  //      不过滤就会把同一个结算消费两次。
  //   2. 事件是 **post-commit、fire-and-forget**：观察者抛错只记日志，不会让 append 失败
  //      （`api-catalog.js:4060`）。所以这里**绝不能让异常逃出去**，更不能拿它当门禁。
  //   3. 投影写回走**同一个 `update` 写链槽位**，与 save 共享 rev 序列 —— 否则用户保存与
  //      自动投影会互相覆盖（规格 §9 第 4 条）。
  ctx.effect(
    () => {
      const onSessionEvent = (session, event) => {
        try {
          const sessionId = sessionIdOf(session)

          // 先处理「消费」：用户消息真正落盘后，把这一次注入用掉的粉线从 pending 移出
          // （规格 §10.3 第 2 条）。放在投影之前，因为消费与投影是两件事。
          if (sessionId && event && event.type === 'user/message') {
            const used = injectedSnapshots.get(sessionId)
            if (used && used.length) {
              const cur = pendingBySession.get(sessionId) || createPending()
              pendingBySession.set(sessionId, consumeInjectedSnapshot(cur, used))
              injectedSnapshots.delete(sessionId)
            }
          }

          const kind = settlementKindOf(event)
          if (!kind) return // 不是 append 结算：stream 帧、工具过程、替换副本、失败尝试
          if (!sessionId) {
            settlementLog.record('?', event, 'no-session-id')
            return
          }
          // 投影是异步的（要等领域句柄），且必须串行 —— 用一条 promise 链排队
          projectionChain = projectionChain
            .then(() => projectOne(ctx, getDomain, sessionId, event, kind))
            .catch((e) => {
              settlementLog.record(sessionId, event, 'error:' + describeError(e))
              log(ctx, '投影失败（已隔离，不影响会话）：' + describeError(e))
            })
        } catch (e) {
          // 连判断都炸了也不能让它冒出去 —— 那会污染别人的 session/event 监听
          log(ctx, '处理 session/event 时抛错（已吞掉）：' + describeError(e))
        }
      }

      ctx.on('session/event', onSessionEvent)
      // **不写 `ctx.off(...)`**：Cordis 的 `ctx.on` 是 scope-owned —— 监听器随当前 fiber
      // 一起销毁，`ctx.effect` 的返回值只需要清理「Cordis 不管的东西」（DOM 监听、定时器）。
      // 实证：全树 23 个官方包、130+ 处 `ctx.on`，**没有一处**配套 `ctx.off`。
      // 手写 `ctx.off` 反而有风险：名字/签名对不上时会在卸载路径上抛错。
      return undefined
    },
    'freethought-map: settlement projection',
  )

  // (d) 发送前注入（卡 5 / 规格 §10.3、§10.4）。
  //
  // 事件形状（`dsh-tool-cordis/lib/types/api-catalog.js` 的 `'agent/pre-step'`）：
  //   waterfall，`payload = { agent, messages: UserMessage[], turn, step, signal }`，
  //   `next(): Promise<PreStepDecision>`；
  //   `PreStepDecision = { kind:'reject' } | { kind:'enter', messages: UserMessage[], startsRequestSeries?: true }`
  //
  // 四条纪律：
  //   1. **必须 `await next()`** —— 不然会吞掉下游所有 listener 的决策。
  //      （官方 practice：「waterfall listener that does not own the decision must return next()」）
  //   2. 返回时是**整体替换** `messages`，所以要自己保留原数组
  //      （照抄 `dsh-agent-instructions` 的 toSpliced 写法）。
  //   3. **不唤醒、不 followup、不改写用户原文** —— 只往消息批次里**插**一条带
  //      `[用户图数据]` 前缀的 user 消息。
  //   4. 重试复用同一份快照：key 用 `${sessionId}:${turn}:${step}`
  //      （同一次发送重试时 turn/step 不变）。
  ctx.effect(
    () => {
      const onPreStep = async (payload, next) => {
        // 探针：**每次调用都写一行**（含抛错的情形），用来回答
        // 「宿主到底有没有调用 agent/pre-step」。写盘失败不影响对话。
        const startedAt = Date.now()
        let probeOutcome = 'unknown'
        let probeSessionId = null
        let probeInjection = null
        let probeError = null
        let originalDecision = null
        let finalDecision = null

        const decision0 = await next()
        originalDecision = decision0
        try {
          // 决策逻辑全在 `computeInjection`（纯函数，可离线验死）。
          // 这里只负责：取权威 doc、调它、记日志、把结果还给宿主。
          if (!decision0 || decision0.kind !== 'enter') {
            probeOutcome = 'decision-not-enter'
            finalDecision = decision0
            return decision0
          }
          const sessionId = sessionOfAgent(payload && payload.agent)
          probeSessionId = sessionId
          if (!sessionId) {
            probeOutcome = 'no-session-id'
            finalDecision = decision0
            return decision0
          }

          // 领域打开是异步的 → 用已就绪的句柄；没就绪就不注入，绝不挡这一轮对话
          const domain = await readyDomain(getDomain)
          if (!domain) {
            probeOutcome = 'no-domain'
            finalDecision = decision0
            return decision0
          }
          const doc = domain.table(TABLE).get(sessionId)
          if (!doc) {
            probeOutcome = 'no-doc'
            finalDecision = decision0
            return decision0
          }

          const result = computeInjection({
            decision: decision0,
            payload: { ...payload, sessionId },
            doc,
            pending: pendingBySession.get(sessionId) || createPending(),
            derivedTitles: derivedTitleIndex(sessionId),
            snapshotStore,
          })
          probeOutcome = result.status
          probeInjection = result.meta || null

          if (result.status === INJECT_DONE) {
            injectionLog.record(sessionId, syntheticEvent(payload, 'inject'), INJECT_DONE, result.meta)
            // 记下这一次注入用的快照 id，等对应的 user/message 真正落盘后再消费。
            // 不在这一刻消费：此刻消息还没被 canonical 接受（规格 §10.3：
            // 「该用户消息被 canonical 接受后，消费」）。
            injectedSnapshots.set(sessionId, result.snapshot.newPinkLinksAtSend || [])
          } else {
            injectionLog.record(sessionId, syntheticEvent(payload, 'skip'), result.status)
          }
          finalDecision = result.decision
          return result.decision
        } catch (e) {
          // 注入失败绝不能挡住这一轮对话 —— 记一条然后原样放行
          probeError = describeError(e)
          probeOutcome = 'error'
          finalDecision = decision0
          log(ctx, 'pre-step 注入失败（已放行原决策）：' + probeError)
          return decision0
        } finally {
          // 探针写在 finally 里：成功、跳过、抛错三种情形都会落一行
          appendProbeEntry(
            buildProbeEntry({
              payload,
              originalDecision,
              finalDecision,
              sessionId: probeSessionId,
              outcome: probeOutcome,
              injection: probeInjection,
              durationMs: Date.now() - startedAt,
              error: probeError,
            }),
          )
        }
      }

      ctx.on('agent/pre-step', onPreStep)
      return undefined
    },
    'freethought-map: send-time injection',
  )

  // (e) 只读三工具（卡 6 / 规格 §3 红线 2）。
  //
  // 两条铁律：
  //   1. **只有只读工具**（`map_overview` / `map_get` / `map_search`）。
  //      没有 add/create/link/move/hide/delete —— 「模型写结构」是红线，
  //      写工具一旦存在，无论提示词怎么写模型都可能用它。
  //   2. **会话身份来自执行上下文**（`exec.agent?.session.header.id`），
  //      不是浏览器当前打开的会话。拿不到就**拒绝调用**，绝不猜、绝不退回"当前会话"。
  //      这条在 `src/overlay/tools.js` 的 `sessionIdFromExecution` 里实现并单测。
  ctx.effect(
    () => {
      const count = registerReadonlyTools(ctx, {
        getDoc: async (sessionId) => {
          const domain = await readyDomain(getDomain)
          if (!domain) return null
          const doc = domain.table(TABLE).get(sessionId)
          return doc === undefined ? null : doc
        },
        derivedTitles: (sessionId) => derivedTitleIndex(sessionId),
      })
      log(ctx, '只读工具已注册（' + String(count) + ' 个，全部只读）')
      return undefined
    },
    'freethought-map: readonly tools',
  )

  log(ctx, '宿主一半已激活：overlay 权威存储 + 落链 + 发送前注入 + 只读工具（dsh 0.1.7-rc.2 c1275515）')
}

/** 每会话一份「已拍下的发送快照」，供官方重试复用（规格 §10.3）。 */
const snapshotStore = new Map()

/** 领域句柄一旦打开就复用；未就绪时返回 null（不阻塞这一轮对话）。 */
async function readyDomain(getDomain) {
  try {
    return await getDomain()
  } catch {
    return null
  }
}

/** 从 agent 上取会话 id。 */
function sessionOfAgent(agent) {
  if (!agent) return null
  const session = agent.session
  if (!session) return null
  if (session.header && typeof session.header.id === 'string') return session.header.id
  if (typeof session.id === 'string') return session.id
  return null
}

/** 派生标题索引：从结算日志里取 eventId → 派生标题，供注入文案显示节点名。 */
function derivedTitleIndex(sessionId) {
  const idx = {}
  for (const e of settlementLog.list(sessionId, -1)) {
    if (e && e.eventId && e.title) idx[String(e.eventId)] = String(e.title)
  }
  return idx
}

/** 给注入日志造一条「伪事件」，复用 SettlementLog 的字段形状。 */
function syntheticEvent(payload, phase) {
  return {
    type: 'freethought-map/' + phase,
    seq: Number.isInteger(payload && payload.turn) ? payload.turn : -1,
    data: { id: phase + ':' + String(payload && payload.turn) + ':' + String(payload && payload.step) },
  }
}

/** 投影写入串行化：避免同一条事件被并发应用导致读-改-写交错。 */
let projectionChain = Promise.resolve()

/** 从 `session` 参数里取会话 id，兼容对象与字符串两种形态。 */
function sessionIdOf(session) {
  if (!session) return null
  if (typeof session === 'string') return session
  if (session.header && typeof session.header.id === 'string') return session.header.id
  if (typeof session.id === 'string') return session.id
  return null
}

/**
 * 把一条结算事件投影进权威 overlay。
 *
 * 全程在**一个 `update` 槽位**里完成「读 → 判断 → 写」，所以：
 *   · 自动投影与用户 save 共享 rev 序列，不会互相覆盖；
 *   · 两条事件并发到达也不会交错。
 *
 * 父节点怎么定（规格 §6.4 / §6.5）：
 *   · user 结算   —— 上行是从 canonical 来的，历史补链用它；实时到达时用
 *                    「时间线上前一个未隐藏 turn」。
 *                    ⚠️ **不用 live focusId**：焦点是客户端概念，宿主看不到，
 *                    也正因如此这里天然满足「禁止用此刻 focusId 兜底」。
 *   · assistant 结算 —— 用「该 assistant 之前最近一条 user 投影」。
 *
 * 焦点跟随（抢焦点规则）由**客户端**实现：只有客户端知道用户此刻点在哪。
 * 宿主只负责把节点挂对，并把「该不该跟随」写成 `focusHint` 一起返回。
 */
async function projectOne(ctx, getDomain, sessionId, event, kind) {
  const domain = await getDomain()
  const table = domain.table(TABLE)

  let current = table.get(sessionId)
  if (current === undefined || current === null) {
    current = createOverlay(sessionId)
    await table.put(sessionId, current)
  }

  let outcome = 'noop'
  let focusHint = null

  await table.update(sessionId, (authoritative) => {
    // 时间线前驱：按 seq 找最近的、未被摘除的 turn 节点
    // 这里没有事件全集，所以用 overlay 里的节点 + 它们的 seq 记账（见 seqOf 注释）
    const prevTurnId = timelinePrevTurn(authoritative, event)
    const userNodeIdForAssistant =
      kind === 'assistant-settlement' ? nearestUserTurnBefore(authoritative, event) : undefined

    const plan = planProjection(authoritative, event, {
      prevTurnId,
      ...(userNodeIdForAssistant !== undefined ? { userNodeIdForAssistant } : {}),
    })

    if (plan.action !== 'append-turn') {
      outcome = plan.reason || 'noop'
      return authoritative
    }

    // 宿主侧不做「抢焦点」判断（那是客户端的事），所以 followFocus 一律 false，
    // 只把建议通过 focusHint 回传。
    const projected = applyProjection(
      authoritative,
      { ...plan, followFocus: false },
      { newId: () => newIdFor(sessionId, event) },
    )
    const newNodeId = Object.keys(projected.nodes).find((id) => !authoritative.nodes[id])
    if (newNodeId) {
      projected.nodes[newNodeId] = { ...projected.nodes[newNodeId], seq: Number(event.seq) || 0 }
      focusHint = { nodeId: newNodeId, kind: plan.kind, suggested: plan.followFocus }
    }
    outcome = 'appended'
    // 投影改了权威内容 → 必须递增 rev（规格 §9.0）。漏掉就等于关掉了这一次写入的
    // 并发保护：拿着旧 doc 的客户端会通过 `baseRev === rev` 校验、整份替换、覆盖掉新节点。
    //
    // 写成「先算成变量、再显式 commit」的形状是**刻意的**：
    // 这样每个写站点在源码里都是同一句 `return commitAuthorityWrite(before, next, changed)`，
    // 断言可以逐个站点精确检查。（早先版本直接 `return projected`，
    // 站点解析器分不清它属于哪一段，变异测试因此漏报过一次。）
    const nextDoc = projected
    return commitAuthorityWrite(authoritative, nextDoc, true)
  })

  settlementLog.record(sessionId, event, outcome)
  return { outcome, focusHint }
}

/**
 * 权威写入的统一收尾：**内容变了就递增 rev**（规格 §9.0）。
 *
 * 为什么要收成一个函数：`rev` 的语义是「权威内容的修订号」，而 `save` 的并发保护
 * 只有 `baseRev === 当前 rev` 一条判据。**任何改内容的写入漏掉递增，就等于关掉了
 * 那一次写入的并发保护** —— 拿着旧 doc 的客户端会通过校验、整份替换、覆盖掉它。
 *
 * 2026-09-27 实测确认三处都漏过：自动投影（`projectOne`）、导入合并（`importDoc`）、
 * 重建投影（`rebuild`）。所以收口在这里，并且有断言盯着「所有 `table.update` 的
 * 返回值都经过它」。
 *
 * `changed === false`（内容没变）时**不**递增 —— 避免空转递增把 `rev` 变成噪声，
 * 那会让用户操作无谓地撞 409。
 *
 * @param {object} before table.update 拿到的权威 doc
 * @param {object} after  变换后的 doc
 * @param {boolean} changed 本次是否真的改了内容
 * @returns {object} 应当写回的 doc
 */
function commitAuthorityWrite(before, after, changed) {
  if (!changed) return after
  return { ...after, rev: (Number(before && before.rev) || 0) + 1, updatedAt: Date.now() }
}

/**
 * 从 deterministic 的 id 生成器：同一 sourceRef 永远得到同一个 id。
 *
 * 为什么不用随机 id：投影可能因为重试被跑两次；用 sourceRef 派生 id，
 * 第二次天然落在同一个节点上（配合去重就是彻底的幂等）。
 */
function newIdFor(sessionId, event) {
  const kind = settlementKindOf(event) || 'x'
  const eventId = String(
    (event.data && (event.data.id || (event.data.message && event.data.message.id))) ||
      'seq' + String(event.seq),
  )
  const raw = kind + ':' + eventId + ':' + sessionId
  let hash = 0
  for (let i = 0; i < raw.length; i += 1) {
    hash = (hash * 31 + raw.charCodeAt(i)) | 0
  }
  return 'T' + (hash >>> 0).toString(36) + '-' + eventId.replace(/[^A-Za-z0-9_-]/g, '').slice(0, 12)
}

/**
 * 时间线前驱：seq 小于本条事件、且未被摘除的最近一个 turn 节点。
 *
 * 节点上的 `seq` 是投影时记下的（见 projectOne），所以这个查找是纯 overlay 内的运算，
 * 不需要把整段会话日志拿在手里。
 */
function timelinePrevTurn(doc, event) {
  const seq = Number(event.seq)
  if (!Number.isFinite(seq)) return null
  let best = null
  let bestSeq = -Infinity
  for (const node of Object.values(doc.nodes)) {
    if (node.kind !== 'turn') continue
    const s = Number(node.seq)
    if (!Number.isFinite(s) || s >= seq) continue
    if (s > bestSeq) {
      bestSeq = s
      best = node.id
    }
  }
  return best
}

/** 该 assistant 事件之前最近的一条 user 投影（助手节点要挂到它下面）。 */
function nearestUserTurnBefore(doc, event) {
  const seq = Number(event.seq)
  let best = null
  let bestSeq = -Infinity
  for (const node of Object.values(doc.nodes)) {
    if (node.kind !== 'turn') continue
    if (!node.sourceRef || node.sourceRef.kind !== 'user-message') continue
    const s = Number(node.seq)
    if (Number.isFinite(seq) && (!Number.isFinite(s) || s >= seq)) continue
    if (s > bestSeq) {
      bestSeq = s
      best = node.id
    }
  }
  return best
}

/**
 * 只给测试用的内部导出（`scripts/verify-host.mjs` 用它验证领域 spec 的合法性，
 * 而不必真的打开一个存储领域）。生产路径不依赖它。
 */
export const __test = {
  makeDomainSpec,
  overlayRecordSchema,
  markRemoteMethods,
  REMOTE_METHOD_DESCRIPTOR,
  newIdFor,
  timelinePrevTurn,
  nearestUserTurnBefore,
}
