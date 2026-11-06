# Unified Tool Loading Execution Spec

**Goal:** 为 DSH 内置与 MCP 工具提供统一的加载策略：开箱即用、逐工具及项目覆盖、协议入口保护、Native/PTC 一致，并修复已复现的正确性缺陷。

**Decisions:**

- 用户在 2026-11-01 确认上一轮完整方案并授权记录、实施；执行位置选择独立 worktree。
- 推荐 / 全部常驻为两种运行选择。自定义是覆盖配置，不是第三套模式。切换全部常驻不删除覆盖。
- 三态设置为 inherit / resident / deferred；inherit 通过删除覆盖表达。工具禁用和加载策略独立。
- 优先级：项目逐工具 > 全局逐工具 > 项目组 > 全局组 > 既有 defer > 方案默认。
- 宿主权限先裁定可见工具；加载策略不得扩大权限。搜索入口、PTC run_code 不得由本插件隐藏。
- 非 MCP 工具默认常驻：宿主没有公开来源（provenance）接口，猜错会藏掉第三方插件的日常工具。
- 全局配置写 profile 的 `config.toolLoading`；项目策略写 `.dsh/mcp.json` 的 `toolLoading`。
- 既有 `defer` 保留作用；没有统一策略配置的老安装维持既有行为，显式应用推荐后切入。
- 保存采用严格 schema；比较当前配置、写盘和更新运行时在同一个串行操作内完成。
- 搜索一次返回的全部工具在未被调用前受保护；MCP instructions 永不遮罩。

**Constraints:**

1. 不修改宿主包、用户真实 profile、工作区 MCP、凭据；不提交、不推送、不发布、不自动合并。
2. 保持 DSH 0.2.0 / 0.2.1 支持窗口，开发依赖基线 0.2.1-rc.5；不为 0.1.x 加分支。
3. 沿用宿主 tools.schemas/get/guard、system-prompt/assemble、session projections、作用域和 PTC renderer；不创建 dispatcher。
4. 原生 deferLoading 受 provider toolUpdate 限制，不能代替跨模型 assembly 遮罩。
5. 来源无公共 provenance API：不能把所有非 `mcp__` 工具标成内置；无法证明身份时默认原样保留。
6. PTC 不强制变为 native；run_code 是 transport，搜索入口保留在 SDK 中。
7. 项目作用域按当前 agent/session cwd 解析，其他项目的同名 server 策略不得参与。
8. 策略和实际状态分离；env off、全部常驻、保护、未知、未匹配、待搜索、已加载必须可解释。
9. 后端测试超时 60 秒；先回归红、再实现绿。
10. 用户当前的 GUI 需认证；不得绕过，无法验证时如实披露。

**Non-goals:** embeddings；模型自动学习偏好；正则/脚本规则语言；权限管理；修改连接生命周期；跨会话共享加载集；版本发布与自动迁移用户配置。

**Architecture:**

纯策略计算与宿主适配分离。策略从已允许的工具集合、可信身份/作用域和全局/项目稀疏配置生成统一结果，供目录、搜索、guard、native/PTC 和管理视图共同使用。宿主负责注册、权限、执行、会话事件和 renderer；插件只提供加载策略、发现与配置管理。

## Native capability boundary (verified against installed rc.5)

| 能力 | 宿主提供 | 插件职责 / 不支持时处理 |
|---|---|---|
| 枚举 | tools.schemas(agent) 统一投影可见工具 | 不从全局枚举扩大 agent 权限 |
| 过滤 | system-prompt/assemble 结果为准 | 统一裁声明；PTC 用宿主 renderer 裁 SDK |
| 执行 | tools.guard 单调拒绝 + 原 dispatcher | 只拒绝未加载的受管工具 |
| 原生延迟 | deferLoading / toolUpdate（依赖 route） | 不赌 provider 支持；沿用 assembly 遮罩 |
| 来源 | 无公开 builtin/provenance 字段 | 未知原样保留，不猜 |
| 协议入口 | reserved run_code；scope-own structured output 不受 restrict | 默认豁免动态/未知 |
| 热更新 | 每 step 重新组装 | 下一模型请求生效，不重连 |
| 恢复 | sessionProjections + deriveMessages | 沿用既有 per-agent 加载集 |

**Final validation:**

- 已复现缺陷均有入库回归：混合批次、并发搜索、作用域同名、instructions 保留、并发保存、RPC 错误形状。
- 策略矩阵覆盖默认/组/逐工具/项目覆盖、模式切换不丢覆盖、入口保护。
- 真 cordis + tools + system-prompt 集成验证 native/PTC、恢复与热变。
- 真 loader + 临时 profile 验证持久化往返与三边契约；非法输入逐字节不改文件。
- 完整 `node --test --test-timeout=60000` 全绿；审查 diff 并披露未验证项。
