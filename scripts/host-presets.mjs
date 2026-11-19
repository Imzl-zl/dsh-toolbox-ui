// 宿主矩阵的腿清单——**唯一**的一份。
//
// 为什么单独成模块：这份表原本写在 `scripts/host-matrix.mjs` 的模块顶层，而那个文件被 import
// 就会真的跑一遍安装（顶层有副作用），所以用例读不到它；`.github/workflows/ci.yml` 于是手抄了
// 一份宿主列表和每腿的 cordis/loader/include，两处漏一处的结果是**少跑一腿而 CI 依旧全绿**。
// 搬到无副作用的模块后：
//   · `scripts/host-matrix.mjs` 从这里取每腿的 cordis / loader / include / stepToolset；
//   · `test/package-contract.test.mjs` 断言 ci.yml 的 matrix 与本表的键一一对应。
// 新增宿主版本时改**两处**：这里加一条，ci.yml 的 matrix 加一行（用例会拦住只改一处）。
//
// 字段含义：
//   cordis / loader / include —— 该腿按目标宿主自己声明的 `dependencies` 换掉这三代
//     （宿主破坏性大多不在 dsh-* 的 API 面上，而在 cordis / loader 的重构里，见
//     docs/design.md §版本范围）；
//   stepToolset —— 该代宿主是否已有 step-owned toolSet（`1`）还是 0.2.1 的兼容形态（`0`）。
//     矩阵腿用它给 `DSH_EXPECT_STEP_TOOLSET`，用例在**加载期**断言跑到的确实是目标那一代，
//     不靠 skip 把另一代跳过去。
export const HOSTS = {
  '0.2.1-rc.5': { cordis: '~4.0.5', loader: '~1.0.6', include: '1.0.10', stepToolset: '0' },
  '0.2.2-rc.3': { cordis: '~4.1.0', loader: '~1.1.0', include: '~1.1.0', stepToolset: '1' },
  '0.2.2-rc.5': { cordis: '~4.1.0', loader: '~1.1.0', include: '~1.1.0', stepToolset: '1' },
}
