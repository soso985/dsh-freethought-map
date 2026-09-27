# HOST.md · 宿主版本与扩展点探针记录

> 本文件是**唯一**记录「插件挂在哪个 DSH 版本上、哪些扩展点真的可用」的地方。
> 规则（来自 `docs/00-AI接力-先读.md` §2）：
> 1. 每卡日志必须写 **dsh 版本号 + git commit**，**禁止**留「安装时填写」。
> 2. 探针结论必须是**实测**结果（符号名 + 可行/不可行 + 失败表现），不是读文档的推测。
> 3. 任何一项「不可行」→ 停，记日志，问主人；不得把赌押到后面的卡。

---

## 1. 宿主版本（卡 0 锁定）

| 项 | 值 | 证据来源 |
| --- | --- | --- |
| dsh 运行时包版本 | **`@deepseek-ai/dsh@0.1.7-rc.2`** | `E:\Harness\resources\app.asar` → `dsh/node_modules/@deepseek-ai/dsh/package.json` 的 `version` 字段 |
| DSH Desktop shell 版本 | `@deepseek-ai/dsh-desktop@0.1.7-rc.2` | `app.asar/package.json` → `version` |
| **dsh 构建 commit** | **`c1275515b6b97551ec358c926c479ab750c687c0`** | `app.asar/package.json` → `dshBuildCommit`（同文件 `dshBuildDirty: false`） |
| Cordis（内核） | `@deepseek-ai/cordis@4.0.4` | `app.asar/dsh/package.json` → `dependencies` |
| 宿主 Node 运行时 | **v24.21.0**（随 Desktop 附带） | `E:\Harness\resources\runtime\primary-runtime\runtime.json` → `node`；实测 `node.exe --version` |
| 宿主 pnpm | 11.7.0 | 同上 `runtime.json` → `pnpm` |
| Desktop 安装根 | `E:\Harness\` | `DeepSeek Harness.exe` 所在目录 |
| `DSH_HOME` | `C:\Users\Administrator\.dsh` | 环境变量 `DSH_HOME`（`DSH_PROFILE=desktop`） |
| 目标 profile | `web`（`C:\Users\Administrator\.dsh\profiles\web`） | 该目录已存在：`package.json` 声明 `bundles: [dsh-base, dsh-web-app]` |
| Web GUI 地址 | `http://127.0.0.1:19387` | `DSH_WEB_URL` 环境变量；实测 19387 由 `DeepSeek Harness.exe`（PID 12952）监听 |

> **为什么版本号这么写**：DSH 目前以 Desktop 应用分发，`@deepseek-ai/*` 包**没有公开发布到 npm**（本机 `npm ls -g` 无任何 `@deepseek-ai` 包），全部打包在 `E:\Harness\resources\app.asar` 内。
> 因此「精确版本」= 上面这行 `版本 + build commit`，`0.1.7-rc.2` 配 `c1275515…` 唯一锁定这次开发所对的宿主。

### 1.1 宿主运行时获取方式（换机器必读）

`app.asar` 是归档，**普通 Node 读不进去**（实测 `fs.readFileSync('…/app.asar/dsh/package.json')` → `ENOENT`）。要拿到可读的源码与 CLI，必须先解包到临时目录：

```powershell
$out = "$env:TEMP\dsh-asar-extract"
npx --yes @electron/asar extract 'E:\Harness\resources\app.asar' $out
# 解包后：$out\dsh\node_modules\@deepseek-ai\  ← 284 个包的全部源码
```

CLI 入口（用宿主自带 Node 跑，实测可用）：

```powershell
$node = 'E:\Harness\resources\runtime\primary-runtime\dependencies\node\bin\node.exe'
& $node "$env:TEMP\dsh-asar-extract\dsh\node_modules\@deepseek-ai\dsh\lib\bin.js" --version
# → 0.1.7-rc.2
```

---

## 2. 扩展点探针表（卡 1 填写）

> 每行必须写成「**调用的符号名** / **结果** / **失败表现**」。结果只允许 `可行` / `不可行` / `部分可行`。
> 依据规格 `docs/01-产品与技术规格.md` §8 的五项。

| # | 探针 | 要回答的问题 | 调用的符号名 | 结果 | 失败表现 / 降级方案 |
| --- | --- | --- | --- | --- | --- |
| P1 | **左右布局** | 能否把插件面板钉在会话主区左侧、官方对话在右、可收窄？ | _待填_ | _待填_ | 不行 → Plan B：侧栏全屏图（**须主人确认**） |
| P2 | **气泡定位** | 能否按 eventId 把官方列表滚到该气泡并高亮？ | _待填_ | _待填_ | 不行 → 卡 4 双向定位降级为「只做图→会话跳转」 |
| P3 | **点击回传** | 用户点官方气泡，插件能否收到该气泡的 eventId？ | _待填_ | _待填_ | 不行 → 只保留图→气泡单向；DOM 委托记为脆弱 |
| P4 | **发送前上下文** | 能否在用户发送前把「焦点摘要 + 粉线快照」注入本轮？ | _待填_ | _待填_ | 不行 → 退化为只靠只读工具（**须日志 + 问主人**） |
| P5 | **构建加载** | 插件 add 后刷新，无控制台 error，官方设置页可开？ | _待填_ | _待填_ | 不行 → 卡 1 结束状态 = 阻塞 |

### 2.1 探针 P1 明细（布局）

_待填：记录试过的每条路（官方 layout slot / chrome / 侧栏 / 浮动层）、各自符号名与结果。_

### 2.2 探针 P2 明细（气泡定位）

_待填_

### 2.3 探针 P3 明细（点击回传）

_待填_

### 2.4 探针 P4 明细（发送前注入）

_待填：分「发送前 prompt 片段」与「系统提示词贡献」两条路分别记。_

### 2.5 探针 P5 明细（构建加载）

_待填：记录插件包路径、`dsh plugin` 命令、刷新后控制台、官方设置页可开性。_

---

## 3. 已确认的宿主约定（源码/文档实证，非推测）

> 这一节记录**已经查实**的宿主机制，供后续卡直接引用。每条都要附证据。

| 约定 | 内容 | 证据 |
| --- | --- | --- |
| 客户端插件声明 | 插件 `package.json` 用 `dsh.client` 字段声明客户端形态：`{ "platform": "web", "inject": [...], "immediately"?: true }` | `@deepseek-ai/dsh-client-ui-layout/package.json` 的 `dsh.client` |
| 客户端入口 | 客户端代码走 `exports["./client"]`，宿主入口走 `exports["."]` | `dsh-client-ui-layout/package.json` |
| 宿主 patch | 插件用 `dsh.bundle.patch` 指向自己的 `cordis.patch.yml` | `dsh-base/package.json`、`dsh-web-app/package.json` |
| profile 结构 | profile 目录 = `package.json`（含 `dsh.profile.bundles`）+ `cordis.patch.yml`（用户 patch 层，顶层 YAML patch entry 数组） | `~/.dsh/profiles/web/` 实况；`dsh` 包 `README.zh.md` §Profile |
| 配置层叠顺序 | 空根 → `dsh.profile.bundles` 各组合包 patch → profile `cordis.patch.yml` → `$DSH_HOME/cordis.patch.yml` → `--patch` | `dsh` 包 `README.zh.md` §Profile |
| 插件管理命令 | `dsh plugin --profile <name> <pnpm args>`（在 profile 目录内转发给 pnpm） | `dsh` 包 `README.zh.md` §入口模式 |
| Web profile 启动 | `dsh web` | 同上 |
| desktop profile 保留 | CLI **拒绝**对 `desktop` profile 做启动 / config dump / 插件管理（Electron 独占） | 同上 |
| 客户端 UI 组合 | 插件通过 `ctx.slots.register(...)` 注册进父级已声明的 slot；slot 有 `single` / `list` / `keyed` / `chain` 四种 kind | `dsh-client-ui-slots/README.zh.md` |

---

## 4. 未决问题（卡 1 一并验证）

1. `web` profile 目前只有 `dsh-base` + `dsh-web-app` 两个 bundle，**尚未跑过** `dsh web`；首次启动会自动从随附模板初始化。
2. Web GUI 现在由 Desktop 主进程在 19387 提供（`DSH_PROFILE=desktop`）。**卡 1 需要确认：插件装在 `web` profile 后，是用 `dsh web` 另起一个端口验证，还是 Desktop 也能加载 web profile。**
3. `@deepseek-ai/*` 未公开到 npm → 插件包的 `peerDependencies` 只能写版本范围，**实际解析靠 profile 的 node_modules**；安装时如何避免 pnpm 去 registry 拉 `@deepseek-ai/*` 需要卡 1 实测。

---

## 5. 变更记录

| 日期 | 变更 | 依据 |
| --- | --- | --- |
| 2026-09-26 | 卡 0：建立本文件；锁定 dsh `0.1.7-rc.2` + commit `c1275515…`；记录解包与 CLI 调用方式；登记 8 条已实证的宿主约定 | 本机实测（见 §1 证据列） |
