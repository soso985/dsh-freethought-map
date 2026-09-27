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

import { SAVE_CONFLICT, SAVE_OK, SAVE_REJECTED, applySave, createOverlay, validateOverlay } from '../overlay/index.js'

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
}

// 端点名由 marker 决定：freethoughtMap/load、freethoughtMap/save、freethoughtMap/describe。
markRemoteMethods(FreethoughtMapHostService, ['load', 'save', 'describe'])

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
 */
export const inject = ['storageDomain']

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

  log(ctx, '宿主一半已激活：overlay 权威存储就绪（dsh 0.1.7-rc.2 c1275515）')
}

/**
 * 只给测试用的内部导出（`scripts/verify-host.mjs` 用它验证领域 spec 的合法性，
 * 而不必真的打开一个存储领域）。生产路径不依赖它。
 */
export const __test = { makeDomainSpec, overlayRecordSchema, markRemoteMethods, REMOTE_METHOD_DESCRIPTOR }
