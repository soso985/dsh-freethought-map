# dsh-freethought-map

> FreeThought Map 的 **DSH（DeepSeek Harness）`web` profile 插件**：在官方对话旁，边聊边落下可回看、可续问的**思路链**。
> 一句话：**框架我定，节点我建，连线我拉，位置我摆；AI 只是笔和资料库，不是老师。**

状态：**卡 0 完成 / 卡 1 进行中**（本包目前只有一个探针壳，还不是产品）。
宿主版本：**dsh `0.1.7-rc.2` · commit `c1275515b6b97551ec358c926c479ab750c687c0`**（见 [docs/HOST.md](docs/HOST.md)）。

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
| 进度 | 卡 0 完成；卡 1 探针进行中（**尚无落链、存储、工具**） |
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
│   └── HOST.md                 # ★ 宿主版本 + 五项扩展点探针记录（唯一取证处）
├── src/
│   ├── host/      index.js     # 宿主一半（卡 1：仅加载证据；卡 2/3/6 加存储、订阅、工具）
│   ├── client/    index.js     # 客户端一半（卡 1：探针壳；之后是画布）
│   └── overlay/                # 纯函数：落链、补链、上提、防环、patch（不 import ctx）
└── scripts/
    └── verify-package.mjs      # 卡 0 静态验收脚本（清单/导出/ESM 语法/module id）
```

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

### 4.3 本包自己的静态验收

不需要宿主，秒级可跑：

```powershell
& $node --experimental-vm-modules E:\dsh-freethought-map\scripts\verify-package.mjs
```

检查：清单字段齐全 · 两个导出指向真实文件 · 两个入口 ESM 语法可解析 · module loader 的 id 等于包名 · patch 行指向本包。

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
