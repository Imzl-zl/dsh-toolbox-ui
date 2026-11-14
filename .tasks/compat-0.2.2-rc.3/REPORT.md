# 0.2.2-rc.3 兼容基线报告

> 状态：**基线已绿，已提交**（`d14cfc2`，分支 `compat/dsh-0.2.2-rc.3`）。worktree：`.worktrees/compat-0.2.2-rc.3`。
> 日期：2026-11-14。

## 1. 结论

**rc.3 不需要改功能代码。** 宿主在 rc.2 → rc.3 之间没有动本插件依赖的任何服务面；唯一一处契约形状变化
（`checkGuards()` 返回结构化拒绝理由）只影响测试夹具。真正要做的是**把开发基线与 CI 腿从 0.2.1-rc.5
换到 rc.3**，并让现代宿主那 7 个原本被 skip 的真实宿主用例跑起来。

## 2. 证据

| 项 | 事实 |
| --- | --- |
| 桌面运行时 | `resources/runtime/primary-runtime/runtime.json` = `0.2.2-rc.3`；进程 2026-11-14 08:21 启动，晚于 11-13 15:30 的运行时落盘 |
| 实际加载 | 桌面 profile 装的是本仓库 1.11.2，与 rc.3 同进程运行 |
| rc.2 → rc.3 源码 | `core/tools`、`mcp/mcp-client`、`api/gateway`、`core/agent`、`skill`、`typert`、`boot` **零改动**；仅 client UI 包改动，且为增量（新增 `sidebar.session.action` 插槽） |
| 依赖代 | rc.1/rc.2/rc.3 均为 cordis `~4.1.0`、loader `~1.1.0`、include `~1.1.0` |
| 本插件 peer | cordis `>=4.0.5 <4.2.0`、loader `>=1.0.6 <1.2.0`、`engines.dsh >=0.2.1-rc.5 <0.3.0`，均覆盖 rc.3 |
| 槽位 | 本插件用的 `shell.overlay` / `sidebar.footer.action` 在 rc.3 仍声明 |

## 3. 唯一的契约形状变化

`ToolRuntime.checkGuards()` 在 rc.3 返回 `ToolGuardDenial | undefined`（`{ reason }`），不再是裸字符串。
生产代码只**注册** guard、不读这个返回值，所以不受影响；`test/tool-search-rc22-host.test.mjs` 的夹具
取 `.reason` 即可（注释已写明原因）。

## 4. 改动清单（13 个文件）

| 文件 | 改动 |
| --- | --- |
| `package.json` | 12 个 `@deepseek-ai/dsh-*` devDep → `0.2.2-rc.3`；cordis → `~4.1.0`、loader/include → `~1.1.0`；新增 `dsh-tool-executor-native` / `-ptc` |
| `pnpm-lock.yaml` | 随安装更新 |
| `pnpm-workspace.yaml` | pnpm 自动追加 5 条 `minimumReleaseAgeExclude`（新装包） |
| `test/package-contract.test.mjs` | `DEV_BASELINE` → `0.2.2-rc.3`、cordis/loader dev 基线随宿主代际；注释同步 |
| `test/tool-search-rc22-host.test.mjs` | guard 夹具取 `.reason` |
| `scripts/host-matrix.mjs` | 新增 `0.2.2-rc.3` 预设；修正"executor 不进 devDeps"的注释（现在进了） |
| `.github/workflows/ci.yml` | 现代腿 `0.2.2-rc.1` → `0.2.2-rc.3` |
| `README.md` / `README.en.md` | 已验证版本列表补 rc.3 |
| `docs/installation.md` / `.en.md` | 同上 |
| `docs/design.md` / `.en.md` | "当前准入组合"改为 rc.3 |

**未改**：`COMPAT_WINDOW`（仍是 `>=0.2.1-rc.5 <0.3.0`）、`engines.dsh`、任何 `lib/` 代码。
0.2.1 仍是受支持的低位，由 CI 的 legacy 腿继续覆盖。

## 5. 结果

```
tests 1059 · pass 1026 · fail 0 · skipped 33 · duration 16.4s
contract:check  ✔ 56 methods
client:check    ✔ 10 shards / 8054 lines
```

33 个 skip 全部是 legacy 宿主专属用例（现代夹具里按能力跳过，不是失败）。

## 6. 复跑

```powershell
cd .worktrees/compat-0.2.2-rc.3
pnpm install --no-frozen-lockfile
npm test
npm run contract:check
npm run client:check
```

## 7. 未做

- 真机 GUI 点验（桌面版已是 rc.3，可在面板里过一遍 MCP 启停 / ToolSearch / 技能）；
- 合并到 main（`d14cfc2` 已在 `compat/dsh-0.2.2-rc.3`，等与功能线一起合）。
