/**
 * dsh-freethought-map · 宿主一半（Host half）
 *
 * 职责：把「overlay 权威存储」以服务形式登记到宿主，供客户端一半通过 Remote 调用。
 * 存储与并发逻辑在 `./storage.js`，纯函数在 `../overlay/index.js`。
 *
 * 宿主版本：dsh 0.1.7-rc.2 · commit c1275515b6b97551ec358c926c479ab750c687c0（见 docs/HOST.md）
 *
 * ⚠️ 两条纪律（都是实测踩出来的，见 docs/HOST.md §2.6 / §3.9）：
 *
 *  1. **`apply()` 里不要 await，也不要 import 任何裸包名。**
 *     宿主 runtime 解析不到 `@deepseek-ai/*`、`zod`、`schemastery`
 *     （`app.asar.unpacked/dsh/node_modules` 只有 3 个包），而 `apply` 里冒出的异常会让
 *     **整行激活失败** —— 后果是整个 Web 前端拒绝加载，页面只剩 "Failed to load plugins"。
 *     所以本文件只 import 自己包内的相对路径，异步失败一律降级成日志 + RPC 错误。
 *
 *  2. **服务的实际提供与释放都放在 `ctx.effect` 里**，随插件卸载自动回收。
 */

import { apply as applyStorage, inject as storageInject } from './storage.js'

export { buildRemoteContribution } from './storage.js'

/** 宿主插件声明的服务依赖（转发 storage.js 的声明，见那里的注释）。 */
export const inject = storageInject

export const version = '0.0.0'

/**
 * @param {any} ctx
 */
export function apply(ctx) {
  // 全部逻辑（领域打开、服务登记、诊断日志）都在 storage.js，
  // 这里保持入口极薄：宿主组合阶段读的就是这个函数能不能同步返回。
  applyStorage(ctx)
}
