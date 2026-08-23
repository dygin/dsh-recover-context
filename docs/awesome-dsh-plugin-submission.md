# awesome-dsh-plugin 收录提交文件

按照 [contributing.md](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin/blob/main/contributing.md)
规范，向 [awesome-dsh-plugin](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin) 提交 PR 时，
在仓库中新建 `data/plugins/<owner>__<repo>.yml`，内容如下：

```yaml
url: https://github.com/<你的用户名>/dsh-recover-context
name: <你的用户名>/dsh-recover-context
category: ui
description:
  en: Roll back to before any of your questions or edit the last one and resubmit, with the workspace files of the discarded turns restored.
  zh: 回退到任意一条提问之前，或编辑上一条问题重新提交；被丢弃轮次产生的工作区文件会一并还原。
```

> 把 `<你的用户名>` 替换为真实 GitHub 用户名；`url` 必须与仓库地址完全一致，
> `name` 为列表中的链接文字。中文描述可选，不写维护者会补。

## 收录前自查清单（对照规范）

- [ ] **`dsh.bundle` manifest**：`package.json` 已声明 `dsh.bundle.patch: ./cordis.patch.yml`，且仓库根有 `cordis.patch.yml` ✅（CI 自动检查）
- [ ] **真实可用代码**：非占位仓库 ✅
- [ ] **仓库创建满 1 天**：新仓库需等 1 天（CI 自动检查）
- [ ] **≥ 10 个 commit**：当前 6 个，还需继续提交几次（CI 自动检查；不够可以稍后重新提交，不影响）
- [ ] **添加 `dsh-plugin` topic**：GitHub 仓库 → Settings → Topics → 添加 `dsh-plugin`
- [ ] **npm 包的 `repository` 字段指回本仓库**：发布前把 `package.json` 的
      `repository` / `homepage` / `bugs` 从占位地址改成真实 GitHub 地址（否则 npm 包与条目无法关联，会被拒绝）
- [ ] **描述属实、无营销词**：上面的描述与代码行为一致（逐条可核对）
- [ ] **分类 `ui`**：贴合"对话界面操作按钮"的实际定位
- [ ] **截图（可选，推荐）**：`assets/` 放 1-2 张演示图，加入 awesome 仓库的
      `data/screenshots.json`（需 GitHub 托管的 https 图源）

## 提交步骤

1. 到 [awesome-dsh-plugin](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin) fork 仓库
2. 新建 `data/plugins/<你的用户名>__dsh-recover-context.yml`，粘贴上面的内容（替换用户名）
3. 按规范重新生成 README：`npm ci && node scripts/generate-readme.mjs`
4. 提交并推送，开 Pull Request（一个 PR 只加这一条）
5. CI 通过 + 维护者人工阅读源码后合并，网站自动重建

合并后（可选）：README 顶部加官方徽章
`![Awesome DSH Plugin](https://awesome-dsh-plugin.com/badge.svg)`，
插件会自动出现在 dsh-market 市场与 dsh-find-plugin 搜索结果中（带手写双语描述）。
