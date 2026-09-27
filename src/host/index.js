/**
 * dsh-freethought-map · 宿主一半（Host half）
 *
 * 卡 0 / 卡 1 阶段：这里只做「我确实被宿主加载了」的最小证据，不做任何业务逻辑。
 * 业务（overlay 权威存储、session/event 订阅、只读工具）分别在卡 2 / 卡 3 / 卡 6 落地。
 *
 * 宿主版本：dsh 0.1.7-rc.2 · commit c1275515b6b97551ec358c926c479ab750c687c0（见 docs/HOST.md）
 */

export const name = 'freethought-map'

/** 探针证据用的版本串：宿主加载本插件后可在宿主日志/设置页核对。 */
export const version = '0.0.0'

/**
 * 宿主插件入口。Cordis 在 patch 行的 name 解析到本包后调用。
 *
 * 只注册一个 effect：插件卸载时随之清理。卡 1 不订阅任何宿主事件，
 * 因为「订阅得到什么」本身就是卡 1 要验证的探针，先验证加载成功再谈订阅。
 *
 * @param {import('@deepseek-ai/cordis').Context} ctx
 */
export function apply(ctx) {
  ctx.effect(() => {
    ctx.logger?.info?.(
      '[freethought-map] host half loaded · dsh 0.1.7-rc.2 c1275515 · version=%s',
      version,
    )
    return () => {
      ctx.logger?.info?.('[freethought-map] host half disposed')
    }
  })
}
