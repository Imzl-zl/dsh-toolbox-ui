# 扩展中心 UI 验证记录

Date: 2026-11-05
Branch: feature/unified-tool-loading
Preview: http://127.0.0.1:19791/
Scope: MCP、技能、非 MCP 工具、两个市场、共享弹窗、浮动入口；未提交、未推送、未发布。

## 设计与实现

选择紧凑工作台（布局实验度 3 / 动效 2 / 密度 7）：同一标题栏与能力导航；MCP/技能列表与详情各自滚动；工具页参数/统计/筛选/保存固定，只有卡片列表滚动。颜色与几何消费 DSH 主题令牌。

- MCP 项目页用“项目 MCP / 全局共享”来源页签，共用一张左栏，去掉嵌套卡和详情遮挡浮层。空项目提供添加与市场入口。
- 切 scope 立即清数据与选择、递增 loadSeq；新请求只从 effect 发。删除 switchScope 内捕获旧 scope 的 load(false) 与无效闭包比较。
- 技能停用行只出现一次；scope/query/status 共同决定列表与详情；安装摘要/默认目标/写入从同一个目标对象派生。
- 工具参数先校验后写。一个保存按钮调用各自 RPC；成功项各自更新基线。放弃修改同时恢复两部分。
- 下划线详情导航、精简列表传输标签、排序菜单向上、正文单一滚动区。
- 共享 Dialog 固定标题/关闭/操作栏，正文滚动；Escape 只关当前弹窗，Tab 约束与焦点恢复。
- 市场搜索/安装目标窄屏换行，卡片不会超过容器；FAB CSS/JS 尺寸统一 48px。

## 自动化

最终完整命令（PowerShell）：

```powershell
$env:HOME = $env:USERPROFILE
node --test --test-timeout=60000
```

结果：895 tests，895 pass，0 fail。原始输出：final-full-test.log。HOME 仅为该测试进程环境设置；没有改动用户环境或平台测试断言。

`node --check lib/client.js` 与 `git diff --check` 通过。没有 package build 步骤（浏览器入口为出货的 lib/client.js）。

回归覆盖：

- 工具列表属于真滚动区、参数在统计上方、参数无效时任一写入都不触发、参数放弃恢复。
- scope global→empty workspace / workspace→empty global；旧响应在切换 effect 前、目标返回后均不可写回；persistent ref/effect cleanup 的 Hook renderer 替代旧永久 pending 绕过。移除 loadSeq、清空列表、响应判旧的 mutation 均会使双向用例失败。
- 技能停用不重复、筛选不泄露其他 scope、详情不留隐藏选中项、安装目标与实际 payload 一致。

## Chrome 实例验证

真实入口为上述 19791，使用其启动时打印的认证 URL。未访问 API 绕过 UI；未在浏览器执行安装/删除/保存用户配置。

桌面 viewport 1468×880（DPR 1.5）：

| 场景 | 实测 |
| --- | --- |
| MCP 左列表滚动 | clientHeight 460 / scrollHeight 1036；scrollTop 到 576，筛选栏和详情 Y 坐标不变 |
| 底栏排序 | 向上菜单高 112px；边界完整位于侧栏内，可见 |
| 空项目 | zhanggui 为 0 行、无全局详情；连续三次全局→项目，下一帧均 0 行且 detail=null |
| 全局共享 | 左栏 15 行，右侧显示 exa，详情覆盖浮层不存在 |
| 工具页 | 34 卡片；list 437px / content 1654px，滚到底 max≈1217；参数和保存 Y 不变；参数在统计上方 |
| 技能 | 40 行；滚到底 max≈1783，详情位置不变；筛选公众号变为 12 行，底栏 12，详情 aihot |
| 技能市场 | 初页去重后 79 条 / total 219094，滚动视图 656px / 4831px；toolbar Y 不变 |
| 安装弹窗 | body 642px / 1618px，scrollTop 976；标题/操作栏固定，焦点在弹窗内，确认未勾选时安装禁用 |
| Console | 操作后 error/warn 列表为空 |

窄屏 viewport 390×844：

| 场景 | 实测 |
| --- | --- |
| 市场 | panel 370px / scrollWidth 370；market 338px / scrollWidth 338；卡片 336px |
| 工具 | 单列 336px；list 高 278px / content 3709px，滚到底≈3432；参数/保存不动且保存可见 |
| MCP 市场 | market 338px / scrollWidth 338；无超出 panel 的普通元素 |
| 添加弹窗 | width=scrollWidth=366px，top≈50.6/bottom≈793.4；滚正文247px，标题/操作栏不动，焦点在框内 |

截图：ui-tools-final.jpeg、ui-project-final.jpeg、ui-market-mobile.jpeg、ui-tools-mobile.jpeg。浏览器已恢复桌面 viewport。

## 部署与边界

- 只将最终浏览器 bundle 复制到授权 web profile 的 dsh-toolbox-ui/lib/client.js，SHA-256 与工作树一致；刷新同一 19791 URL 后确认实际脚本和样式包含新的来源导航。
- 没有改宿主 shell、替换服务器或改真实 MCP/技能配置；19791 使用受管理后台任务保持运行。
- 本轮 UI 保存仍是两个 RPC，不是原子事务。已成功项更新基线，后项失败显示错误；全有或全无需要未来宿主事务接口。
- GUI 验证覆盖浏览、切换、滚动、打开/取消弹窗；安装、删除、保存的真实用户写入未执行，写路径由自动化真实宿主/临时目录测试覆盖。

## 复盘

此前“测试绿即 UI 完成”的判断缺了 DOM 滚动和作用域切换证据；旧 React 替身也无 persistent refs/effect 语义，永久 pending 分支掩盖真实旧请求。此轮用真实页面测量与可控双向响应回归闭环。

旧 2026-11-04 工具 UI 笔记里全角冒号截断、一次 RPC、截图不可用、固定首屏行数等结论已由新决定说明纠正；旧篇标记被取代后归档冻结。
