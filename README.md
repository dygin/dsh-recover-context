# dsh-recover-context

> v1.0.7 · 适配 DeepSeek Harness 0.2.1+

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
- **安全上限**：`maxFiles`（默认 100,000）与 `maxTotalBlobBytes`（默认 500MB）防止超大仓库失控。

## 配置

可选配置文件：`~/.dsh/storages/recover-context/config.json`

```json
{
  "enabled": true,
  "enableGitignore": true,
  "ignoreNames": [".git", "node_modules", ".pnpm-store", "dist", "build", ".venv", "__pycache__", ".DS_Store"],
  "ignorePatterns": ["*.pyc", "*.log", "*.tmp"],
  "trackSizeCap": 5242880,
  "blobSizeCap": 1048576,
  "maxFiles": 100000,
  "maxTotalBlobBytes": 524288000
}
```

| 字段 | 说明 |
| --- | --- |
| `enabled` | 总开关，`false` 时完全停止采集 |
| `enableGitignore` | 是否解析工作区 `.gitignore` |
| `ignoreNames` | 按名字忽略的目录/文件 |
| `ignorePatterns` | 按文件名通配符忽略 |
| `trackSizeCap` | 超过该大小的文件只记录 size+mtime，不计算哈希 |
| `blobSizeCap` | 超过该大小的文件不备份内容（回退时会跳过并提示） |
| `maxFiles` | 扫描文件数上限，超出即停止并告警 |
| `maxTotalBlobBytes` | 单次回退所需 blob 总量上限 |

## License

Apache-2.0
