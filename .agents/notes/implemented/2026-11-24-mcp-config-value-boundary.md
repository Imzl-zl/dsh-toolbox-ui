# 配置值分清 read model、编辑引用与运行值

Status: implemented

## Problem

[#15](https://github.com/Imzl-zl/dsh-toolbox-ui/issues/15) 的表达式对象进入 React、搜索和表单，证明此前 raw/YAML 与文本消费方的边界缺失。只有把对象 stringify 或对所有字段强转，会继续把数字/布尔误读为实际值、把显示文本写回，或扩大隐私和求值范围。

## Decision

在[共享字段表](../../../lib/mcp-value-schema.js)定义类型、归属和隐私策略；[读投影](../../../lib/mcp-projection.js)只给 literal 或明确 expression/invalid 的 read model，不求值。[更新边界](../../../lib/mcp-update-values.js)在各自当前锁内的源条目建立根/叶保留授权，并在[原节点写入](../../../lib/mcp-config.js)复用目标自身节点。保留既有值不是对新输入 JS 的授权。

客户端将保留状态与新输入分开：取消保留不是提供了默认替换值；未改 literal 也引用原来源，缺省不被物化。字段来源与实际可编辑性分开回显。旧无绑定 restore 规则删除，不留下双重恢复实现。

## Alternatives considered

- 四处 asDisplayText/String/JSON.stringify 改动最小、能止住 React 错误；却会把异常对象变成合法文本，且不能保护源标签、字段类型和未改保存，故拒绝。
- 用 interpolate 展示真实值最贴近运行状态；但会在列表轮询时执行表达式、泄漏或重算，故运行值仅保留在显式授权 reveal 通路。
- 编辑时全面放开任意 JS 让旧字段容易写回；却混淆已有节点与新输入权限，故用当前条目原字段引用，不放开新增/导入准入。
- 只保留表达式可缩小改动；但普通未改字段与缺省量也会被视图重建覆盖，故加实际 dirty tracking，不把界面默认量当原值。

## Consequences

共享类型/隐私与原值引用消除了平行透传和恢复源；当前 supported Node/Host 下的原型键、别名、权限、标签/注释、掩码和默认值均有回归。源码测试通过不等于所有 UI/宿主版本已验证，矩阵与真实 GUI 必须分别记录。

代价是新增稀疏字段元数据和明确保留操作；未知形态会被诊断并限制编辑，不能用静默 fallback 伪装兼容。全局既有表达式保留不扩成项目任意语法。未来新增字段需进入同一 schema，并同时验证 read/update/写回，不再复制字段名单。
