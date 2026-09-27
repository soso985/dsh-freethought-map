# dsh-freethought-map

> FreeThought Map 的 **DSH（DeepSeek Harness）`web` profile 插件**：在官方对话旁，边聊边落下可回看、可续问的**思路链**。
> 一句话：**框架我定，节点我建，连线我拉，位置我摆；AI 只是笔和资料库，不是老师。**

状态：**八张实施卡全部完成**（卡 0–卡 8），343 条离线断言 + 真机验收；**画布尚未实现**。
宿主版本：**dsh `0.1.7-rc.2` · commit `c1275515b6b97551ec358c926c479ab750c687c0`**（见 [docs/HOST.md](docs/HOST.md)）。
**现在缺什么、下一步做什么** → [docs/05-项目说明书.md](docs/05-项目说明书.md) §8–§9。

---

## 0. 两个仓库不是一回事（先读这一节）
> ⚠️ 本项目有**两个完全不同的仓库**：一个是已发布的独立站，一个是本包（DSH 插件）。
> **本包不是独立站，独立站也不能当插件装。**

### 0.1 v0.1 独立站原型（已实现 · 不是本包）

| 项 | 内容 |
| --- | --- |
| 仓库 | **`soso985/freethought-map`**（本机 `E:\FreeThought Map`） |
| 形态 | **独立网页应用**：自带 ChatPanel、自带 OpenAI 兼容请求、数据存浏览器 `localStorage` |
| 状态 | 已实现、已开源（MIT）、可运行（`npm run dev` → :5180）；README §7 的 17 条验收项已实测通过 |
| 文档 | 该仓的 `README.md` / `开发日志.md` / `测试用例.md` / `04-项目说明书.md` |

**本包从独立站只复用一小部分**：双连线绘制、`parentId` 防环、删点后子节点上提、`dropPosition` 落点、节点外观。
**本包不搬入**：`AIPanel`、`aiStore`、`services/ai.ts`、整份 `mapStore` + localStorage 单文档、`App.tsx` 外壳、`index.css` 里的 `body`/`button` 全局规则。

### 0.2 本包 · DSH 插件（本仓库）

| 项 | 内容 |
| --- | --- |
| 包名 | `dsh-freethought-map` |
| 形态 | **DSH `web` profile 插件**：宿主负责会话 / 模型 / 流式 / 工具 / 权限 / 密钥 / 多会话；本插件只做**外置工作记忆** |
| 进度 | **卡 0–卡 8 全部完成**：落链、宿主权威存储（rev/409）、发送前注入、三个只读工具、用户操作与撤销栈、导入导出/重建投影、帮助。**未实现：2D 画布**（计划见 [docs/04-画布计划.md](docs/04-画布计划.md)） |
| 安装 | `dsh plugin --profile web add <本包绝对路径>`，或用宿主内置的 `plugin_manager` `install_bundle`（推荐，见下） |

**⚠️ 不要把独立站仓库 add 进来。** 对本包以外的任何目录执行安装，都只会装出一个跑不起来的网页站。

---

## 1. 红线（改任何一条必须先问主人，禁止静默漂移）

1. **禁止一次生成整张思维导图**——没有「生成导图」按钮，没有写结构的工具，也没有「整理成树」的 prompt 入口。**模型只读图。**
2. **禁止插件替代官方输入框**——官方发送是唯一发送入口。
3. **拉线不自动 `followup`**——用户拉粉线不会触发模型发言。
4. **拖拽只改 `position`**；粉线（自由联想）**不参与层级**。
5. **不引入全图唯一根**——断开就是真的断开，不自动重挂。
6. **第一版不改写、不删除 DSH 历史。**
7. **不 fork 官方包**；不把全局 CSS / `window` 快捷键打到宿主（只挂在插件自己的根节点上）。
8. **工具里的 `sessionId` 必须来自执行上下文**，禁止用浏览器当前打开的会话。

---

## 2. 与相邻项目的区别

| 项目 | 区别 |
| --- | --- |
| `dsh-talk-map` | 那是**会话卡片白板**（把会话当卡片摆）；本插件是**当前会话的链式工作记忆**，落链规则与焦点时序是核心。 |
| `dsh-mindmap-chat` | 那是**官方 fork 列**（改官方代码另做一套）；本插件**不 fork 官方包**，适配只放 `src/host`、`src/client`。 |
| v0.1 独立站 | 那是**独立产品**（自带 ChatPanel 与 OpenAI 兼容请求）；本插件**禁用** ChatPanel，聊天能力全部用 DSH 官方。 |

---

## 3. 目录结构

```
dsh-freethought-map/
├── package.json           # dsh.bundle.patch + dsh.client 声明；exports: "." 与 "./client"
├── cordis.patch.yml       # 宿主行插入（bundle patch 层）
├── docs/
│   ├── 00-AI接力-先读.md        # 协议、红线、阅读顺序
│   ├── 01-产品与技术规格.md      # overlay 类型、事件映射、存储协议、撤销、工具限额
│   ├── 02-实施计划.md           # 卡 0–卡 8 任务卡与逐卡验收表
│   ├── 03-粘贴给下一个AI的开场白.md
│   ├── 04-画布计划.md           # ★ 画布对账：原型交互清单、硬约束、三方案、分阶段计划
│   ├── 05-项目说明书.md         # ★ 本包说明书：目标/结构/入口/模块/栈/约束/验收/问题/下一步
│   └── HOST.md                 # ★ 宿主版本 + 探针记录 + §3.1–3.17 逐卡技术结论（唯一取证处）
├── src/
│   ├── host/      index.js     # 宿主入口（22 行：inject 转发 + apply 转发）
│   │              storage.js   # 权威存储 + 落链订阅 + 发送前注入 + 只读工具 + 9 个 RPC 端点
│   ├── client/    index.js     # 客户端 bundle（单文件自包含普通脚本，不能 import/export）
│   └── overlay/                # 纯函数层（8 个模块，不碰 ctx / 不碰 DOM，可离线验死）
│       ├── index.js   project.js   locate.js   links.js
│       └── inject.js  tools.js     undo.js     io.js
└── scripts/                    # 11 套离线验收 + 2 套真宿主验收 + CDP 驱动
```

**先读哪份**：想知道**这个包要做什么、现在缺什么** → [`docs/05-项目说明书.md`](docs/05-项目说明书.md)；
想知道**画布怎么做** → [`docs/04-画布计划.md`](docs/04-画布计划.md)；
想知道**某个技术结论是怎么测出来的** → [`docs/HOST.md`](docs/HOST.md)。

---

## 4. 安装与验证

### 4.1 推荐：用宿主内置的 `plugin_manager`

宿主 Agent 有 `plugin_manager` 工具，`action: "install_bundle"` + 本包**绝对路径**作为 `target` 即可完成「装包 + 选 bundle」，不必手写 profile 的 `package.json`/`cordis.patch.yml`，也不必自己在 profile 目录跑 pnpm。

### 4.2 命令行等价路径

```powershell
# dsh CLI 就在 Desktop 的 app.asar 里；用宿主自带 Node 跑：
$node = 'E:\Harness\resources\runtime\primary-runtime\dependencies\node\bin\node.exe'
$dsh  = "$env:TEMP\dsh-asar-extract\dsh\node_modules\@deepseek-ai\dsh\lib\bin.js"

& $node $dsh --version                       # → 0.1.7-rc.2
& $node $dsh plugin --profile web add E:\dsh-freethought-map
```

> `app.asar` 需要先解包才能读到与执行（解包命令见 [docs/HOST.md](docs/HOST.md) §1.1）。

### 4.3 本包自己的验收脚本

不需要宿主、秒级可跑（**343 条断言**，覆盖全部八张卡的验收条）：

```powershell
$node = 'E:\Harness\resources\runtime\primary-runtime\dependencies\node\bin\node.exe'
$s = 'E:\dsh-freethought-map\scripts'

& $node --experimental-vm-modules $s\verify-package.mjs   # 13 条 · 包清单/语法/module loader id
& $node $s\verify-overlay.mjs                            # 42 条 · overlay 纯函数（防环/上提/校验）
& $node $s\verify-client.mjs                             # 37 条 · 客户端 bundle（样式隔离/键盘/端点契约）
& $node $s\verify-host.mjs                               # 44 条 · 宿主接线与红线断言（防漂移/禁词/不变量）
& $node $s\verify-project.mjs                            # 27 条 · 落链投影（合成事件）
& $node $s\verify-locate.mjs                             # 25 条 · 图→气泡定位与降级行为
& $node $s\verify-links.mjs                              # 29 条 · 粉线与发送快照
& $node $s\verify-inject.mjs                             # 19 条 · 注入链路端到端（离线，不烧 token）
& $node $s\verify-tools.mjs                              # 27 条 · 三个只读工具（用宿主真实 ToolRuntime 校验）
& $node $s\verify-undo.mjs                               # 40 条 · 用户操作与撤销栈（含撤销↔重做往返）
& $node $s\verify-io.mjs                                 # 40 条 · 导入导出与重建投影
```

需要真宿主的两套（起一个隔离实例，见 [docs/HOST.md](docs/HOST.md) §3.1）：

```powershell
& $s\verify-boot.ps1  -Port 19388     # 11 条 · 构建加载探针（P5）
& $s\verify-session.ps1 -Port 19388   # 23 条 · 真浏览器：渲染/隔离/存储协议/导入导出往返
```

> 为什么能有 343 条离线断言：**产品的核心逻辑全部写成了纯函数**
> （落链、定位、粉线、注入决策、撤销、导入导出），宿主侧只留"取数据 → 调纯函数 →
> 写回"这一层薄壳。所以「注入到底注入了什么」这种看似必须真发消息才能验的事，
> 也能离线验死。详见 [docs/HOST.md](docs/HOST.md) §3.12 / §3.14。

### 4.4 改帮助文本时要重跑一次生成器

帮助正文会被**编译**进客户端 bundle（bundle 不能 `import` 相对模块）：

```powershell
& $node E:\dsh-freethought-map\scripts\build-help.mjs
```

忘了跑也不会静默漂移 —— `verify-io.mjs` 有一条断言逐字比对两边，直接红。

---

## 5. 开发纪律

1. **一次只做一张卡，做完停。** 卡片顺序见 [docs/02-实施计划.md](docs/02-实施计划.md)。
2. **不扩大范围**：趟、脉络自动精简、一次成树、自建聊天、回写/删除 DSH 历史、模型写图 —— 全部不做。
3. **不重写 DSH、不 patch 官方 UI 源码。** 适配只放 `src/host` / `src/client`。
4. **每卡必须写 `docs/HOST.md` 或日志**：dsh 版本号 + git commit，**禁止留「安装时填写」**。
5. **探针优先**：卡 1 的三项（布局 / 气泡点击 / 发送前注入）未验证通过，**不得开始卡 3**。
6. **未钉死项先问主人。** 擅自改产品布局 = 静默漂移。
7. **客户端插件纪律**（来自宿主官方 skill `cordis-plugin-development`）：
   - 不 import 任何 `@deepseek-ai/dsh-client-*` 包；React 从浏览器模块表取。
   - 不替换 app root，不往 `document.body` 追加节点。
   - 注册与监听都放 `apply(ctx)` 内并用 `ctx.effect` 归还清理；factory 内不做副作用。
   - 只用 `--dsw-alias-*` 主题 token 上色，不写死颜色。
   - 可见文案走 Client locale 服务。

---

## 6. 开源协议

MIT，© 2026 soso985。与独立站原型同一协议。
