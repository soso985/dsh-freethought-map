/**
 * dsh-freethought-map · 宿主一半（Host half）
 *
 * 卡 0 / 卡 1 阶段：这里只做「我确实被宿主加载了」的最小证据，不做任何业务逻辑。
 * 业务（overlay 权威存储、session/event 订阅、只读工具）分别在卡 2 / 卡 3 / 卡 6 落地。
 *
 * ⚠️ 纪律：`apply()` 里**只做注册**，不要有多余动作。宿主在组合阶段会校验每一行能否激活，
 * 行激活失败会让整个 Web 前端拒绝加载（页面直接显示 "Failed to load plugins"），
 * 而不是悄悄跳过。所以这一半在卡 1 故意写得极简。
 *
 * 宿主版本：dsh 0.1.7-rc.2 · commit c1275515b6b97551ec358c926c479ab750c687c0（见 docs/HOST.md）
 */

/** 探针证据用的版本串。 */
export const version = '0.0.0'

/**
 * 宿主插件入口。Cordis 在 patch 行的 name 解析到本包后调用。
 *
 * @param {any} ctx
 */
export function apply(ctx) {
  // Cordis 会把注册的资源绑到当前 context 上并随之销毁；这里没有资源可注册，
  // 只留一条可核对的日志（宿主侧日志可见），证明这一半真的被激活了。
  try {
    const logger = ctx && ctx.logger
    if (logger && typeof logger.info === 'function') {
      logger.info('[freethought-map] host half activated · dsh 0.1.7-rc.2 c1275515 · v' + version)
    }
  } catch {
    // 日志不可用绝不能影响激活 —— 激活失败会让整个 Web 前端起不来。
  }
}

