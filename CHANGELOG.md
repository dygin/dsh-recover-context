# 更新日志

本项目的所有重要变更均记录于此文件。

格式基于 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，并遵循 [语义化版本](https://semver.org/lang/zh-CN/)。

## [1.0.7] - 2026-10-25

### 适配 DeepSeek Harness 0.2.1-rc.2

DSH 0.2.x 重构了宿主服务与浏览器插件契约，旧版本插件在此环境下无法激活。本版本完成全面迁移：

- **宿主端路由改用 Connection 精确 Fetch 路由**：`/api/recover-context/checkpoints` 与
  `/api/recover-context/restore` 通过 `ctx.connection.fetch.register` 注册，自动继承 Connection 的
  浏览器认证与 Host/Origin 信任域校验。没有 Connection 的部署仍回退到 `ctx.webServer` 自建路由 + 本地信任校验。
- **会话事件读取改用 SessionPersistence**：不再依赖已废弃的同步事件读取，改为
  `ctx.sessionPersistence.open(id, 'read')` 逐次读取事件日志，读后立即关闭句柄；cwd 也从
  `stat().header.cwd` 获取。
- **客户端改用 `uiConversation` / `useChat` 契约**：会话节点通过 `ctx.uiConversation.events.register`
  注册；`recover-actions` 渲染器与输入框入口改用框架下发的 `useChat` 标准钩子读取 ChatSnapshot
  （`order` / `nodes` / `locations` / `legacy.turnEnds`）。
- **回退后的导航改用官方 Workspace 流程**：`rollback` 通过 `ctx.uiWorkspace.openSession` 打开子会话；
  首问场景通过 `uiWorkspace.connectWorkspace` 在工作区中解析空白会话，随后 `openSession`，
  避免出现“会话已创建但界面未打开”的悬空状态。
- **节点归属轮次输入层**：`recover-actions` 节点声明 `groupTree: 'input'`，否则会被并入可折叠的
  turn-process 组，折叠时操作行随之隐藏。
- **字典改用 `ctx.locale.register`**：注册 `recover-context` 命名空间，插槽声明 `locale`，
  翻译函数由框架通过 `t` 下发。
- **包元数据**：新增 `engines.dsh: ">=0.2.1-rc.2"`；`dsh.client.inject` 更新为当前真实提供的
  客户端包列表。

### 修复

- 修复回退时因访问未注入的 `ctx.workspaces` 而报 `cannot get property "workspaces" without inject` 的问题。
- 编辑问题后提交时不再把旧会话的提交回声 `requestId` 转交给子会话。

## [1.0.6] - 2026-09-01

### 修复与优化

- **CAS 内容寻址存储（Content-Addressable Storage）**：将文件 blob 从单体 JSON 文件中彻底解耦，按 SHA-256 独立落盘存储到 `blobs/<sha>`。彻底消除全量 Base64 字符串内存常驻以及超大 JSON 序列化/反序列化导致的 OOM。
- **基线流式落盘与 O(1) 内存开销**：在建立基线时逐个流式写盘，`baseline.json` 仅保留轻量元数据索引 `{ relPath: TrackedFile }`。在数十 GB 大工作区下彻底杜绝内存撑爆。
- **支持工作区 `.gitignore` 自动解析**：自动解析工作区根目录 `.gitignore` 规则（支持通配符、目录忽略、取反 `!` 等），自动跳过大型非代码或数据目录（如 `stuff/`、`datasets/` 等）。
- **安全熔断机制**：新增 `maxFiles`（最大追踪文件数，默认 100,000）和 `maxTotalBlobBytes`（单会话最大存储 Blob 总字节数，默认 500MB）防护上限，超限自动安全告警与熔断。
- **原子落盘保护**：所有快照 JSON 和 CAS blob 文件均采用临时文件 + 重命名（atomic write via `.tmp`）写入，防止进程意外退出产生损坏的半成品文件。
- **流式 SHA-256 哈希计算**：采用 Stream 流式哈希计算，避免直接整读大 Buffer 造成瞬时内存峰值。

## [1.0.0] - 2026-08-20

首次发布。

### 新增特性

- **会话回滚**：每个用户问题下方提供撤销图标。点击（并确认）后将丢弃该问题及其之后的所有内容：对话上下文被截断（旧会话归档，新会话从该问题前继续），工作区中产生的文件变更通过快照恢复。
- **编辑并重新提交**：最新问题（及生成中的输入框工具栏）提供铅笔图标。将原问题文本载入输入框且暂不改变上下文，用户实际提交的一瞬间执行截断回退并重发。
- **工作区快照与检查点**：宿主记录基线及每个完成 turn 的差量快照（自动忽略 `.git`、`node_modules` 等），支持精准恢复新增/修改/删除的文件。
- **纯图标 UI**：轻量悬浮图标、工具提示、回滚二次确认（红勾）。
- 提供宿主 JSON API (`/recover-context/api/checkpoints`, `/restore`) 及配置支持 (`~/.dsh/storages/recover-context/config.json`)。
