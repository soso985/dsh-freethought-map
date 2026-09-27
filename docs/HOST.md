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
| P1 | **左右布局** | 能否把插件面板钉在会话主区左侧、官方对话在右、可收窄？ | `ctx.sidebarRightTabs.register({id,kind,patterns,priority,canOpen,title})` + `ctx.slots.register({name:'sidebar.right.pane.tab', key})` | **部分可行**（源码实证；运行期待验） | 见 §2.1：**左侧无附加席位**，可行的是**右侧**停靠列（`push` 形态会挤压会话列）。真要在左侧须替换官方导航栏 —— 不采用 |
| P2 | **气泡定位** | 能否按 eventId 把官方列表滚到该气泡并高亮？ | 期待 `reveal` / `navigateTo` / `focusNode` / `scrollIntoView` 类 API | **不可行**（源码实证） | 无任何公开 API。唯一可行路径是内部 DOM：`document.querySelector('[data-chat-node-key="…"]').scrollIntoView()`（属性见 `dsh-client-ui-chat/lib/client.js:1763`，**非公开契约**）→ 卡 4 只能降级为「图 → 气泡」单向 + 记脆弱 |
| P3 | **点击回传** | 用户点官方气泡，插件能否收到该气泡的 eventId？ | 期待 `onClick` / `onSelect` / `onActivate` 注册表 | **不可行**（源码实证） | 无 inbound 点击回调；插件只能**主动调用** `forkAt(seq)` / `inspectCall(callId)`。唯一接管途径是 keyed slot **影子替换**（`priority` 更低 + 官方 key），会连带接管官方渲染 → **不采用** |
| P4 | **发送前上下文** | 能否在用户发送前把「焦点摘要 + 粉线快照」注入本轮？ | `agent/pre-step`（waterfall）+ `PreStepDecision`；备选 `agent.inject(msg)`、`ctx.systemPrompt.section()` | **可行**（源码实证；运行期待验） | 注意：注入的是「进入该 step 的消息批次」，**不改写用户原文**；返回是整体替换，必须 `await next()` 并保留原 messages |
| P5 | **构建加载** | 插件 add 后刷新，无控制台 error，官方设置页可开？ | `dsh plugin --profile web add <路径>`；`dsh web --port 19388` | **可行**（自动化实测 10/10；真浏览器控制台洁净） | 唯一残留：有会话页面上 `[data-freethought-map-root]` 的出现待人眼确认（见 §2.5） |

> **状态说明**：P1–P4 的「结果」目前是**源码级实证**（四路只读侦察，证据见 §3），不等同于「已在本机跑通」。
> 卡 1 的收口要求是**运行期实测**：装进 profile、打开页面、逐条观察。填完那一轮后本节才算验收通过。

### 2.1 探针 P1 明细（布局）

**试过的每条路与结论**

| 路径 | 符号名 | 结果 | 为什么 |
| --- | --- | --- | --- |
| 自己开一列左栏 | `sidebar`（single/root） | **不可行** | 已被官方导航栏占用；注册进去是**替换**官方 UI（`replaceRisk: shadows-shipped-ui`），不是并列 |
| 自己开一列右栏 | `rightbar`（single/root） | **不可行** | 同上，已被官方右侧栏占用 |
| 替换整个框架 | `root`（single/root） | **不可行** | 权威目录原文：DO NOT register here |
| 左列加一项 | `sidebar.panellist`（list/root） | **部分可行** | 只能加一个**图标**；该 id 对应的面板正文渲染在**中栏 `main`**，不是左侧新列 —— 得不到「左图右聊」 |
| **右列停靠 tab** | `sidebar.right.pane.tab`（keyed/session） | **✅ 采用** | 官方唯一「可附加 + 自带空间」的席位；面板以 `push` 形态贴靠右列，**会话列自动让出宽度**（宿主原生行为，不自己写 CSS 布局） |
| 浮动层 | `shell.overlay`（list/root） | 备选 | `replaceRisk: none`，但是浮层、不占列宽，得不到「图铺满」 |

**采用方案**：`sidebarRightTabs.register()` 声明 tab 类型 + `sidebar.right.pane.tab` 注册正文。
注册形状照抄官方 `ui-subagent`（`dsh-client-ui-subagent/lib/client.js:806-827`）：

```js
ctx.effect(() => ctx.sidebarRightTabs.register({
  id: TAB_KIND, kind: TAB_KIND, patterns: [`${ADDR}**`],
  priority: 'builtin',
  canOpen: (address) => address.startsWith(ADDR),
  title: () => 'FreeThought Map',
}), 'freethought-map: tab type')

ctx.effect(() => ctx.slots.inject('sidebar.right.pane.tab', () =>
  ctx.slots.register({ name: 'sidebar.right.pane.tab', key: TAB_KIND }, Panel),
), 'freethought-map: panel body')
```

**⚠️ 与规格 §4 的差异（需要主人拍板，不得静默漂移）**

规格 `01-产品与技术规格.md` §4 写的是「**左图右官方聊**」。宿主的实际能力是：

- 官方对话**固定在中间列**（`minmax(400px, 1fr)`），并且**没有任何插件 API 能改中栏宽度或隐藏它**（`ctx.layout` 只有 `selectPanel` / `toggleSidebar` / `openRightbar` / `closeRightbar` / `panelInfo`；用户拖的 `widthControls` 是 Factory local slot，外部插件无法注入官方 occurrence）。
- 能「附加且自带空间」的只有**右列**。

因此本插件落地后是「**中间官方聊、右列图**」，即**左右互换**。可接受的话，这条差异要同步进规格；
不可接受的话，剩下的选项只有「替换官方导航栏」（不采纳）或「浮动层盖在对话上」（也不是左图右聊）。

### 2.2 探针 P2 明细（气泡定位）

**不可行**。grep 全库 `reveal` / `navigateTo` / `jumpTo` / `locate` / `focusNode` / `activeNode` / `selectNode` 均**未找到**公开 API：

- `dsh-client-ui-chat` 里确实有一个 `navigateToTurn`（`lib/client.js:4018`），但它是 `useChatNavigation` 的私有返回值，**没有出现在任何 slot owner props 里**（`dsh-cordis-client-runner` 全文都没有这个符号）。
- 唯一的「focus」机制是 View Definition 的 `toolCallFocus(callId)` / `openView(view, focus)` / `viewRequest`，但它的 focus 是 **tool-call id**（opaque、target 私有），**不是 event id**；目前只有 trajectory 一个包在用。
- 唯一与「按位置加载」有关的是 `ISession.loadThrough(seq)`——它只保证分页窗口覆盖到该 seq，**不代表可见，也没有滚动**。

**降级**：卡 4 的「点节点 → 滚到官方气泡」只能走内部 DOM：
```js
document.querySelector(`[data-chat-node-key="${key}"]`)?.scrollIntoView({ block: 'center' })
```
`data-chat-node-key` 由 `dsh-client-ui-chat/lib/client.js:1763` 生成，README 里**没有任何公开承诺** → 记为**脆弱**，升级必测。

### 2.3 探针 P3 明细（点击回传）

**不可行**。全库没有任何 owner → 插件的点击回调注册表（`onClick` 只出现在 chat 自己的内部组件里）。

- 插件能做的只是**主动调用**：`forkAt(seq)`、`inspectCall(callId)`（`ChatNodeOwnerProps`，`dsh-cordis-client-runner/lib/client.js:2506`）。
- 唯一能接管官方气泡点击的办法是 keyed slot **影子替换**：用更低的 `priority` + 官方 key 注册自己的 renderer（`dsh-client-ui-slots/lib/index.js:168,175-179`）。这会**连带接管官方气泡的渲染**，与红线「不 patch 官方 UI」冲突 → **不采用**。
- 合法但仍需妥协的折中：`conversation.chat.assistant-actions`（收 `{ messageId }`）与 `conversation.chat.turnTail`（收 `{ turn, seq, openFile }`）能在官方气泡**旁边**放控件，但那不是「点气泡本体回传」。
- 最后一个可选路径（脆弱）：在 transcript 容器上做 DOM 事件委托，按 `data-chat-node-key` 反查。官方 README 未承诺该属性 → 记脆弱。

**降级**：卡 4 保留「图 → 气泡」单向；「气泡 → 图」若必须做，只能走上面的 DOM 委托并明确标注脆弱。

### 2.4 探针 P4 明细（发送前注入）

**可行**，两条路都有实证：

1. **改本轮消息批次**（推荐，符合规格 §6.4 的「发送时快照」）：waterfall `agent/pre-step`
   - `payload = { agent, messages: UserMessage[], turn, step, signal }`，`next(): Promise<PreStepDecision>`
   - `PreStepDecision = { kind:'reject' } | { kind:'enter'; messages: UserMessage[]; startsRequestSeries?: true }`
   - **时序关键**：`agent/pre-step` 跑在 `user/message` 落盘**之前**（`dsh-agent-loop/README.zh.md:119`），正好能在发送瞬间取快照。
   - **纪律**：必须 `await next()`（否则吞掉下游）；返回是**整体替换**，要自己保留 `decision.messages`（照抄 `dsh-agent-instructions/lib/index.js:1283-1288` 的 splice 写法）。
2. **系统提示词贡献**（用于「短上下文」常驻说明）：`ctx.systemPrompt.section({ name, order, text })`。

**不存在**的钩子（避免后续误找）：`beforeSend` / `preSend` / `transformPrompt` / `injectPrompt`（全库 0 命中）。
**易误认**的两条路：`ctx.inputTriggers.registerSource` 只驱动 composer 补全菜单；`ctx.commands.register` 直接执行 slash 命令、不发给模型。

### 2.5 探针 P5 明细（构建加载）

**结论：可行**（自动化实测，2026-09-27）。

安装与启动方式（实测记录）：

```powershell
$node = 'E:\Harness\resources\runtime\primary-runtime\dependencies\node\bin\node.exe'
$dsh  = "$env:TEMP\dsh-asar-extract\dsh\node_modules\@deepseek-ai\dsh\lib\bin.js"
$env:DSH_HOME = 'C:\Users\Administrator\.dsh'

# 1) 装进 web profile（pnpm 透传；link: 依赖，无需打包）
& $node $dsh plugin --profile web add E:\dsh-freethought-map
#    → dependencies: + dsh-freethought-map link:E:/dsh-freethought-map
#    → profile package.json 自动追加 dsh.profile.bundles: ["@deepseek-ai/dsh-base",
#      "@deepseek-ai/dsh-web-app", "dsh-freethought-map"]

# 2) 起隔离实例（**不碰在用的 Desktop**；Desktop 的 19387 保持不动）
& $node $dsh web --port 19388 --no-open
#    → dsh web: http://127.0.0.1:19388/?token=XXXX
```

#### 实测结果

| 检查 | 手段 | 结果 |
| --- | --- | --- |
| profile bundles 含本包 | `scripts/verify-boot.mjs` | ✅ 通过 |
| profile dependencies 指向本包（`link:E:/dsh-freethought-map`） | 同上 | ✅ 通过 |
| 登录页可取（token → 303 → cookie → 200） | 同上 | ✅ 通过 |
| `window.__DSH_BOOT__.entries` 含 `dsh-freethought-map` | 同上（65 条 entries 里第 61 条） | ✅ 通过 |
| 本包在某个 application batch 的 entries 里 | 同上 | ✅ 通过 |
| `plugins/??dsh-freethought-map/client.js&rev=…` 可取 | 同上（HTTP 200） | ✅ 通过 |
| bundle 的 module id 等于包名 | 同上 | ✅ 通过 |
| bundle 里带本插件根节点标记 | 同上 | ✅ 通过 |
| 官方设置页 / 设置相关插件仍在位 | boot entries 里 `dsh-client-ui-settings*` 全在 | ✅ 通过 |
| 组成配置树里有本插件的行 | `dsh --profile web --dump-config` → `# == dsh-freethought-map` / `- id: freethought-map` | ✅ 通过 |
| **真浏览器：控制台无 error** | `scripts/verify-render.ps1`（Edge 154 + CDP） | ✅ 通过 |
| **真浏览器：`[data-freethought-map-root]` 出现在 DOM** | 同上 | ⏳ **待在有会话的页面上确认**（hero 画面下官方右列按会话挂载，插件正文不渲染） |

自动化脚本：`scripts/verify-boot.mjs`（10/10 通过）。

#### 踩到的两个坑（都是实测撞出来的，写下来免得重复踩）

1. **宿主行必须启用，否则客户端一半不会被发现。**
   最初把 `cordis.patch.yml` 的行写成 `disabled: true`（想"先只验证客户端"），结果
   `__DSH_BOOT__.entries` 里**根本没有本包**。改成启用后立刻出现。
   → **`dsh.client` 的发现是跟着启用的宿主行走的**，不能靠禁用宿主行来"只跑客户端"。
2. **客户端 bundle 里绝对不能出现 `export` / `import`。**
   宿主把 `./client` 导出的文件当**普通脚本**注入页面。第一版为了"能在 Node 里 import 做自测"
   写了 `export const registration = window.__ModuleLoader__.load({…})`，
   serve 出来一切正常（`verify-boot.mjs` 10/10 通过），但**浏览器抛三条
   `SyntaxError: Unexpected token 'export'`**，插件完全静默失效。
   → 这个 bug **只有真浏览器能发现**；node 侧自测当时是绿的。
   自测脚本已改成用 `vm.Script` 按脚本语义执行，并加了一条硬断言：源码里出现 `export|import` 就 FAIL。

> 这两条正是卡 1 存在的意义：**「bundle 送到了」不等于「插件活了」**（官方 skill 原话：
> installation and slot registration alone do not establish what the user can see）。

#### 浏览器门禁机制（写脚本时要知道）

宿主 web 的 browser-trust 是**两步**，不是一次 fetch：

1. `GET /?token=<token>` → **303 See Other** + `set-cookie: dsh-auth-…`（HttpOnly、SameSite=Strict）
2. 带那个 cookie 再请求 `./` → 200 + HTML（`window.__DSH_BOOT__` 在这里）

Node 的 `fetch` **不会**自动保存 cookie，必须自己接住 303 的 `set-cookie` 再发第二次
（`curl` 也一样：`-L` 会把 set-cookie 丢掉，所以 `curl` 直接跟随后仍然 401）。
`verify-boot.mjs` 已按这个两步流程实现。

#### 与在用的 Desktop 的关系

- 本卡**完全没有碰**正在使用的 Desktop 应用（profile = `desktop`，19387 端口）。
- CLI 明确**拒绝**对 `desktop` profile 做插件管理（`dsh/lib/bin.js:36`），所以隔离实例走 `web` profile。
- 隔离实例是独立进程 + 独立端口（19388），随时可 `Stop-Process` 关掉，不留残留配置。

---

## 3. 已确认的宿主约定（源码/文档实证，非推测）

> 这一节记录**已经查实**的宿主机制，供后续卡直接引用。每条都要附证据。
> 证据前缀：`<PKG>` = `C:\Users\Administrator\AppData\Local\Temp\dsh-asar-extract\dsh\node_modules\@deepseek-ai\`。

### 3.1 包形态与加载

| 约定 | 内容 | 证据 |
| --- | --- | --- |
| 客户端插件声明 | 插件 `package.json` 用 `dsh.client` 字段声明客户端形态：`{ "platform": "web", "inject": [...], "external": [...], "immediately"?: true }` | `dsh-client-modules/lib/index.js:65-73`（解析）、`:714`（`platform !== "web"` 即忽略）、`:719`（声明了 `dsh.client` 却没有 `./client` 导出时报错） |
| 客户端入口 | 客户端代码走 `exports["./client"]`，宿主入口走 `exports["."]`；二者缺一不可 | `dsh-client-ui-theme/package.json:21-24,29-41` |
| 宿主 patch | 插件用 `dsh.bundle.patch` 指向自己的 `cordis.patch.yml`；**只有**声明了它的依赖才会被自动追加进 `dsh.profile.bundles` | `dsh-app-boot/lib/index.js:1071`（`bundle` 判定）、`:1113`（推进 bundles） |
| **客户端产物格式** | **不是 ESM 也不是普通 IIFE**，而是 DSH 私有的「惰性 CJS 注册」：`window.__ModuleLoader__.load({ id: "<包名>", factory(require) {…} })`。通用 Vite/Rollup 的默认 ESM 输出**不会**被加载 | `dsh-client-ui-theme/lib/client.js:1-3`；官方模板 `dsh-agent-preset/skills/cordis-plugin-development/templates/decoration/client.js:1-22` |
| 客户端加载链路 | Loader 条目 → `ClientModuleRegistry` 增量扫描 → `/plugins/??<id>/client.js&rev=<rev>` + `window.__DSH_BOOT__` → 浏览器惰性物化 | `dsh-client-modules/lib/index.js:526,580,607,201,494` |
| 共享基座（9 键） | 可用 `require()` 拿到的只有：`react`、`react/jsx-runtime`、`react-dom`、`react-dom/client`、`@deepseek-ai/cordis`、`@deepseek-ai/dsh-client-store`、`@deepseek-ai/dsh-client-ui-slots`、`@deepseek-ai/dsh-client-ui-primitives`、`@deepseek-ai/dsh-client-ui-dockkit`。**其它任何 import 必须写进 `dsh.client.external`**，否则组合阶段被拒 | `dsh-web-frontend/dist/assets/index-*.js`（冻结表 `PLATFORM_MODULES`） |
| **本包的取舍** | 本包客户端只 `require('react')`，因此 `inject: []`、不需要 `external`。**不 import 任何 `@deepseek-ai/dsh-client-*`**（官方 skill 明令：plain-JS 插件没有类型检查，抛错的组件会让整个 slot 条目变空白） | `dsh-agent-preset/skills/cordis-plugin-development/references/practices.md:35` |
| HMR | 开发期 `dsh-client-hmr` 以 `pollIntervalMs`（默认 500）轮询重建；改动后仍需**硬刷新一次**让新的 `window.__DSH_BOOT__` 生效 | `dsh-client-hmr/README.zh.md:32,42`；`dsh-client-modules/lib/index.js:607` |

> ⚠️ **不用 `immediately: true`**：该字段只在解析器里做了布尔校验（`dsh-client-modules/lib/index.js:68`），语义**没有任何文档定义**，属版本特定行为。本包省略它，走默认时机。

### 3.2 界面组合（UI）

| 约定 | 内容 | 证据 |
| --- | --- | --- |
| 三栏框架 | 整个 Web GUI 的外壳由**一次** root 注册声明 5 个子 slot：`sidebar`(single/root)、`main`(keyed/root)、`rightbar`(single/root)、`shell.overlay`(list/root)、`shell.leading`(single/root)。栅格 = `${sidebar}px minmax(400px,1fr) minmax(0,${rightbar}px)` | `dsh-client-ui-layout/lib/client.js:601-627`、`:320` |
| **左右两列都已被占** | `sidebar` 被官方导航栏占、`rightbar` 被官方右侧栏占；注册进去是**替换**官方 UI，不是并列（`replaceRisk: shadows-shipped-ui`） | 权威 slot 目录 `dsh-cordis-client-runner/lib/client.js:4902`（sidebar）、`:4238`（rightbar）、`:4300`（root：DO NOT register here） |
| 附加席位（真正可用的） | 右列 tab 位 `sidebar.right.pane.tab`（keyed/session）；左列图标位 `sidebar.panellist`（list/root，**但面板正文渲染在中栏 `main`，不是左侧新列**）；浮动层 `shell.overlay`（list/root，`replaceRisk: none`，点击穿透） | `dsh-cordis-client-runner/lib/client.js:5106`、`:5060`、`:4811` |
| 声明纪律 | **不存在** `declareSlot`/`defineSlot`。一个 slot 只能由**你自己的** `register`/`registerFactory` 的 `children: { "<key>": { kind, scope } }` 表声明；注册到未声明的 slot 会抛 `slot "X" is not declared (a parent entry's children table must declare it)` | `dsh-client-ui-slots/lib/index.js:105-112,224-236`、`:165` |
| kind 必填项 | `single` 无 / `keyed` 要 `key` / `list` 要 `id` / `chain` 要 `select` | `dsh-client-ui-slots/lib/index.js:169-190` |
| `ctx.slots.inject` 的真实语义 | **不是声明**，而是「等这个 key 被声明后再跑回调」；owner 条目卸载时其子声明坍缩、回调被 dispose（**插件会静默失效**） | `dsh-client-ui-renderer/lib/client.js:1343-1402`、`:1359-1374` |
| 主题 | 只用 `--dsw-alias-*` token；写死颜色只允许用于「插图」 | `dsh-agent-preset/skills/cordis-plugin-development/references/practices.md:34` |

### 3.3 会话事件与身份

| 约定 | 内容 | 证据 |
| --- | --- | --- |
| **宿主侧会话事件** | 事件名 **`'session/event'`**，服务 **`ctx.sessions`**；签名 `'session/event'(this: Scoped<Session>, session: Session, event: SessionEvent): void`，mode `emit` | `dsh-tool-cordis/lib/types/api-catalog.js:4056-4061`、服务 `:2236-2237`；监听实证 `dsh-agent-loop/lib/index.js:319` |
| 用户消息进入 canonical | `event.type === 'user/message'` | `api-catalog.js:6343`；监听实证 `dsh-agent-loop/lib/index.js:321` |
| assistant **成功**结算 | `event.type === 'assistant/message'`（失败的 `assistant/attempt` / 中止**不是**它） | `api-catalog.js:6343`；`dsh-session/README.zh.md:88`；监听实证 `dsh-acp/lib/index.js:880` |
| 「settlement」字面事件 | **不存在**。全库只有 `dsh-session/lib/index.js:1129` 的报错文本 "invalid settlement fields" | grep 实证 |
| **稳定事件 id** | durable 事件信封是 `{type, seq, time, data, surfaceOp?, sourceEventSeqs?}` —— **没有 `id` 字段**。稳定 id 只能是 **`seq`**（会话日志位置）。业务内部 id 在 `data` 里（`user/message`→`data.id`；assistant→`${turn}:${step}`） | `dsh-session/lib/index.js:1413-1419`；`dsh-client-ui-chat/lib/client.js:9200,7562` |
| **surface 替换也会触发** | `surfaceOp: 'replace'` 的副本同样发 `session/event`；必须用 `isAppendSurfaceEvent(event)` 过滤，否则重复消费 | `dsh-session/lib/index.js:189`；示例 `dsh-message-feedback/lib/index.js:197` |
| `session/event` 不是门禁 | 它是 post-commit、fire-and-forget；观察者抛错只记日志，**不会**让 append 失败 | `api-catalog.js:4060` |
| 跨会话观察 | 需要 `{ global: true }` 选项，否则受 `dsh-scope` 作用域过滤 | `dsh-api-session-controller/lib/types/history.js:158-163` |

### 3.4 发送前上下文注入

| 约定 | 内容 | 证据 |
| --- | --- | --- |
| **发送前注入：可行**，但改的是「进入该 step 的消息批次」，**不是**改写用户原文 | waterfall 事件 **`agent/pre-step`**：`payload: { agent, messages: UserMessage[], turn, step, signal }`，`next(): Promise<PreStepDecision>` | `api-catalog.js:3688-3693`；`PreStepDecision = { kind:'reject' } \| { kind:'enter'; messages: UserMessage[]; startsRequestSeries?: true }` `api-catalog.js:5856` |
| 时序 | `agent/pre-step` 跑在 `user/message` 落盘**之前** —— 这正是规格 §6.4「发送瞬间快照」需要的时机 | `dsh-agent-loop/README.zh.md:119` |
| 注入实现样板 | `await next()` 后返回 `{ ...decision, messages: entered }`；**必须** `await next()`，且返回是**整体替换**（要自己保留原 messages） | `dsh-agent-instructions/lib/index.js:1271-1288`；`dsh-hooks-claude-code/lib/index.js:232-247` |
| 另一条注入路 | `agent.inject(message: UserMessage): void` —— 加入 model-facing 上下文但**不唤醒** driver，落到下一个被接纳的 step | `dsh-agent/README.md:47` |
| **系统提示词贡献：可行** | `ctx.systemPrompt.section(PromptSection)`；`PromptSection = { name, order, text: string \| ((ctx) => string), interpolate?, complete? }` | `api-catalog.js:2883`、`:5912`；实证 `dsh-web-app/lib/index.js:178-185`、`dsh-plan-mode/lib/index.js:171-178` |
| 不存在的钩子 | `beforeSend` / `preSend` / `transformPrompt` / `injectPrompt` —— 全库 **0 命中** | grep 实证 |
| 容易误认的两条路 | `ctx.inputTriggers.registerSource` 只驱动 composer 补全菜单；`ctx.commands.register` 直接执行 slash 命令、**不发给模型** | `dsh-client-ui-input-trigger`、`dsh-commands`；`api-catalog.js:570` |

### 3.5 工具注册与执行上下文

| 约定 | 内容 | 证据 |
| --- | --- | --- |
| 注册工具 | `ctx.tools.register(defineTool({...}))`；插件须 `export const inject = ['tools']` | `api-catalog.js:3158`；`defineTool` `dsh-tools/lib/index.js:838` |
| **会话身份来源** | `exec.agent?.session.header.id`（`ToolExecutionInput.agent?: Agent`）——**来自执行上下文**，与浏览器当前打开哪个会话无关 | `api-catalog.js:7436`、`:7504`；实证 `dsh-tool-fs-search/lib/index.js:287`、`dsh-tool-todo/lib/index.js:172-173` |
| 只读标记 | `isConcurrencySafe?: (args) => boolean` | `api-catalog.js:7416`；实证 `dsh-tool-fs/lib/index.js:344` |
| schema DSL | `parameters` / `output.schema` 是 DSH **自有** DSL，不是原始 JSON Schema | `dsh-tools/README.zh.md:60` |

### 3.6 存储与 Host↔Client 通道

| 约定 | 内容 | 证据 |
| --- | --- | --- |
| 存储服务 | `ctx.storage`（纯注册表）+ `ctx.storageDomain`（领域门面） | `dsh-storage/lib/index.js:109`；`dsh-storage-domain/lib/index.js:450` |
| 声明与打开 | `defineDomain({name,version,tables})` / `domainTable(schema)` / `await ctx.storageDomain.open(spec)` | `dsh-storage-domain/lib/index.js:61,46,355` |
| 读写 | 读同步、写持久后才 resolve：`domain.table(n).get/put/update/delete`、`domain.global.get/set` | 同上 `:187,257,278,264,157-173` |
| **没有任何内建乐观并发** | storage/domain 层既无 CAS 也无 revision，只有「每领域一条写链」串行化 → 后写覆盖先写。领域 `version` 是 **schema 格式版本**，不匹配直接 `version-mismatch` 拒绝且**不做迁移** | `dsh-storage-domain/lib/index.js:119-120,223-224`；`dsh-storage/README.zh.md:79`；`dsh-storage-domain/README.zh.md:153` |
| → **对本项目的直接后果** | 规格 §9 要求的 `rev` + 409 乐观并发，**必须由本插件自己在 domain 记录里存 revision 字段并自行比对**，不能指望宿主提供 | 由上一行推出（本卡结论） |
| 磁盘位置 | `%USERPROFILE%\.dsh\storages`（随附 `root: !!js dshHomePath('storages')`）；`single` 布局 `<root>/<unit>.json`、`per-record` 布局 `<root>/<unit>/<table>/<key>.json` | `dsh-home-paths/lib/index.js:11,50,73-76`；`dsh-base/cordis.patch.yml:171`；`dsh-storage-json/lib/index.js:551,179,313` |
| Host→Client 端点 | Host 用 `@Remote` 标记方法、`class X extends TypertRemoteService`；Client 侧 `await ctx.remote.$mount(contribution)` 后成为 `ctx.remote.<ns>.<method>()`；一元返回 `RemoteResult<T>`（载体故障**不 reject**） | `dsh-typert-protocol/lib/index.js:183,159,146`；`dsh-api-gateway/lib/client.js:1636`；`dsh-api-remotes/lib/client.js:13024` |
| **Host→Client 推送** | Host `ctx.typertGateway.registerRemoteEvents(source, { home })`；Client `ctx.remote.$on(event, listener)`。**重连不重放**普通通知 | `dsh-api-gateway/lib/index.js:665`；实证 `dsh-api-remotes/lib/index.js:134`、`dsh-client-ui-goal/lib/client.js:577` |

### 3.7 安装与 profile

| 约定 | 内容 | 证据 |
| --- | --- | --- |
| profile 结构 | profile 目录 = `package.json`（`dsh.profile.bundles` 有序清单）+ `cordis.patch.yml`（用户 patch 层，顶层 YAML 数组） | `~/.dsh/profiles/web/` 实况；`dsh/README.zh.md` §Profile |
| 配置层叠顺序 | 空根 → `dsh.profile.bundles` 各组合包 patch → profile `cordis.patch.yml` → `$DSH_HOME/cordis.patch.yml` → `--patch` | `dsh/README.zh.md:41-45` |
| 安装命令 | `dsh plugin --profile <name> <pnpm args>`，**原样转发给 profile 目录里的 pnpm**：`add <pkg>` / `remove <pkg>` / `why <pkg>` | `dsh/lib/bin.js:116`；字面量示例 `:48` |
| 版本豁免（DSH 自有子命令） | `dsh plugin --profile <p> version-exemptions` / `allow-version <pkg@ver> --dsh-version <exact> --accept-risk` / `revoke-version …` | `dsh/lib/plugin-DkYIj96-.js:24,27,33,44` |
| **列出 profile** | **没有**专用命令；自动化只能 `readdir $DSH_HOME/profiles` 或逐个 `dsh --profile <n> --dump-config` | `dsh/lib/bin.js:104`（全部 option），无列举逻辑 |
| **desktop profile 被硬拒** | CLI 拒绝针对 `desktop` 的启动 / config dump / 插件管理（Electron 独占） | `dsh/lib/bin.js:36`；`dsh/README.zh.md:20` |
| Web profile 启动 | `dsh web`；`web` / `headless` / `sdk` / `acp` 首次使用时从随附模板自动初始化 | `dsh/README.zh.md:17,20` |
| 推荐安装路径（本会话不可用） | 宿主 Agent 的 `plugin_manager` 工具 `action: install_bundle` + `target: <包目录绝对路径>`；官方 skill **明令不要**手写 profile 配置 | `dsh-agent-preset/skills/cordis-plugin-development/SKILL.md:8,10`；`references/host-plugin.md:58` |

### 3.8 会话气泡（Chat transcript）

| 约定 | 内容 | 证据 |
| --- | --- | --- |
| 注册业务气泡行：**可行** | `ctx.uiConversation.events.register(definition)`；`definition = { kind, target, match, start, update, buildViewNode, publication?, buildLocationData? }`，与官方 Definition 同一 registry | `dsh-client-ui-conversation/lib/client.js:2654-2657`；`target`/`buildViewNode` 必须成对（`:2689`）；官方样板 `dsh-client-ui-chat/lib/client.js:9195-9239` |
| `match` 的 null 契约 | `match(event) => { id, role } \| null`；返回 `null` 即不消费该事件 | `dsh-client-ui-conversation/lib/client.js:2148-2153` |
| Definition 能拿到的稳定 id | `match.event.seq`（durable 信封没有 `id` 字段） | `dsh-client-ui-conversation/lib/client.js:2145,2149`；`dsh-session/lib/index.js:1413-1419` |
| 渲染分派 | `ctx.slots.register({ name: 'conversation.chat.node', key: '<我的 kind>' }, View)` | `dsh-client-ui-chat/lib/client.js:1770`；官方 key 表 `:6711-6801` |
| 官方气泡旁的合法扩展位 | `conversation.chat.assistant-actions`（收 `{ messageId }`）、`conversation.chat.turnTail`（收 `{ turn, seq, openFile }`） | `dsh-cordis-client-runner/lib/client.js:2397-2401,2561,2586`；`dsh-client-ui-chat/lib/client.js:6523,6512-6516` |
| 官方行的 DOM 标记（装饰用，**非公开契约**） | `data-chat-node-key` / `data-chat-anchor-key` / `data-chat-flow-key` / `data-chat-flow-kind` / `data-chat-turn` / `data-chat-group-part` | `dsh-client-ui-chat/lib/client.js:1757-1778` |
| 官方行的 class **不可依赖** | 来自 CSS module 哈希（如 `fq8vsa_flowItem`） | `dsh-client-ui-chat/lib/client.js:1630,1759` |

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
| 2026-09-27 | 卡 1：四路只读侦察把 §3 的宿主约定从 8 条扩到 **40+ 条**（含 P1–P4 的源码级结论）；新增 §2.1–§2.5 探针明细；P5 装机实测 10/10 通过；记录两个坑（宿主行必须启用、客户端 bundle 禁 `export`） | 见各小节证据列；脚本 `verify-boot.mjs` / `verify-render.ps1` |
| 2026-09-27 | 布局朝向经主人批复修正：规格 §4 由「左图右聊」改为「**中聊右图**」，并同步进 `docs/01-产品与技术规格.md` §4.1 | 主人当面批复（本会话） |
