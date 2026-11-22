# Agent Note: 用途线索取自任意当前库存，不匹配工具身份或版本

Status: implemented

## Problem

用户明确要求面向任意用户的 MCP 库存，不能围绕已知服务或工具拟合。前轮使用隔离本地合成 MCP、未调用或配置用户真实 MCP；但局部样例验证不能证明通用效果。前一版的五项名称+完整描述哈希表及已知优先级仍是版本特例，因此被取代。原试验归档仅在本地保留，不随公开源码提交。

## Decision

[唯一用途生成入口](<../../../lib/tool-discovery-cues.js>)删除身份哈希、人工用途表、known-name优先及其排序；不看特定工具、server、版本、kind或UI分类来解释能力。

- 只读取本 agent/step 实际 catalog 的 description；首非空段归一空白后<=160字符则逐字引用完整段，长段则取标准 Intl.Segmenter('und', sentence) 的首候选。只有<=240字符且带 Unicode Sentence_Terminal及闭括号/引号的候选才完整引用，不取后来句，不裁字，不做语义摘要。
- 整个 cue 保持800 UTF16字符，包括标题和JSON转义整行，装不下只省略整项；缩短已由runtime guidance承担的重复引导。名称仅用于实际lookup和输出标签，不是purpose门槛。
- MCP仍按实际非空instructions去重，无说明每owner至多1条、全体至多3条，仍受整段预算；所有名字、完整描述索引与原schema按需加载保留。是否有说明不是说明质量判断，也不承诺每个owner必有例子。
- [runtime](<../../../lib/tool-search-runtime.js>)未改：同scope/step快照、原发现/恢复及定义和instructions内容缓存保留；[presentation](<../../../lib/tool-search-presentation.js>)的native/PTC和字面量边界不变。功能修订不变更检索算法/query/default策略/权限或用户profile；发布操作另按仓库流程执行。
- 泛化证据来自改名/换owner/换序/未知描述/中英日文/描述更新及1/30/300库存的本地元变形约束，不以已知MCP样例成功率作为准入规则。旧623字符与真实8对模型成绩保留为历史，不计入新实现效果。

## Alternatives considered

- 保留来源哈希人工用途：最强理由是审核摘要更短且可保留关键分工；但需逐版本维护、同语义改名也会失去入口，不符合通用要求，故删除而非增加别名。
- 所有用户完整描述常驻：最强理由是无摘要来源分支且信息完整；但用户已否定无足够质量收益的完整首段膨胀。本批保留有限的元数据引用和全部按需契约。
- 名字或缩写词典、自动语义摘要：最强理由是可提供更精炼的目的并修复Dr.等分句；但新增身份/语言维护表或模型依赖，不能从单一库存证明收益。不为隐藏ICU限制重加特例。
- 完全只有名字：最强理由是固定上下文最少、原检索仍能读完整description；但仍缺搜索前的未知用途入口，因此保留统一文本引用而不回退全部names-only。

## Consequences

- 收益：任何未见工具名/owner/描述版本无需加入白名单或配置即可走同一规则；预算足够的改名库存用途等价、首句等长改义更新、生效scope与完整索引/schema均经独立回归验证。旧五种真实说明按此通用规则仍能显示五项，正文788字符；这是样例结构数，不是全用户预算效果或token收益。
- 代价：ICU只提供文本边界，不理解purpose；例如Dr. Adams可以误分成Dr.。首句引用不保证完整语义或后文限定；160/240与800、长标签和有限MCP例可能漏显，且没有任何固定核心优先保证。未示不能推断不可用，模型仍应搜索完整schema。
- 信任边界：description只是当前发布方声明；JSON字面量和interpolate:false不是语义注入安全或权限证明。真实调用契约和用户限制仍是原schema/guard的责任。
- 验证边界：[独立通用回归](<../../../test/tool-discovery-generic-hints.test.mjs>)与[真实宿主回归](<../../../test/tool-search-capability-cues.test.mjs>)所在本批取得同68项正确RED/冻结独立GREEN；本地全量1251测试/1218pass/33原legacy skip/0fail，57 RPC与11分片9625行client只读check。原始实验日志仅在本地保留，发布前验证另行执行。本批无新增模型请求或用户MCP连接，不能宣称泛化模型任务质量/工具采纳率提高。
