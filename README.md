# dsh-recover-context

> v1.1.2 · 适配 DeepSeek Harness 0.2.1+

恢复上下文插件。

- **↶**：点击后，**这个问题及其之后的所有内容**（对话上下文 + 工作区里产生的文件变更）都会被回退掉——旧会话归档保留日志，新会话从提问之前继续。之后你可以换个方向重新提问，模型不会再被错误的上下文干扰。
- **✎**：点击把原问题文本载入输入框，**此时不改变任何上下文**；编辑后提交的那一瞬间执行回退并重新提问。

## 安装

```bash
dsh plugin --profile web add dsh-recover-context@latest
```

安装后插件会自动挂载到 web 组合，无需手工编辑 `cordis.patch.yml`。

> 本版本要求 DSH `>= 0.2.1-rc.2`：使用了该版本的 Connection Fetch 路由、SessionPersistence 与
> `uiConversation` / `useChat` 客户端契约，与更早的版本不兼容。

## 工作区追踪

插件把工作区快照存放在 `~/.dsh/storages/recover-context/<sessionId>/` 下（绝不写入工作区）：

```
baseline.json      基线元数据索引（仅 {路径: {sha,size,mtime}}，不含文件内容）
turn-<n>.json      每轮结束时的元数据索引
blobs/<sha>        按内容寻址（CAS）存储的文件内容
```

- **基线/逐轮索引**：只记录文件清单与哈希，单个 JSON 通常在几十 KB 量级。
- **内容按哈希去重**：文件内容按 SHA-256 存成独立 blob，跨轮次、跨同名文件自动复用；恢复时按索引取回。
- **流式哈希与原子落盘**：SHA-256 用流式计算；所有 JSON 与 blob 先写临时文件再 `rename`，进程中断不会留下半成品。
- **自动读取 `.gitignore`**：遍历时解析工作区根目录的 `.gitignore`（支持通配符、目录规则、`!` 取反），大型数据目录不会被扫描。
- **被忽略路径也会被回退**：被忽略路径不备份内容，但会记录其存在性索引。回退时只删除「本会话新增」的
  产物（如 `dist/`、`build/`、`*.log`），会话开始前就存在的同类文件保持不动。
- **基线在会话创建时采集**：早于任何提问与工具调用，因此稳定代表"工作开始前"的状态。
  这正是编辑/回退能可靠撤销本轮产物的前提。
- **子会话继承父会话历史**：回退后打开的新会话会继承父会话的基线与已完成的逐轮快照，
  因此在其中继续编辑/回退同样能撤销此前轮次的产物，而不是逐层失效。
- **跨会话识别遗留产物**：插件维护一份工作区级产物台账，记录每个会话产出过哪些文件。
  上一个对话留在工作区里的产物，会在下一个会话回退/编辑到基线时被一并清除——
  前提是内容与台账记录完全一致（被改动过的文件视为用户资产，绝不删除）。
- **还原失败不会静默通过**：目标快照不可用时接口报错、客户端中止流程，绝不出现
  "对话回退了但文件没动"的不一致状态；还原后还会自检文件是否真的已删除。
- **安全上限**：`maxFiles`（默认 100,000）与 `maxTotalBlobBytes`（默认 512 MiB）防止超大仓库失控。
  单文件默认不限体积（流式复制，内存恒定），可用 `blobSizeCap` 显式收紧。

## 配置

可选配置文件：`~/.dsh/storages/recover-context/config.json`

```json
{
  "enabled": true,
  "enableGitignore": true,
  "ignoreNames": [".git", "node_modules", ".pnpm-store", "dist", "build", ".venv", "__pycache__", ".DS_Store"],
  "ignorePatterns": ["*.pyc", "*.log", "*.tmp"],
  "trackSizeCap": 104857600,
  "maxFiles": 100000,
  "maxTotalBlobBytes": 536870912,
  "ioConcurrency": 8,
  "cleanupPreviousArtifacts": true
}
```

| 字段 | 说明 |
| --- | --- |
| `enabled` | 总开关，`false` 时完全停止采集 |
| `enableGitignore` | 是否解析工作区 `.gitignore` |
| `ignoreNames` | 按名字忽略的目录/文件 |
| `ignorePatterns` | 按文件名通配符忽略 |
| `trackSizeCap` | 超过该大小的文件只记录 size+mtime，不计算哈希、不备份内容（默认 100 MiB） |
| `blobSizeCap` | 可选：单文件内容备份上限，默认不限制（受 `maxTotalBlobBytes` 兜底） |
| `maxFiles` | 扫描文件数上限，超出即停止并告警 |
| `maxTotalBlobBytes` | 单个会话可备份的 blob 总字节上限 |
| `ioConcurrency` | 哈希计算与 blob 写入的并发度 |
| `cleanupPreviousArtifacts` | 回退/编辑到基线时，是否清除上一个对话遗留的产物（默认 `true`；只删内容未被改动过的） |

## License

Apache-2.0
