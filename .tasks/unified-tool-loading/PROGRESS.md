# Progress

- Shape: durable
- FinalizationStatus: complete
- Truth: .tasks/unified-tool-loading/TODO.csv（8/8 DONE）
- Current: 已交付。统一策略、一致性修复、RPC/持久化、面板与文档均已落地并有回归证据。
- Latest validation: 2026-11-07 完整测试 977 例 / 970 pass / 0 fail / 7 skip（0.2.1-rc.5 本树）；隔离树 0.2.2-rc.1 同数量、947 pass / 32 skip。逐条证据见 REVIEW-1.10.0.md 与 PLAN-1.11-architecture.md。
- Next: 按 PLAN-1.11 继续 P2 收尾（文档剩余处、发布说明）；v1.10.0 已发布，修复以 1.10.1 形式提交。
- Workspace: D:/sudy/github/dsh-toolbox-ui/.worktrees/feature/unified-tool-loading @ feature/unified-tool-loading，基线 cb02d6e。v1.10.0 已提交并推送到 origin/main；本轮修复尚在工作区，未提交。
- SetupChange: node_modules 为 junction（复用已安装依赖，未改 lockfile）；.worktrees 已被既有 .gitignore 忽略。

## 事故记录（2026-11-01）

为做真机验证，我把工作树以 `dsh plugin --profile e2e add <worktree>` 装进隔离 profile（link 形态），
随后 `remove` 时删除的是 Windows **junction**，删除操作顺着链接把工作树内容整目录清空
（`.git` 文件也一并消失）。未提交的改动因此丢失，本文档、代码与测试是按会话内记录重建的。

教训：**在 Windows 上不要对 junction 形态的本地插件执行 remove**；装本地包请用 `file:` 并先把
`node_modules` junction 移开，或复制构建产物后再安装。

## 交付摘要

1. 搜索结果自相矛盾（本批旧工具被同一次淘汰）。
2. MCP 使用说明被整份遮掉 → 永不遮罩。
3. 并发保存半生效 → 比较/写盘/重装同处串行操作。
4. 保存静默吃掉错键 → 与加载期同口径严格校验。
5. 跨项目策略串扰 → 按当前会话 `wsPath` 解析。
6. 面板读到空工具表（无 agent 时回退空集）→ 重建过程中自查发现并修复。
7. 项目 `legacy` 覆盖全局方案 → 自查发现并修复。

## 已知限制 / 未验证项

- 真实 GUI 已在19791使用启动打印的认证入口验证；桌面与390px覆盖三页、两个市场、列表滚动和弹窗。未执行真实用户写入，写路径由自动化临时目录测试覆盖。
- 宿主结论基于已安装 `0.2.1-rc.5`，未解包核对打包宿主。
- 非 MCP 工具默认常驻：宿主无来源接口，内置工具不能自动识别并默认延迟。
- 持久化验证使用临时目录与真 loader，未触碰用户真实 profile。
