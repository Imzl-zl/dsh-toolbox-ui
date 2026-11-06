/* 主题令牌别名层。DSH 的 ui-theme 拥有全部颜色、几何与字体：插件只消费语义令牌，
   不写死色值、不写局部圆角数值（docs/web-styling.md：「Use --dsw-alias-* semantic
   tokens in feature components. Do not copy static palette values or write literal
   colors there.」）。要用的令牌在这里一次性收成 --mcp-* 别名，后面的规则只引用别名——
   换主题、调刻度都只改这一处。

   挂在 body 而不是 .dsh-mcp-wrap 上：本插件有三个互不相邻的 slot 子树
   （shell.overlay 的悬浮按钮、sidebar.footer.action 的侧栏入口、面板自己），它们
   没有公共祖先，别名必须定义在共同祖先上。

   也不能挂在 :root：ui-theme 把全部 --dsw-alias-* 定义在 **body** 上
   （design-platform.css 的 `body{}` 与 `body[data-ds-dark-theme]{}`），而 :root 是 body
   的祖先——自定义属性在声明处就完成替换，在 :root 上写 `var(--dsw-alias-*)` 会取到空值，
   整片别名失效（实测卡片与面板背景变透明）。

   两点容易踩：
   - 几何走 --dsw-radius-*（docs/ui-radius.md 的分级），不写字面数值。官方 spec 把
     「>4px 且 <99px 的字面圆角」判为违规，≤4px 才算绘图细节。
   - 等宽字体是 --ds-font-family-code（ui-theme/src/styles/base.css 的 :root 里定义的就是
     它，官方 51 处用它）。别用 --dsw-font-mono：那个名字全仓没有定义，只是个约定俗成的
     引用目标，用上它等于永远命中 fallback，等宽字形跟宿主代码块对不上。 */
const MCP_CSS = `body{--mcp-accent:var(--dsw-alias-brand-primary);--mcp-ok:var(--dsw-alias-state-success-primary);--mcp-err:var(--dsw-alias-state-error-primary);--mcp-warn:var(--dsw-alias-state-warn-primary);--mcp-info:var(--dsw-alias-state-business-primary);--mcp-mut:var(--dsw-alias-label-secondary);--mcp-bg-1:var(--dsw-alias-bg-layer-1);--mcp-bg-2:var(--dsw-alias-bg-layer-2);--mcp-bg-3:var(--dsw-alias-bg-layer-3);--mcp-line:var(--dsw-alias-border-l2);--mcp-mono:var(--ds-font-family-code,ui-monospace,SFMono-Regular,Menlo,monospace);--mcp-r-xs:var(--dsw-radius-xs);--mcp-r-sm:var(--dsw-radius-sm);--mcp-r-md:var(--dsw-radius-md);--mcp-r-lg:var(--dsw-radius-lg);--mcp-r-xl:var(--dsw-radius-xl);--mcp-r-panel:var(--dsw-radius-panel)}
.dsh-mcp-wrap,.dsh-mcp-panel-overlay,.dsh-mcp-overlay,.dsh-mcp-fab,.dsh-mcp-footer-action,.dsh-mcp-toast{color:var(--dsw-alias-label-primary);font-family:var(--dsw-font-family,inherit)}
.dsh-mcp-wrap{box-sizing:border-box;display:flex;flex-direction:column;height:100%;min-height:0;gap:16px;padding:0;font-size:12.5px;-webkit-font-smoothing:antialiased}
.dsh-mcp-wrap ::-webkit-scrollbar{width:8px;height:8px}
.dsh-mcp-wrap ::-webkit-scrollbar-thumb{background:var(--dsw-alias-scrollbar-bg-l2);border-radius:999px;corner-shape:round;border:2px solid transparent;background-clip:padding-box}
.dsh-mcp-wrap ::-webkit-scrollbar-thumb:hover{background:var(--dsw-alias-scrollbar-hover-l2);border:2px solid transparent;background-clip:padding-box}
.dsh-mcp-wrap ::-webkit-scrollbar-track{background:transparent}
/* 标题栏四列钉死：标题 | 能力层 | 操作区（占满剩余，**内容右对齐**）| 关闭。
   原型就是这样排的：能力层贴着标题在左，功能按钮贴右，中间那列吃掉空白。
   曾经两个错法各来过一次：
     · flex + space-between：关闭跟着操作区宽度走，MCP 面 6 个按钮、技能面 1 个，
       一切面「关闭」横移几百像素（用户原话：「切换之后这个位置来回换位置」）；
     · 能力层与按钮组塞进同一列且左对齐：整排按钮挤在标题旁边，中间空一大块，
       与原型明显不同（用户第二次指出：「顶部这个你不还是在左边」）。
   现在四列各自锚定：切面只让第三列的内容变化，关闭永远在第四列。 */
.dsh-mcp-head{flex:none;display:grid;grid-template-columns:auto auto minmax(0,1fr) auto;align-items:center;gap:12px}
.dsh-mcp-title{flex:none;white-space:nowrap;font-size:15px;font-weight:600;line-height:1.35;letter-spacing:.1px;display:flex;align-items:center;gap:8px}
.dsh-mcp-title::before{content:"";width:3px;height:14px;border-radius:1.5px;background:var(--mcp-accent)}
.dsh-mcp-head-actions{display:flex;gap:8px;flex-wrap:wrap;justify-content:flex-end;min-width:0}
/* 按钮高度统一：32px 主按钮、28px 次按钮/图标按钮。原 30px 图标按钮与 7/13px 主按钮
   混排，同一行里永远对不齐——这是「不优雅」最显眼的来源。 */
.dsh-mcp-btn{display:inline-flex;align-items:center;justify-content:center;gap:6px;border:1px solid var(--mcp-line);border-radius:var(--mcp-r-sm);padding:0 12px;height:32px;background:var(--dsw-alias-button-elevated-fill);color:var(--dsw-alias-label-primary);font-size:12.5px;font-weight:500;white-space:nowrap;cursor:pointer;transition:background .1s,border-color .1s}
.dsh-mcp-btn:hover{background:var(--dsw-alias-interactive-bg-hover);border-color:var(--dsw-alias-border-l3)}
.dsh-mcp-btn:active{background:var(--dsw-alias-interactive-bg-active)}
.dsh-mcp-btn:disabled{opacity:.4;cursor:not-allowed;transform:none;box-shadow:none}
.dsh-mcp-btn.primary{background:var(--dsw-alias-button-primary-fill);border-color:transparent;color:var(--dsw-alias-label-primary-inverted)}
.dsh-mcp-btn.primary:hover{background:var(--dsw-alias-button-primary-hover)}
.dsh-mcp-btn.danger{color:var(--dsw-alias-state-error-primary);border-color:var(--dsw-alias-state-error-primary)}
.dsh-mcp-btn.danger:hover{background:var(--dsw-alias-interactive-bg-hover-danger);border-color:var(--dsw-alias-state-error-primary)}
/* 尺寸/形态修饰。放在 .dsh-mcp-btn 之后、且都是 (0,2,0)：与基础规则冲突的那些属性
   （padding / border-color / background）在这里一次性定死，别在别处再补一条同名的。 */
.dsh-mcp-btn.icon{width:28px;height:28px;padding:0}
.dsh-mcp-btn.sm{padding:0 8px;height:28px;font-size:11px}
.dsh-mcp-btn.ghost{border-color:transparent;background:transparent}
.dsh-mcp-btn.ghost:hover{background:var(--dsw-alias-interactive-bg-hover);border-color:transparent}
.dsh-mcp-btn.sel{background:var(--dsw-alias-interactive-bg-hover-accent);border-color:var(--mcp-accent);color:var(--dsw-alias-label-primary)}

/* 分段控件：浅槽 + 选中项填实。能力层与模式层共用同一个控件、同一套尺寸——
   「切换管哪个能力」和「切换看到哪一面」是同一类决定，长得一样才不用重新学。
   它压过 .dsh-mcp-btn 的边框/内边距，特异性 (0,2,0)，位置在此之后。 */
/* 分段控件：32px 高，与主按钮同高，同一行里不再一高一矮。 */
.dsh-mcp-seg{display:inline-flex;gap:2px;padding:2px;flex:none;border-radius:var(--mcp-r-md);background:var(--mcp-bg-2)}
.dsh-mcp-seg .dsh-mcp-btn{border-color:transparent;background:transparent;padding:0 12px;height:28px;font-size:12.5px;border-radius:var(--mcp-r-sm)}
.dsh-mcp-seg .dsh-mcp-btn:hover{background:var(--dsw-alias-interactive-bg-hover)}
.dsh-mcp-seg .dsh-mcp-btn.sel{background:var(--dsw-alias-button-primary-fill);color:var(--dsw-alias-label-primary-inverted);font-weight:600}
.dsh-mcp-seg-count{font-size:10px;font-weight:500;padding:0 4px;border-radius:999px;corner-shape:round;background:var(--dsw-alias-interactive-bg-hover);color:var(--mcp-mut);line-height:14px}
.dsh-mcp-seg .dsh-mcp-btn.sel .dsh-mcp-seg-count{background:var(--dsw-alias-interactive-bg-hover-accent);color:var(--dsw-alias-label-primary-inverted)}

/* ── 第二行：模式分段 | 作用域药丸 | 连接状态 ─────────────────────────────
   两个能力面共用这一条、共用这个三列节奏（与标题栏同款 grid）。
   三列钉死还有一个理由：右侧那句状态的长短会变（「宿主已连接」↔「skills 服务未就绪」），
   不钉死它就会推着中间的药丸左右晃——这正是标题栏关闭按钮当初漂移的同一个成因。 */
/* 第二行统一 32px 高：模式分段、作用域药丸、连接状态在同一水平线上。 */
.dsh-mcp-sub{display:grid;grid-template-columns:auto minmax(0,1fr) auto;align-items:center;gap:12px;flex:none;height:32px}
.dsh-mcp-sub-scope{min-width:0;display:flex;align-items:center}
/* ⚠️ 作用域条必须**吃掉中间那一列的剩余宽度**。
   .dsh-mcp-tabs-wrap 自己是 flex:none（它原来是 .dsh-mcp-wrap 这个**列**容器的直接子元素，
   靠 stretch 拿满宽度）。搬进第二行的 grid 之后，中间那列是 minmax(0,1fr)、而它在这个
   flex 行里 flex:none → 收缩到内容宽度，里面的 .dsh-mcp-tabs 的 clientWidth 于是只剩 47px，
   真机上整条只剩一个「…8」按钮（点得到、但作用域一个都看不见）。
   这条是位置与归属变更带来的回归，只有真机 getComputedStyle/clientWidth 看得见。
   （本注释里原本用反引号包了类名——那直接把 MCP_CSS 这个模板字符串**提前截断**了，
     后面的 CSS 全被当成 JS 解析，真机表现是「插件加载失败：mcp is not defined」。
     有 test/panel-css-invariants 的用例守着：样式常量正文里不得出现反引号。） */
.dsh-mcp-sub-scope .dsh-mcp-tabs-wrap{flex:1 1 auto;min-width:0}
.dsh-mcp-runtime{display:inline-flex;align-items:center;gap:5px;flex:none;white-space:nowrap;font-size:11.5px;color:var(--dsw-alias-label-tertiary)}
.dsh-mcp-runtime svg{color:var(--mcp-ok)}
.dsh-mcp-runtime.err{color:var(--mcp-err)}
.dsh-mcp-runtime.err svg{color:var(--mcp-err)}

/* ── 列表底栏：统计文本 + 排序/刷新图标组 ────────────────────────────────
   原型的「批量」要一个多选启停的 Host RPC，这一版不做——画一个点了没反应的按钮更糟。 */
.dsh-mcp-side-foot{flex:none;display:flex;align-items:center;gap:6px;border-top:1px solid var(--mcp-line);padding-top:8px;font-size:11px;color:var(--dsw-alias-label-tertiary)}
.dsh-mcp-foot-text{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-variant-numeric:tabular-nums}
.dsh-mcp-foot-spacer{flex:1}
.dsh-mcp-foot-btn{box-sizing:border-box;width:24px;height:24px;flex:none;padding:0;display:inline-flex;align-items:center;justify-content:center;border:1px solid transparent;border-radius:var(--mcp-r-sm);background:transparent;color:var(--dsw-alias-label-tertiary);cursor:pointer;transition:background .12s,color .12s}
.dsh-mcp-foot-btn:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}
.dsh-mcp-foot-btn:disabled{opacity:.5;cursor:not-allowed}

/* 下拉菜单：「⋯ 更多」与底栏排序共用一个原语。 */
.dsh-mcp-dd{position:relative;display:inline-flex}
.dsh-mcp-dd-pop{position:absolute;top:calc(100% + 5px);right:0;z-index:60;display:flex;flex-direction:column;gap:2px;min-width:186px;padding:6px;border-radius:var(--mcp-r-lg);background:var(--mcp-bg-2);box-shadow:var(--dsw-elevation-panel)}
.dsh-mcp-dd-pop .dsh-mcp-btn{box-sizing:border-box;width:100%;justify-content:flex-start;border-color:transparent;background:transparent}
.dsh-mcp-dd-pop .dsh-mcp-btn:hover{background:var(--dsw-alias-interactive-bg-hover)}
.dsh-mcp-dd-pop .dsh-mcp-btn.sel{background:var(--dsw-alias-interactive-bg-hover-accent);border-color:transparent;color:var(--dsw-alias-label-primary);font-weight:600}
.dsh-mcp-dd-pop .dsh-mcp-btn.danger{color:var(--mcp-err)}
.dsh-mcp-dd-pop .dsh-mcp-btn.danger:hover{background:var(--dsw-alias-interactive-bg-hover-danger)}
.dsh-mcp-dd-sep{height:1px;margin:4px 2px;background:var(--mcp-line)}
/* 底栏的排序按钮在最左，弹层右对齐会跑出卡片外。 */
.dsh-mcp-foot-dd .dsh-mcp-btn.icon{width:24px;height:24px;border-color:transparent;background:transparent;color:var(--dsw-alias-label-tertiary)}
.dsh-mcp-foot-dd .dsh-mcp-btn.icon:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}
.dsh-mcp-foot-dd .dsh-mcp-dd-pop{top:auto;bottom:calc(100% + 8px);right:0;left:auto}
/* 详情操作栏的「⋯」：靠右，与主/次行为同高。 */
.dsh-mcp-d-more{flex:none}
.dsh-mcp-body{display:flex;gap:14px;flex:1;min-height:0}
.dsh-mcp-side{width:292px;min-width:248px;min-height:0;display:flex;flex-direction:column;gap:12px;border:1px solid var(--mcp-line);border-radius:var(--mcp-r-lg);background:var(--mcp-bg-2);padding:12px;overflow:hidden}
.dsh-mcp-side.embedded{width:auto;min-width:0;flex:1 1 auto;border:0;border-radius:0;background:transparent;padding:0;overflow:visible}
.dsh-mcp-search{position:relative;flex:none;min-width:0}
.dsh-mcp-search svg{position:absolute;left:10px;top:50%;transform:translateY(-50%);opacity:.5}
.dsh-mcp-search input{width:100%;box-sizing:border-box;padding:0 10px 0 30px;height:32px;border-radius:var(--mcp-r-md);border:1px solid var(--mcp-line);background:var(--mcp-bg-1);color:var(--dsw-alias-label-primary);font-size:12px;outline:none;transition:border-color .1s,box-shadow .1s}
.dsh-mcp-search input::placeholder{color:var(--mcp-mut)}
.dsh-mcp-search input:focus{border-color:var(--mcp-accent);box-shadow:none}
.dsh-mcp-list{flex:1 1 auto;min-height:52px;overflow-y:auto;display:flex;flex-direction:column;gap:4px;margin:0 -4px;padding:0 4px}
.dsh-mcp-item{position:relative;flex:none;display:flex;align-items:center;gap:10px;padding:12px;border-radius:var(--mcp-r-md);cursor:pointer;border:1px solid transparent;transition:background .1s,border-color .1s}
.dsh-mcp-item:hover{background:var(--dsw-alias-interactive-bg-hover);border-color:var(--dsw-alias-border-l2)}
.dsh-mcp-item.sel{background:var(--dsw-alias-interactive-bg-hover-accent);border-color:transparent}
.dsh-mcp-item.sel::before{content:"";position:absolute;left:-1px;top:20%;bottom:20%;width:2px;border-radius:1px;background:var(--mcp-accent)}
.dsh-mcp-dot{width:8px;height:8px;border-radius:50%;flex:none;background:var(--mcp-mut);box-shadow:none;corner-shape:round}
.dsh-mcp-dot.connected{background:var(--mcp-ok);box-shadow:0 0 4px color-mix(in srgb,var(--mcp-ok) 55%,transparent)}
.dsh-mcp-dot.failed{background:var(--mcp-err);box-shadow:0 0 6px color-mix(in srgb,var(--mcp-err) 55%,transparent)}
.dsh-mcp-dot.loading{background:var(--mcp-warn);animation:mcpBlink 1.1s infinite}
@keyframes mcpBlink{50%{opacity:.35}}
.dsh-mcp-item-main{flex:1;min-width:0;display:flex;flex-direction:column;gap:2px}
.dsh-mcp-item-name-row{display:flex;align-items:center;gap:7px;min-width:0}
.dsh-mcp-item-name{font-size:12.5px;font-weight:500;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;letter-spacing:.1px}
/* 状态文本是这一行里唯一会变长的东西：让它自己省略，别去挤芯片。 */
.dsh-mcp-item-meta{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dsh-mcp-item-sub{font-size:10.5px;color:var(--mcp-mut);display:flex;gap:6px;align-items:center;min-width:0;overflow:hidden;white-space:nowrap;flex-wrap:wrap;row-gap:4px}
/* 状态芯片**不收缩**：窄面板下让它自己换行，而不是把 "HTTP" 挤成半截、被后一个芯片盖住。 */
.dsh-mcp-item-sub>.dsh-mcp-chip{flex:none}
/* ⚠️ 子行必须有 min-width:0 + overflow:hidden：它在 flex 列里（.dsh-mcp-item-main 是
   flex:1;min-width:0），只要里面放进任何**不收缩**的长文本（真机踩过：一整条根路径），
   它就会撑破 185px 的单元格并**没有省略号地**硬裁——显示成半截字，看起来像渲染坏了。
   .dsh-mcp-item-name 早就有 ellipsis，子行此前漏了。 */
.dsh-mcp-item-sub>*{min-width:0;flex:0 1 auto;overflow:hidden;text-overflow:ellipsis}
.dsh-mcp-badge{display:inline-flex;align-items:center;padding:1.5px 7px;border-radius:999px;font-size:10.5px;font-weight:500;line-height:16px;border:1px solid var(--mcp-line);color:var(--mcp-mut);background:var(--mcp-bg-1);corner-shape:round}
.dsh-mcp-badge.dot::before{content:"";width:5px;height:5px;border-radius:50%;background:currentColor;margin-right:5px;opacity:.85;corner-shape:round}
.dsh-mcp-badge.t-http{color:var(--dsw-alias-label-primary);border-color:var(--dsw-alias-state-business-primary);background:var(--dsw-alias-state-business-tertiary)}
.dsh-mcp-badge.t-stdio{color:var(--dsw-alias-label-primary);border-color:var(--dsw-alias-state-warn-primary);background:var(--dsw-alias-state-warn-tertiary)}
.dsh-mcp-badge.s-on{color:var(--dsw-alias-label-primary);border-color:var(--dsw-alias-state-success-primary);background:var(--dsw-alias-state-success-tertiary)}
.dsh-mcp-badge.s-on.dot::before{background:var(--dsw-alias-state-success-primary)}
.dsh-mcp-badge.s-err.dot::before{background:var(--dsw-alias-state-error-primary)}
.dsh-mcp-badge.s-off{color:var(--mcp-mut);border-color:var(--mcp-line)}
.dsh-mcp-badge.s-err{color:var(--dsw-alias-label-primary);border-color:var(--dsw-alias-state-error-primary);background:var(--dsw-alias-interactive-bg-hover-danger)}
.dsh-mcp-badge.scope-ws{color:var(--mcp-accent);border-color:var(--mcp-accent);background:var(--dsw-alias-interactive-bg-hover-accent)}
.dsh-mcp-badge.t-defer{color:var(--mcp-accent);border-color:var(--mcp-accent);border-style:dashed;background:transparent}
/* 延迟开关芯片：直接复用「可点的药丸」原语（.dsh-mcp-chip，市场分类就是它）——用户在这块
   UI 里已经学会"药丸 = 可点"，所以它必须长得像药丸，而不是像状态徽标（.dsh-mcp-badge）。
   .sel = 已延迟（accent 边框 + accent 底），与市场里"选中的筛选项"同一套视觉。
   ⚠️ 这段是模板字符串：注释里**不能出现反引号**，否则会提前终止字符串（踩过，整份 CSS 变
   TypeError）。 */
.dsh-mcp-chip.sm{padding:2px 8px;font-size:10.5px;line-height:16px;gap:4px}
.dsh-mcp-chip.ro{cursor:default}
.dsh-mcp-chip.ro:hover{background:var(--mcp-bg-1);border-color:var(--mcp-line)}
.dsh-mcp-chip.ro.sel:hover{background:var(--dsw-alias-interactive-bg-hover-accent);border-color:var(--mcp-accent)}
.dsh-mcp-chip:focus-visible{outline:1px solid var(--mcp-accent);outline-offset:1px}
.dsh-mcp-detail{flex:1;min-width:0;min-height:0;display:flex;flex-direction:column;gap:12px;border:1px solid var(--mcp-line);border-radius:var(--mcp-r-lg);background:var(--mcp-bg-2);padding:16px;overflow:hidden}
/* 只有正文滚：头与 Tab 行 flex:none，操作栏不再随内容滑走。
   之前 .dsh-mcp-detail 自己 overflow-y:auto，头、操作按钮、Tab 与正文一起滚，
   卡片一多就「滚动一下按钮就没了」。 */
.dsh-mcp-d-body{flex:1;min-height:0;overflow-y:auto;display:flex;flex-direction:column;gap:10px;padding-right:2px}
/* 非当前页签的卡片直接不参与布局——用 visibility/height 会让正文区留下空洞。
   ⚠️ 选择器**必须**带 .dsh-mcp-detail 前缀。样式表里有两条 .dsh-mcp-card：后面那条
   （市场样式所在的长行）把它定义成 display:flex。单类选择器 .dsh-mcp-pane-off 与它
   同特异性、位置更靠前 → 被压掉，三个页签会同时显示。真机实测就是这样：
   computed display 是 flex，而类名明明挂着。
   这里用 (0,2,0) 压过任何单类规则，位置就不必再依赖先后。 */
.dsh-mcp-detail .dsh-mcp-pane-off{display:none}
.dsh-mcp-d-body>.dsh-mcp-card{flex:none}
.dsh-mcp-item-sub>.dsh-mcp-badge{border-color:transparent;background:transparent;padding-inline:0;color:var(--mcp-mut)}
.dsh-mcp-d-diag{display:flex;flex-direction:column;gap:8px}
.dsh-mcp-d-note{font-size:12px;line-height:18px;color:var(--mcp-mut)}
/* 空状态：图标方块 + 标题 + 一句说明，居中成块（原先是单行灰字，看不出「这里没有东西」
   和「这里加载失败」的区别）。 */
.dsh-mcp-d-empty{display:flex;flex:1;flex-direction:column;align-items:center;justify-content:center;text-align:center;color:var(--mcp-mut);font-size:13px;gap:4px;padding:24px 16px}
.dsh-mcp-d-empty>.dsh-mcp-d-actions{margin-top:14px;justify-content:center}
.dsh-mcp-d-empty b{font-size:13px;font-weight:600;color:var(--dsw-alias-label-primary)}
.dsh-mcp-d-empty span{font-size:11.5px;line-height:18px;color:var(--mcp-mut);max-width:320px}
.dsh-mcp-d-empty::before{content:"";width:26px;height:26px;border-radius:var(--mcp-r-md);background:var(--dsw-alias-interactive-bg-hover)}
.dsh-mcp-d-head{flex:none;display:flex;align-items:flex-start;justify-content:space-between;gap:10px}
/* 详情里的 Tab 行复用作用域那套 .dsh-mcp-tab 原语，但**必须换行而不是横滚**。
   作用域条用「横滚 + ⋯ 弹层」是因为它的条目数不可控；详情页签固定三项、且窄屏下
   横滚条的滚动条是隐藏的——实测 390px 视口下 scrollWidth 431 > clientWidth 309，
   「诊断」会静默跑到屏幕外且没有任何提示。换行则三项永远都在。 */
.dsh-mcp-detail>.dsh-mcp-tabs{flex:none;gap:20px;flex-wrap:wrap;overflow:visible;border-bottom:1px solid var(--mcp-line);padding:0}
.dsh-mcp-detail>.dsh-mcp-tabs>.dsh-mcp-tab{border:0;border-bottom:2px solid transparent;border-radius:0;background:transparent;padding:8px 0 10px}
.dsh-mcp-detail>.dsh-mcp-tabs>.dsh-mcp-tab.sel{border-bottom-color:var(--mcp-accent);background:transparent}
.dsh-mcp-d-name{font-size:17px;font-weight:600;line-height:1.3;letter-spacing:.1px;display:flex;align-items:center;gap:8px;min-width:0;overflow-wrap:anywhere}
.dsh-mcp-d-meta{display:flex;gap:6px;align-items:center;margin-top:6px;flex-wrap:wrap}
.dsh-mcp-d-actions{display:flex;gap:10px;flex-wrap:wrap;align-items:center}
.dsh-mcp-d-scope-hint{font-size:11.5px;color:var(--mcp-mut)}
.dsh-mcp-d-desc{margin:6px 0 0;font-size:12px;line-height:1.6;color:var(--mcp-mut);max-width:72ch;max-height:3.2em;overflow:hidden}
.dsh-mcp-d-description{font-size:12px;line-height:1.65;color:var(--mcp-mut);white-space:pre-wrap;overflow-wrap:anywhere}
/* 头部左侧标题列：占满 d-head 减掉操作列之后的宽度，长名字换行而不是把按钮挤下去。 */
.dsh-mcp-d-title{flex:1;min-width:0}
.dsh-mcp-card{border:1px solid var(--mcp-line);border-radius:var(--mcp-r-lg);padding:16px;background:var(--mcp-bg-1)}
.dsh-mcp-card h4{margin:0 0 10px;font-size:11px;font-weight:600;color:var(--mcp-mut);letter-spacing:.2px;display:flex;align-items:center;gap:6px}
.dsh-mcp-card h4::after{content:"";flex:1;height:1px;background:var(--mcp-line);margin-left:2px}
.dsh-mcp-kv{display:grid;grid-template-columns:auto minmax(0,1fr);gap:5px 14px;font-size:12px;word-break:break-all}
.dsh-mcp-kv>*{min-width:0}
.dsh-mcp-kv b{color:var(--mcp-mut);font-weight:500;white-space:normal;overflow-wrap:anywhere}
.dsh-mcp-tools{display:flex;flex-direction:column;gap:5px}
.dsh-mcp-tool{display:flex;gap:9px;padding:7px 9px;border-radius:var(--mcp-r-sm);background:var(--mcp-bg-1);border:1px solid transparent;transition:background .12s,border-color .12s}
.dsh-mcp-tool:hover{border-color:var(--mcp-line);background:var(--dsw-alias-interactive-bg-hover)}
.dsh-mcp-tool-name{font-family:var(--mcp-mono);font-size:11.5px;color:var(--dsw-alias-brand-text);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:46%}
.dsh-mcp-tool-desc{font-size:11.5px;color:var(--mcp-mut);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dsh-mcp-empty-list{display:flex;align-items:center;justify-content:center;min-height:120px;padding:24px 16px;text-align:center;color:var(--mcp-mut);font-size:11.5px;line-height:1.65}
.dsh-mcp-overlay{position:fixed;inset:0;background:var(--dsw-alias-bg-overlay);display:flex;align-items:center;justify-content:center;z-index:200;padding:12px;animation:mcpFade .15s ease-out}
.dsh-mcp-whatsnew{box-sizing:border-box;width:min(460px,92vw);background:var(--mcp-bg-2);border:0;border-radius:var(--mcp-r-panel);padding:20px;box-shadow:var(--dsw-elevation-prominent);animation:mcpPop .2s cubic-bezier(.2,0,0,1)}
.dsh-mcp-whatsnew-head{display:flex;flex-direction:column;gap:2px;margin-bottom:12px}
.dsh-mcp-whatsnew-head b{font-size:15px;font-weight:650}
.dsh-mcp-whatsnew-head span{font-size:12px;color:var(--mcp-mut)}
.dsh-mcp-whatsnew-body{display:flex;flex-direction:column;gap:12px;max-height:52vh;overflow-y:auto}
.dsh-mcp-whatsnew-entry{display:flex;flex-direction:column;gap:6px}
.dsh-mcp-whatsnew-ver{font-size:11px;font-weight:650;color:var(--mcp-accent)}
.dsh-mcp-whatsnew-item{display:flex;gap:8px;font-size:12.5px;line-height:1.6}
.dsh-mcp-whatsnew-dot{flex:none;color:var(--mcp-accent)}
.dsh-mcp-whatsnew-where{display:block;margin-top:3px;width:fit-content;padding:0 6px;border-radius:999px;background:var(--mcp-line);color:var(--mcp-mut);font-size:11px;line-height:17px;white-space:nowrap;corner-shape:round}
.dsh-mcp-whatsnew-foot{display:flex;justify-content:flex-end;margin-top:14px}
.dsh-mcp-modal{box-sizing:border-box;display:flex;flex-direction:column;width:560px;max-width:92vw;max-height:88dvh;overflow:hidden;background:var(--mcp-bg-2);border:0;border-radius:var(--mcp-r-panel);padding:0;box-shadow:var(--dsw-elevation-prominent);animation:mcpPop .2s cubic-bezier(.2,0,0,1)}
.dsh-mcp-modal-head{display:flex;align-items:flex-start;gap:12px;flex:none;padding:20px 20px 16px}
.dsh-mcp-modal h3{flex:1;min-width:0;margin:0;font-size:15px;line-height:1.5;font-weight:600;overflow-wrap:anywhere}
.dsh-mcp-modal-body{min-height:0;overflow-y:auto;overscroll-behavior:contain;padding:0 20px 20px}
.dsh-mcp-field{margin-bottom:14px}
.dsh-mcp-field>label{display:block;font-size:11.5px;color:var(--mcp-mut);margin-bottom:6px;font-weight:500}
/* Note: 布局与滚动边界见 .agents/notes/implemented/2026-11-05-extension-center-workbench.md；控制边界见 2026-11-04-compact-tool-preview.md
   -- 工具加载工作区 -----------------------------------------------------------
   这是一个工作台，不是设置卡片堆：顶部给上下文，正文给决策，底部给提交。
   颜色、几何和层级全部从 DSH 主题令牌来；平面分隔用发丝线，抬升表面才用阴影。 */
.dsh-mcp-tool-loading-page{display:flex;flex:1;min-height:0;flex-direction:column;overflow:hidden}
.dsh-mcp-tool-scroll{flex:1;min-height:0;overflow-y:auto;overflow-x:hidden;padding:0 2px 2px 0}
/* 固定区域：参数、概览、工具条不滚；只有工具列表滚。 */
.dsh-mcp-tool-fixed{flex:none}
.dsh-mcp-tool-hero{display:flex;align-items:flex-start;justify-content:space-between;gap:12px;padding:0 0 10px}
.dsh-mcp-tool-hero-copy{min-width:0}
.dsh-mcp-tool-title{margin:0;font-size:16px;font-weight:650;line-height:1.3;letter-spacing:0}
/* 概览条：一张卡、四个统计格。数字是这张页面上唯一变长的东西，给它 tabular-nums
   并钉住一格的宽度节奏，保存中数字增减时不推挤邻居。 */
.dsh-mcp-tool-overview{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));margin:10px 0 2px;border:1px solid var(--mcp-line);border-radius:var(--mcp-r-lg);background:var(--mcp-bg-2)}
.dsh-mcp-tool-stat{display:flex;align-items:center;gap:9px;min-width:0;padding:10px 14px}
.dsh-mcp-tool-stat+.dsh-mcp-tool-stat{border-left:.5px solid var(--mcp-line)}
.dsh-mcp-tool-stat-mark{width:8px;height:8px;flex:none;border-radius:50%;corner-shape:round;background:var(--mcp-mut)}
.dsh-mcp-tool-stat-mark.resident{background:var(--mcp-ok)}
.dsh-mcp-tool-stat-mark.deferred{background:var(--mcp-accent)}
.dsh-mcp-tool-stat-mark.protected{background:var(--mcp-warn)}
.dsh-mcp-tool-stat-value{font-size:17px;font-weight:680;line-height:1.1;font-variant-numeric:tabular-nums}
.dsh-mcp-tool-stat-copy{min-width:0;display:flex;flex-direction:column;gap:1px}
.dsh-mcp-tool-stat-label{color:var(--dsw-alias-label-primary);font-size:11.5px;font-weight:600;line-height:1.3}
.dsh-mcp-tool-stat-note{overflow:hidden;color:var(--mcp-mut);font-size:10.5px;line-height:1.35;text-overflow:ellipsis;white-space:nowrap}
/* 搜索参数：与工具列表同级的第二区块，不再是底部折叠的「高级设置」。
    标题与三列字段先于工具统计，说明留给字段旁的提示。 */
.dsh-mcp-tool-params{padding:0 0 14px;border-bottom:.5px solid var(--mcp-line)}
.dsh-mcp-tool-params-head{margin-bottom:12px}
.dsh-mcp-tool-params-title{margin:0;font-size:13px;font-weight:600;line-height:1.35}
.dsh-mcp-tool-params-grid{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:12px}
.dsh-mcp-tool-param{display:flex;flex-direction:column;gap:6px;min-width:0}
.dsh-mcp-tool-param-label{display:flex;align-items:center;gap:5px;color:var(--dsw-alias-label-primary);font-size:11.5px;font-weight:600;line-height:1.35}
.dsh-mcp-tool-param-inline{display:flex;align-items:center;gap:8px}
.dsh-mcp-tool-param-inline input{flex:1;min-width:0}
.dsh-mcp-tool-param input[type='number']{width:100%;box-sizing:border-box;padding:0 10px;height:32px;border:0.5px solid var(--mcp-line);border-radius:var(--mcp-r-md);background:var(--mcp-bg-1);color:var(--dsw-alias-label-primary);font:inherit;font-size:12px;line-height:1.35;outline:none}
.dsh-mcp-tool-param input[type='number']:focus{border-color:var(--mcp-accent);box-shadow:0 0 0 2px var(--dsw-alias-interactive-bg-hover-accent)}
.dsh-mcp-tool-param input:disabled{opacity:.55;cursor:not-allowed}
.dsh-mcp-tool-param-saved{margin:8px 0 0;color:var(--mcp-ok);font-size:11px;line-height:1.4}
/* 工具条：搜索 + 分段筛选。筛选用与顶栏能力层同一形态的浅槽分段控件——
   「看到哪一面」在面板里已经长这样，工具页不再发明第二种筛选长相。 */
.dsh-mcp-tool-toolbar{display:flex;align-items:center;gap:10px;padding:8px 0 10px}
.dsh-mcp-tool-toolbar .dsh-mcp-search{flex:1;min-width:180px}
.dsh-mcp-tool-filter{display:inline-flex;gap:2px;flex:none;padding:3px;border-radius:var(--mcp-r-lg);background:var(--mcp-bg-2)}
.dsh-mcp-tool-filter button{display:inline-flex;align-items:center;gap:5px;border:0;border-radius:var(--mcp-r-md);background:transparent;color:var(--mcp-mut);font:inherit;font-size:11.5px;line-height:1.3;padding:5px 11px;cursor:pointer;white-space:nowrap}
.dsh-mcp-tool-filter button[aria-pressed='true']{background:var(--dsw-alias-button-primary-fill);color:var(--dsw-alias-label-primary-inverted);font-weight:650}
/* 卡片网格：每张卡自带边框与底色，行间不再用发丝线分隔——线上排名字曾是
   「密密麻麻一整片」观感的来源；卡片之间的 10px 空隙就是分组。 */
.dsh-mcp-tool-list{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:8px}
/* 行 = 卡片：第 1 行 名称+中文短名+ⓘ | 常驻/按需分段；第 2 行 说明（截断，全文在 title）。
   说明截断是有意的：这页的决定是「加载方式」，说明只是辨认工具用的线索，
   整段铺开会让 34 张卡高低不一、网格错位。 */
.dsh-mcp-tool-row{position:relative;display:flex;flex-direction:column;gap:5px;margin:0;padding:10px 12px;border:.5px solid var(--mcp-line);border-radius:var(--mcp-r-md);background:var(--mcp-bg-1);transition:border-color .12s,background .12s}
.dsh-mcp-tool-row.is-changed{border-color:var(--mcp-accent);background:var(--dsw-alias-interactive-bg-hover-accent)}
.dsh-mcp-tool-info{display:flex;align-items:center;gap:6px;min-width:0}
.dsh-mcp-tool-row .dsh-mcp-tool-name{flex:0 1 auto;max-width:100%;min-width:0;overflow:hidden;color:var(--dsw-alias-label-primary);font-family:var(--mcp-mono);font-size:12px;font-weight:650;line-height:1.4;text-overflow:ellipsis;white-space:nowrap}
.dsh-mcp-tool-alias{min-width:0;overflow:hidden;color:var(--mcp-mut);font-size:11px;line-height:1.4;text-overflow:ellipsis;white-space:nowrap}
.dsh-mcp-tool-desc{display:-webkit-box;overflow:hidden;color:var(--mcp-mut);font-size:10.5px;line-height:1.45;-webkit-box-orient:vertical;-webkit-line-clamp:2}
/* 常驻/按需：行内的选择控件与工具条的筛选分段同形同尺寸，差别只在选中色——
   常驻读语义绿、按需读 accent，与概览条的两个圆点一一对应。 */
.dsh-mcp-tool-pick{display:inline-flex;gap:2px;flex:none;padding:2px;border-radius:var(--mcp-r-md);background:var(--mcp-bg-2)}
.dsh-mcp-tool-pick button{border:0;border-radius:var(--mcp-r-sm);background:transparent;color:var(--mcp-mut);font:inherit;font-size:11px;line-height:1.3;padding:4px 10px;cursor:pointer;white-space:nowrap}
.dsh-mcp-tool-pick button:disabled{opacity:.55;cursor:not-allowed}
.dsh-mcp-tool-pick button[aria-pressed='true']{font-weight:650}
.dsh-mcp-tool-pick button[aria-pressed='true'].is-resident{background:var(--dsw-alias-state-success-tertiary);color:var(--dsw-alias-state-success-primary)}
.dsh-mcp-tool-pick button[aria-pressed='true'].is-deferred{background:var(--dsw-alias-interactive-bg-hover-accent);color:var(--mcp-accent)}
.dsh-mcp-tool-pick button:focus-visible{outline:1px solid var(--mcp-accent);outline-offset:1px}
/* 保存栏常驻底栏：左边一句话说清「改了几个/改完何时生效」，右边放弃+保存。
   改动徽标与脏行卡片同色同圆点——底部 promised 的改动数与列表里高亮的卡互相对得上。 */
.dsh-mcp-tool-save{display:flex;align-items:center;gap:10px;flex:none;margin-top:2px;padding:10px 12px;border:.5px solid var(--mcp-line);border-radius:var(--mcp-r-md);background:var(--mcp-bg-2)}
.dsh-mcp-tool-save-hint{display:flex;align-items:center;gap:6px;min-width:0;overflow:hidden;font-size:11px;line-height:1.4;color:var(--mcp-mut)}
.dsh-mcp-tool-save-dirty{display:inline-flex;align-items:center;gap:5px;flex:none;padding:1.5px 8px;border-radius:999px;corner-shape:round;background:var(--dsw-alias-interactive-bg-hover-accent);color:var(--mcp-accent);font-size:10.5px;font-weight:650;line-height:16px;font-variant-numeric:tabular-nums}
.dsh-mcp-tool-save-spacer{flex:1}
.dsh-mcp-tool-save-actions{display:flex;align-items:center;gap:8px;flex:none}
.dsh-mcp-tool-loading-page .dsh-mcp-d-err{margin:12px 0 0}
@media (hover:hover){
  .dsh-mcp-tool-filter button:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}
  .dsh-mcp-tool-row:hover{border-color:var(--dsw-alias-border-l3)}
  .dsh-mcp-tool-row.is-changed:hover{border-color:var(--mcp-accent)}
  .dsh-mcp-tool-pick button:not([aria-pressed='true']):hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}
}
@media (max-width:760px){
  .dsh-mcp-tool-hero{display:block;padding-bottom:8px}
  .dsh-mcp-tool-overview{grid-template-columns:repeat(2,minmax(0,1fr))}
  .dsh-mcp-tool-stat{padding:9px 10px}
  .dsh-mcp-tool-stat+.dsh-mcp-tool-stat{border-left:0}
  .dsh-mcp-tool-stat:nth-child(even){border-left:.5px solid var(--mcp-line)}
  .dsh-mcp-tool-stat:nth-child(n+3){border-top:.5px solid var(--mcp-line)}
  .dsh-mcp-tool-stat-value{font-size:16px}
  .dsh-mcp-tool-stat-note{display:none}
  .dsh-mcp-tool-params-grid{grid-template-columns:repeat(2,minmax(0,1fr));gap:10px}
  .dsh-mcp-tool-param:last-child{grid-column:1 / -1}
  .dsh-mcp-tool-param-label{font-size:10.5px}
  .dsh-mcp-tool-toolbar{align-items:stretch;flex-direction:column}
  .dsh-mcp-tool-toolbar .dsh-mcp-search{width:100%}
  .dsh-mcp-tool-filter{width:100%;justify-content:space-between}
  .dsh-mcp-tool-filter button{flex:1;padding-inline:6px}
  .dsh-mcp-tool-list{grid-template-columns:minmax(0,1fr)}
  .dsh-mcp-tool-save{align-items:stretch;flex-direction:column;gap:8px}
  .dsh-mcp-tool-save-spacer{display:none}
  .dsh-mcp-tool-save-actions{justify-content:flex-end}
}
/* 参数说明标记（C2）：label 是 block，标记用 inline-flex 挂在文字后面，不进流布局。 */
.dsh-mcp-hint{display:inline-flex;align-items:center;justify-content:center;width:14px;height:14px;margin-left:6px;color:var(--mcp-mut);vertical-align:middle;cursor:help;border-radius:50%;corner-shape:round}
.dsh-mcp-hint:hover,.dsh-mcp-hint:focus-visible{color:var(--mcp-accent)}
.dsh-mcp-hint:focus-visible{outline:1px solid var(--mcp-accent);outline-offset:1px}
/* 开关关掉时输入框置灰（disabled）：可见、不可改、不生效——不卸载，避免表单跳动。 */
.dsh-mcp-field input:disabled{opacity:.45;cursor:not-allowed}
.dsh-mcp-field input,.dsh-mcp-field select,.dsh-mcp-field textarea{width:100%;box-sizing:border-box;padding:0 11px;height:32px;border-radius:var(--mcp-r-md);border:1px solid var(--mcp-line);background:var(--mcp-bg-1);color:var(--dsw-alias-label-primary);font:inherit;font-size:12.5px;outline:none;transition:border-color .1s,box-shadow .1s}
.dsh-mcp-field textarea{padding:8px 11px;height:auto;min-height:72px}
.dsh-mcp-field input::placeholder{color:var(--mcp-mut)}
.dsh-mcp-field input:focus,.dsh-mcp-field select:focus,.dsh-mcp-field textarea:focus{border-color:var(--mcp-accent);box-shadow:0 0 0 2px var(--dsw-alias-interactive-bg-hover-accent)}
.dsh-mcp-radio-row{display:grid;grid-template-columns:1fr 1fr;gap:8px}
.dsh-mcp-radio-row label{display:flex;align-items:center;gap:8px;margin:0;border:1px solid var(--mcp-line);border-radius:var(--mcp-r-md);padding:9px 12px;background:var(--mcp-bg-1);color:var(--dsw-alias-label-primary);cursor:pointer;font-size:12.5px;transition:border-color .12s,background .12s}
.dsh-mcp-radio-row label:hover{border-color:var(--dsw-alias-border-l3);background:var(--dsw-alias-interactive-bg-hover)}
.dsh-mcp-radio-row label.sel{border-color:var(--mcp-accent);background:var(--dsw-alias-interactive-bg-hover-accent)}
.dsh-mcp-radio-row input[type='radio']{width:15px;height:15px;flex:none;margin:0;padding:0;appearance:none;-webkit-appearance:none;border:1.5px solid var(--dsw-alias-border-l3);border-radius:50%;background:transparent;position:relative;cursor:pointer;transition:border-color .12s,background .12s;corner-shape:round}
.dsh-mcp-radio-row input[type='radio']:checked{border-color:var(--mcp-accent);background:radial-gradient(circle,var(--dsw-alias-label-primary-inverted) 0 4px,var(--mcp-accent) 4.5px)}
.dsh-mcp-radio-row input[type='radio']:hover{border-color:var(--mcp-accent)}
.dsh-mcp-kv-edit{display:grid;grid-template-columns:38% 1fr auto;gap:8px;margin-bottom:8px;align-items:center}
.dsh-mcp-kv-edit input{width:100%;min-width:0;box-sizing:border-box}
.dsh-mcp-input-action{display:grid;grid-template-columns:minmax(0,1fr) auto;gap:8px;align-items:start}.dsh-mcp-input-action textarea{min-width:0}.dsh-mcp-kv-row-actions{display:flex;gap:5px;align-items:center;height:34px}.dsh-mcp-inline-icon{box-sizing:border-box;width:34px!important;height:34px!important;padding:0!important;flex:none}
.dsh-mcp-kv-del{box-sizing:border-box;width:34px;height:34px;padding:0!important;display:inline-flex;align-items:center;justify-content:center;flex:none}
.dsh-mcp-secret{display:inline-flex;align-items:center;gap:6px;min-width:0;max-width:100%}.dsh-mcp-secret-value{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:pre-wrap;word-break:break-all}.dsh-mcp-secret-btn{width:24px;height:24px;flex:none;padding:0;border:1px solid var(--mcp-line);border-radius:var(--mcp-r-sm);background:var(--dsw-alias-button-elevated-fill);color:var(--mcp-mut);cursor:pointer}.dsh-mcp-secret-btn:hover{color:var(--dsw-alias-label-primary);border-color:var(--mcp-accent)}.dsh-mcp-secret-list{display:flex;flex-direction:column;gap:5px;min-width:0}.dsh-mcp-secret-row{display:grid;grid-template-columns:minmax(0,40%) minmax(0,1fr);gap:8px;align-items:center;min-width:0}.dsh-mcp-secret-row b{min-width:0;overflow-wrap:anywhere}.dsh-mcp-log{margin-top:10px;padding:9px 11px;border-left:3px solid var(--mcp-err);background:var(--dsw-alias-interactive-bg-hover-danger);color:var(--mcp-err);font-size:12px;line-height:1.5;white-space:pre-wrap;word-break:break-word}.dsh-mcp-log.warn{border-left-color:var(--mcp-warn);color:var(--mcp-warn);background:var(--dsw-alias-state-warn-tertiary)}
.dsh-mcp-kv-add{display:flex;justify-content:flex-end;margin-top:2px}
.dsh-mcp-kv-del{border:1px solid var(--mcp-line);background:var(--dsw-alias-button-elevated-fill);color:var(--mcp-mut);cursor:pointer;font-size:14px;padding:3px 9px;border-radius:var(--mcp-r-sm);line-height:18px;transition:color .12s,background .12s,border-color .12s}
.dsh-mcp-kv-del:hover{color:var(--mcp-err);background:var(--dsw-alias-interactive-bg-hover-danger);border-color:var(--dsw-alias-state-error-primary)}
.dsh-mcp-modal-actions{display:flex;justify-content:flex-end;gap:8px;margin:0;padding:14px 20px;flex:none;border-top:1px solid var(--mcp-line);background:var(--mcp-bg-2);flex-wrap:wrap}
.dsh-mcp-advanced{margin-top:14px}.dsh-mcp-check{display:flex!important;align-items:center;gap:8px;margin:9px 0!important;color:var(--dsw-alias-label-primary)!important}.dsh-mcp-check input{width:auto!important}.dsh-mcp-number-grid{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:8px}.dsh-mcp-number-grid .dsh-mcp-field{margin-bottom:0}.dsh-mcp-import-preview{font-size:12px;line-height:1.6;color:var(--mcp-mut);white-space:pre-wrap}.dsh-mcp-import-json{min-height:220px;resize:vertical;font-family:var(--mcp-mono)!important}
.dsh-mcp-check-list{display:flex;flex-direction:column;gap:3px;max-height:180px;overflow-y:auto;padding:3px;border:1px solid var(--mcp-line);border-radius:var(--mcp-r-md);background:var(--mcp-bg-1)}
.dsh-mcp-check-row{display:flex;align-items:center;gap:8px;padding:5px 7px;border-radius:var(--mcp-r-sm);font-size:12px;color:var(--dsw-alias-label-primary);cursor:pointer}
.dsh-mcp-check-row:hover{background:var(--dsw-alias-interactive-bg-hover)}
.dsh-mcp-check-row input{width:auto;flex:none;margin:0}
.dsh-mcp-check-name{font-weight:600;overflow-wrap:anywhere}
.dsh-mcp-check-meta{margin-left:auto;flex:none;font-size:11px;color:var(--mcp-mut)}
.dsh-mcp-check-toolbar{display:flex;align-items:center;gap:8px;margin:0 0 6px;font-size:11px;color:var(--mcp-mut)}
.dsh-mcp-copy-target{width:100%;box-sizing:border-box;padding:8px 10px;border:1px solid var(--mcp-line);border-radius:var(--mcp-r-md);background:var(--mcp-bg-1);color:var(--dsw-alias-label-primary);font:inherit;font-size:12.5px}
.dsh-mcp-source-box{margin:0 0 14px;flex:none}.dsh-mcp-source-list{display:flex;flex-direction:column;gap:6px;max-height:186px;overflow-y:auto;margin-top:7px}.dsh-mcp-source-row{box-sizing:border-box;display:flex;flex-direction:column;gap:3px;width:100%;padding:8px 10px;border:1px solid var(--mcp-line);border-radius:var(--mcp-r-md);background:var(--mcp-bg-1);color:var(--dsw-alias-label-primary);font-family:inherit;font-size:12px;line-height:1.45;text-align:left;cursor:pointer;transition:border-color .12s,background .12s}.dsh-mcp-source-row:hover:not(:disabled){border-color:var(--dsw-alias-border-l3);background:var(--dsw-alias-interactive-bg-hover)}.dsh-mcp-source-row.sel{border-color:var(--mcp-accent);background:var(--mcp-bg-2)}.dsh-mcp-source-row:disabled{cursor:default;opacity:.7}.dsh-mcp-source-head{display:flex;align-items:baseline;gap:8px;flex-wrap:wrap}.dsh-mcp-source-name{font-weight:600}.dsh-mcp-source-path{font-family:var(--mcp-mono);font-size:10.5px;color:var(--dsw-alias-brand-text);overflow-wrap:anywhere}.dsh-mcp-source-detail{font-size:11px;color:var(--mcp-mut);overflow-wrap:anywhere}.dsh-mcp-source-note{font-size:10.5px;color:var(--mcp-mut)}.dsh-mcp-source-warn{font-size:10.5px;color:var(--mcp-warn)}
.dsh-mcp-toast{position:fixed;bottom:24px;left:50%;transform:translateX(-50%);background:var(--dsw-alias-toast-bg);backdrop-filter:blur(10px);border:0;color:var(--dsw-alias-label-primary);padding:10px 18px;border-radius:var(--mcp-r-lg);font-size:12.5px;z-index:300;box-shadow:var(--dsw-shadow-lv3);max-width:70vw;animation:mcpPop .16s ease-out}
.dsh-mcp-toast.err{border:1px solid var(--dsw-alias-state-error-primary)}
.dsh-mcp-toast.ok{border:1px solid var(--dsw-alias-state-success-primary)}
.dsh-mcp-toggle{position:relative;width:34px;height:19px;box-sizing:border-box;border-radius:999px;border:0;cursor:pointer;background:var(--dsw-alias-border-l3);transition:background .18s,border-color .18s;flex:none;box-shadow:none;corner-shape:round}
.dsh-mcp-toggle[aria-checked='true']{background:var(--mcp-accent);border-color:transparent}
.dsh-mcp-toggle:disabled{opacity:.65;cursor:not-allowed}
.dsh-mcp-toggle::after{content:"";position:absolute;top:2px;left:2px;width:13px;height:13px;border-radius:50%;background:var(--dsw-alias-switch-thumb);transition:left .18s,background .18s;box-shadow:none;corner-shape:round}
.dsh-mcp-toggle[aria-checked='true']::after{left:17px;background:var(--dsw-alias-label-primary-foreground)}
.dsh-mcp-d-err{font-size:12.5px;color:var(--mcp-err);margin-top:8px;white-space:pre-wrap}
/* 悬浮按钮：外框尺寸必须恰好是 JS 里 FAB_SIZE 的值（拖拽边界与默认位置按它算，
   client.js 的 clampFabPos/defaultFabPos）。border-box 让这个等式不受边框影响——
   之前是 1px 边框 + content-box，渲染出 52px 而 JS 按 50px 夹取，右/下边缘会差 2px；
   现在去掉边框（抬升表面改成 elevation 阴影）+ border-box，两边一致且不会再漂。 */
/* 浮动按钮：48px 圆角矩形，圆角跟随主题，hover 用 translateY(-2px) + elevation 加深，
   不再 scale(1.05)。原 50px 正圆 + scale 放大像「游戏按钮」，与面板气质不符。 */
.dsh-mcp-fab{position:fixed;right:22px;bottom:22px;box-sizing:border-box;width:48px;height:48px;border-radius:var(--mcp-r-lg);border:0;background:var(--dsw-alias-button-primary-fill);color:var(--dsw-alias-label-primary-inverted);cursor:grab;user-select:none;display:flex;align-items:center;justify-content:center;box-shadow:var(--dsw-elevation-panel);z-index:190;touch-action:none;transition:transform .15s cubic-bezier(.2,0,0,1),background .15s,box-shadow .15s;pointer-events:auto}
.dsh-mcp-fab:hover{transform:translateY(-2px);background:var(--dsw-alias-button-primary-hover);box-shadow:var(--dsw-elevation-prominent)}
.dsh-mcp-fab:active{transform:translateY(0)}
.dsh-mcp-fab svg{width:20px;height:20px}
.dsh-mcp-panel-overlay{position:fixed;inset:0;background:var(--dsw-alias-bg-overlay);display:flex;align-items:center;justify-content:center;z-index:180;padding:26px;pointer-events:auto;animation:mcpFade .14s ease-out}
.dsh-mcp-panel{box-sizing:border-box;width:min(1180px,95vw);height:min(920px,90vh);background:var(--mcp-bg-1);border:0;border-radius:var(--mcp-r-panel);box-shadow:var(--dsw-elevation-prominent);display:flex;flex-direction:column;overflow:hidden;animation:mcpPop .2s cubic-bezier(.2,0,0,1)}
.dsh-mcp-panel:focus{outline:none}
.dsh-mcp-modal:focus{outline:none}
.dsh-mcp-panel .dsh-mcp-wrap{height:100%;min-height:0;padding:20px}
.dsh-mcp-filters{flex:none;display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1fr);gap:6px;align-items:center}
/* 控件收起、只剩一键动作时（项目作用域条目 ≤6）：单列 + 靠右，与有 select 时按钮的位置一致。 */
.dsh-mcp-filters.bare{grid-template-columns:auto;justify-content:end}
/* 「全部延迟」主按钮：放在过滤器行右侧（原本大片空白），必须是列表第一屏就可见的——
   曾经它在底栏，服务器一多就滚出视野，用户根本找不到这个功能。 */
.dsh-mcp-filters>.dsh-mcp-defer-all{grid-column:1 / -1;justify-self:end}
.dsh-mcp-defer-all{display:inline-flex;align-items:center;gap:5px;padding:0 11px;height:32px;border-radius:var(--mcp-r-sm);border:1px solid var(--mcp-accent);background:var(--mcp-accent);color:var(--dsw-alias-label-primary-inverted);font:inherit;font-size:11.5px;font-weight:600;white-space:nowrap;cursor:pointer;transition:filter .1s,opacity .1s}
.dsh-mcp-defer-all:hover:not(:disabled){filter:brightness(1.12)}
.dsh-mcp-defer-all:disabled{opacity:.45;cursor:not-allowed}
.dsh-mcp-defer-all svg{width:12px;height:12px;flex:none}
.dsh-mcp-filters select{width:100%;box-sizing:border-box;padding:0 24px 0 8px;height:32px;border-radius:var(--mcp-r-sm);border:1px solid var(--mcp-line);background:var(--mcp-bg-1);color:var(--dsw-alias-label-primary);font:inherit;font-size:11.5px;outline:none;transition:border-color .1s;appearance:none;-webkit-appearance:none;background-image:linear-gradient(45deg,transparent 50%,var(--mcp-mut) 50%),linear-gradient(135deg,var(--mcp-mut) 50%,transparent 50%);background-position:calc(100% - 13px) 50%,calc(100% - 9px) 50%;background-size:4px 4px,4px 4px;background-repeat:no-repeat}
.dsh-mcp-filters select:focus{border-color:var(--mcp-accent)}
.dsh-mcp-tool{flex-direction:column;padding:0;gap:0}
.dsh-mcp-tool-head{display:flex;align-items:center;gap:9px;padding:7px 9px;border-radius:var(--mcp-r-sm)}
.dsh-mcp-tool-head.interactive{cursor:pointer}
.dsh-mcp-tool-head.interactive:hover{background:var(--dsw-alias-interactive-bg-hover)}
.dsh-mcp-tool-head.interactive:focus-visible{outline:1px solid var(--mcp-accent);outline-offset:-1px}
.dsh-mcp-tool-body{padding:2px 9px 10px;display:flex;flex-direction:column;gap:8px}
.dsh-mcp-params{display:flex;flex-direction:column;gap:6px}
.dsh-mcp-param{border:1px solid var(--mcp-line);border-radius:var(--mcp-r-md);padding:7px 9px;background:var(--mcp-bg-1)}
.dsh-mcp-param-head{display:flex;align-items:center;gap:7px;flex-wrap:wrap}
.dsh-mcp-param-name{font-family:var(--mcp-mono);font-size:11.5px;color:var(--dsw-alias-brand-text);font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:100%}
.dsh-mcp-param-type{font-size:10px;color:var(--mcp-mut);border:1px solid var(--mcp-line);border-radius:var(--mcp-r-xs);padding:1px 5px;font-family:var(--mcp-mono);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:60%}
.dsh-mcp-req{font-size:10px;color:var(--dsw-alias-state-warn-primary);border:1px solid var(--dsw-alias-state-warn-primary);border-radius:var(--mcp-r-xs);padding:1px 5px}
.dsh-mcp-opt{font-size:10px;color:var(--mcp-mut);border:1px solid var(--mcp-line);border-radius:var(--mcp-r-xs);padding:1px 5px}
.dsh-mcp-param-desc{font-size:11px;color:var(--mcp-mut);margin-top:4px;line-height:1.5;white-space:normal;word-break:break-word}
.dsh-mcp-param-enum{font-size:10.5px;color:var(--mcp-mut);margin-top:3px;font-family:var(--mcp-mono);word-break:break-all}
.dsh-mcp-tool-rawbtn{align-self:flex-start;border:1px solid var(--mcp-line);border-radius:var(--mcp-r-sm);background:var(--dsw-alias-button-elevated-fill);color:var(--mcp-mut);font-size:11px;padding:4px 9px;cursor:pointer;transition:color .12s,border-color .12s}
.dsh-mcp-tool-rawbtn:hover{color:var(--dsw-alias-label-primary);border-color:var(--dsw-alias-border-l3)}
.dsh-mcp-json{font-family:var(--mcp-mono);font-size:11px;line-height:1.5;background:var(--mcp-bg-1);border:1px solid var(--mcp-line);border-radius:var(--mcp-r-lg);padding:9px;overflow:auto;white-space:pre;max-height:260px;color:var(--dsw-alias-label-primary);margin:0}
/* ── 发现市场（两个能力面共用的**内联**视图）─────────────────────────────
   曾经它是 .dsh-mcp-modal.dsh-mcp-market——一个 1080×820 的浮层；而技能面的市场是内联的。
   于是同一个「发现市场」在两个能力面里是两种形态：MCP 面按「市场」弹窗、技能面按「市场」换页。
   现在两边都是内联视图，共用下面这批原语（.dsh-mcp-chips / .dsh-mcp-grid / .dsh-mcp-mcard）。
   卡片类名故意**不叫** .dsh-mcp-card：那个名字已经被详情里的内容卡占了，而这里的一条
   display:flex 曾经把 .dsh-mcp-pane-off 压掉（三个页签同时显示，真机事故）。 */
.dsh-mcp-market-view{flex:1;min-height:0;overflow-y:auto;display:flex;flex-direction:column;gap:12px;padding-right:2px}
/* 工具栏（来源切换 + 搜索 + 分类药丸）钉在滚动区顶部。
   为什么需要它：滚动盒是 .dsh-mcp-market-view 本身，而工具栏是它的子节点，所以默认会跟着滚走
   （纯 MCP 那版把滚动放在 .dsh-mcp-market-grid 上、工具栏留在外面，因此天然固定；改成内联市场
   视图 + 多 section 之后滚动盒上提了一层，工具栏就掉进了滚动区）。
   三个要点缺一不可：① 必须把「head + 两个来源各自的分类药丸行」**包成一个容器**再 sticky——
   分类药丸是 .dsh-mcp-market-head 的兄弟节点，只钉 head 的话药丸仍会从下面滑过去；
   ② 必须给不透明背景，否则卡片会从工具栏下面透出来；③ top:0 相对滚动容器的 padding 盒，
   本容器的 padding 只有右侧 2px，所以 0 就对。 */
.dsh-mcp-market-toolbar{position:sticky;top:0;z-index:1;flex:none;display:flex;flex-direction:column;gap:10px;padding-bottom:10px;border-bottom:1px solid var(--mcp-line);background:var(--mcp-bg-1)}
.dsh-mcp-market-head{display:flex;align-items:center;gap:10px;flex-wrap:wrap;flex:none}
/* 右侧一组：搜索 + 「安装到」。原型是同一条横排（药丸 | 搜索 | 安装到），这里靠
   flex-wrap 实现——分类药丸会先占满一行，工具组整块换到下一行，窄屏也不会把选择器压扁。 */
.dsh-mcp-market-tools{display:flex;flex-wrap:wrap;align-items:center;gap:8px;flex:1 1 260px;min-width:0}
.dsh-mcp-market-tools .dsh-mcp-search{flex:1 1 auto;min-width:160px}
/* 「安装到」：市场模式下唯一的作用域入口。刻意做成带文字的标签 + 原生 select
   （而不是又一个图标按钮）——「装到哪」是**有后果**的选择，不能只用一个图标暗示。 */
.dsh-mcp-market-scope{display:inline-flex;align-items:center;gap:6px;flex:none;white-space:nowrap;font-size:11.5px;color:var(--dsw-alias-label-tertiary)}
.dsh-mcp-market-scope select{max-width:220px;box-sizing:border-box;padding:6px 24px 6px 9px;border-radius:var(--mcp-r-sm);border:1px solid var(--mcp-line);background:var(--mcp-bg-1);color:var(--dsw-alias-label-primary);font:inherit;font-size:12px;outline:none;appearance:none;-webkit-appearance:none;background-image:linear-gradient(45deg,transparent 50%,var(--mcp-mut) 50%),linear-gradient(135deg,var(--mcp-mut) 50%,transparent 50%);background-position:calc(100% - 13px) 50%,calc(100% - 9px) 50%;background-size:4px 4px,4px 4px;background-repeat:no-repeat;cursor:pointer}
.dsh-mcp-market-scope select:focus{border-color:var(--mcp-accent)}
.dsh-mcp-market-head .dsh-mcp-search{flex:1 1 180px;min-width:0}
.dsh-mcp-market-section{display:flex;align-items:baseline;gap:8px;flex-wrap:wrap;flex:none}
.dsh-mcp-market-section b{font-size:13px;font-weight:650}
.dsh-mcp-market-section span{font-size:11.5px;color:var(--dsw-alias-label-tertiary)}
/* 分类药丸：**换行**，不横滚。
   横滚 + 隐藏滚动条 = 最后一个药丸被裁掉一半，而且没有任何线索说明它还能滚
   （真机上就是「文件与…」被切在右边缘，用户第一反应是「没处理好」——对）。
   三条药丸行各有各的出口，但都必须有一个可见的出口：详情页签换行、作用域条
   「横滚 + ⋯N 弹层」、分类药丸条目数固定且有限（十来个）所以直接换行。
   ⚠️ 别在这条上加 overflow-x:auto——那正是把出口藏起来的写法。 */
.dsh-mcp-chips{display:flex;flex-wrap:wrap;gap:6px;align-items:center;min-width:0;padding:1px 0}
/* 药丸行吃掉搜索框剩下的宽度；搜索框自身有 min-width，窄屏下会整块换到下一行。 */
.dsh-mcp-market-head .dsh-mcp-chips{flex:1 1 auto}
.dsh-mcp-chip{display:inline-flex;align-items:center;gap:5px;flex:none;padding:5px 11px;border-radius:999px;corner-shape:round;border:1px solid var(--mcp-line);background:var(--mcp-bg-1);color:var(--mcp-mut);font:inherit;font-size:12px;line-height:1.5;white-space:nowrap;cursor:pointer;transition:background .13s,border-color .13s,color .13s}
.dsh-mcp-chip:hover{background:var(--dsw-alias-interactive-bg-hover);border-color:var(--dsw-alias-border-l3)}
/* 不可用的来源（宿主没提供那个接口）：明确变灰且不接受点击，而不是给一个点开就报错的入口。 */
.dsh-mcp-chip:disabled{opacity:.45;cursor:not-allowed;text-decoration:line-through}
.dsh-mcp-chip:disabled:hover{background:var(--mcp-bg-1);border-color:var(--mcp-line)}
.dsh-mcp-chip.sel{color:var(--dsw-alias-label-primary);border-color:var(--mcp-accent);background:var(--dsw-alias-interactive-bg-hover-accent);font-weight:600}
.dsh-mcp-chip-count{font-size:10px;padding:0 5px;border-radius:999px;corner-shape:round;background:var(--mcp-line);color:var(--mcp-mut);line-height:15px}
.dsh-mcp-chip.sel .dsh-mcp-chip-count{background:var(--dsw-alias-interactive-bg-hover-accent);color:var(--mcp-accent)}
.dsh-mcp-market-filters{display:flex;align-items:center;gap:10px;flex-wrap:wrap;flex:none;font-size:12px;color:var(--mcp-mut)}
.dsh-mcp-market-filters select{padding:5px 22px 5px 9px;border-radius:var(--mcp-r-sm);border:1px solid var(--mcp-line);background:var(--mcp-bg-1);color:var(--dsw-alias-label-primary);font:inherit;font-size:12px;outline:none;appearance:none;-webkit-appearance:none;background-image:linear-gradient(45deg,transparent 50%,var(--mcp-mut) 50%),linear-gradient(135deg,var(--mcp-mut) 50%,transparent 50%);background-position:calc(100% - 12px) 50%,calc(100% - 8px) 50%;background-size:4px 4px,4px 4px;background-repeat:no-repeat;cursor:pointer}
.dsh-mcp-market-filters select:focus{border-color:var(--mcp-accent)}
.dsh-mcp-market-filters label{display:inline-flex;align-items:center;gap:6px;cursor:pointer}
.dsh-mcp-market-filters input[type='checkbox']{width:14px;height:14px;margin:0;accent-color:var(--mcp-accent);cursor:pointer}
/* grid-auto-rows:1fr 让所有隐式行等高，否则行高 = 该行最高那张卡，跨行看就是「大小不一」。
   必须与 .dsh-mcp-mcard-desc 的截断一起用：不截断时最矮的卡会留出大片空白。 */
.dsh-mcp-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(min(268px,100%),1fr));gap:10px;align-content:start;grid-auto-rows:1fr}
.dsh-mcp-mcard{min-width:0;flex:none;box-sizing:border-box;display:flex;flex-direction:column;gap:9px;padding:13px 14px;border:1px solid var(--mcp-line);border-radius:var(--mcp-r-lg);background:var(--mcp-bg-1);transition:border-color .13s,background .13s}
.dsh-mcp-mcard:hover{border-color:var(--dsw-alias-border-l3);background:var(--dsw-alias-interactive-bg-hover)}
.dsh-mcp-mcard.installed{border-color:var(--dsw-alias-state-success-primary)}
.dsh-mcp-mcard-top{display:flex;align-items:flex-start;gap:9px}
.dsh-mcp-mcard-icon{width:30px;height:30px;flex:none;border-radius:var(--mcp-r-sm);background:var(--dsw-alias-interactive-bg-hover);color:var(--mcp-mut);display:flex;align-items:center;justify-content:center}
.dsh-mcp-mcard-main{flex:1;min-width:0}
.dsh-mcp-mcard-name{font-size:13px;font-weight:650;line-height:1.35;overflow-wrap:anywhere}
.dsh-mcp-mcard-meta{font-size:10.5px;color:var(--dsw-alias-label-tertiary);margin-top:2px;display:flex;align-items:center;gap:5px;flex-wrap:wrap}
/* 截断到 3 行（上游 summary 长度不受控，几千像素高的行就是这么来的）。
   ⚠️ **这里不能用 -webkit-line-clamp**：本元素是 .dsh-mcp-mcard（display:flex）的 flex item，
   Chrome 会把 flex item 上的 display:-webkit-box 块化成 flow-root，line-clamp 随之完全失效
   ——真机实测：源码写着 display:-webkit-box / line-clamp:3，computed display 却是 flow-root，
   长描述仍是 148px 高、一行没截。所以改用不依赖 display 的「行高 × 行数」截法：
   line-height 1.55 与 font-size 12px 都写在同一规则上，故 1.55em 就是一行，×3 恰好三行。
   全文出口由调用点的 title 提供，不能只截不留路。
   ⚠️ 本段在 MCP_CSS 这个**模板字符串**里：注释里不得出现反引号（会直接把字符串截断，
   详见本文件上方那条同类记录），类名与属性一律不加引号。 */
.dsh-mcp-mcard-desc{font-size:12px;line-height:1.55;color:var(--mcp-mut);flex:1 1 auto;max-height:calc(1.55em * 3);overflow:hidden}
.dsh-mcp-mcard-tags{display:flex;align-items:center;gap:5px;flex-wrap:wrap}
.dsh-mcp-mcard-access{font-size:10.5px;color:var(--mcp-mut);line-height:1.45;overflow-wrap:anywhere}
.dsh-mcp-mcard-note{font-size:10.5px;line-height:1.45;color:var(--mcp-warn);overflow-wrap:anywhere}
.dsh-mcp-mcard-vars{display:flex;flex-direction:column;gap:2px;font-size:10.5px;line-height:1.45;color:var(--dsw-alias-brand-text);overflow-wrap:anywhere}
.dsh-mcp-mcard-foot{display:flex;align-items:center;justify-content:space-between;gap:8px;border-top:1px solid var(--mcp-line);padding-top:9px}
.dsh-mcp-mcard-stat{font-size:10.5px;color:var(--dsw-alias-label-tertiary)}
.dsh-mcp-mcard-stat.err{color:var(--mcp-err)}
.dsh-mcp-mcard-actions{display:flex;gap:7px;align-items:center;flex:none}
.dsh-mcp-market-empty{grid-column:1 / -1;padding:40px 20px;text-align:center;color:var(--mcp-mut);font-size:13px}
@keyframes mcpPop{from{opacity:0;transform:scale(.98) translateY(4px)}to{opacity:1;transform:scale(1) translateY(0)}}
@keyframes mcpFade{from{opacity:0}to{opacity:1}}
.dsh-mcp-tabs-wrap{position:relative;flex:none;min-width:0}.dsh-mcp-tabs{display:flex;gap:6px;align-items:center;overflow-x:auto;scrollbar-width:none;padding:2px 0}.dsh-mcp-tabs::-webkit-scrollbar{display:none}.dsh-mcp-tab{display:inline-flex;align-items:center;gap:6px;padding:4px 11px;border-radius:999px;corner-shape:round;border:1px solid var(--mcp-line);background:var(--mcp-bg-1);color:var(--mcp-mut);font-size:12px;cursor:pointer;flex:none;white-space:nowrap;transition:background .13s,border-color .13s,color .13s;line-height:1.4}.dsh-mcp-tab:hover{background:var(--dsw-alias-interactive-bg-hover);border-color:var(--dsw-alias-border-l3)}.dsh-mcp-tab.sel{color:var(--dsw-alias-label-primary);border-color:var(--mcp-accent);background:var(--dsw-alias-interactive-bg-hover-accent);font-weight:600}.dsh-mcp-tab-count{font-size:10px;font-weight:500;padding:0 6px;border-radius:999px;background:var(--mcp-line);color:var(--mcp-mut);line-height:15px;corner-shape:round}.dsh-mcp-tab.more.open{color:var(--dsw-alias-label-primary);border-color:var(--mcp-accent);background:var(--dsw-alias-interactive-bg-hover-accent)}.dsh-mcp-tab-pop{position:absolute;top:calc(100% + 5px);right:0;z-index:60;background:var(--mcp-bg-2);border:0;border-radius:var(--mcp-r-lg);box-shadow:var(--dsw-elevation-panel);padding:6px;display:flex;flex-direction:column;gap:2px;min-width:170px}
/* 弹层里的行复用 .dsh-mcp-tab，但它自带 padding+border 且是 content-box：width:100%
   会把内边距和边框再加一遍，整行比弹层宽出一圈而溢出（与下面 .dsh-mcp-entry-item 同一个坑）。 */
.dsh-mcp-tab-pop .dsh-mcp-tab{box-sizing:border-box;width:100%}.dsh-mcp-entry{position:relative;display:inline-flex}.dsh-mcp-entry-pop{left:auto;right:0;min-width:196px}
/* 菜单行不复用 .dsh-mcp-tab：那是标签 chip（content-box + 自带 padding/border），配上 width:100%
   会把内边距和边框再加一遍，整行比弹层宽出一圈而溢出。行自己的盒模型必须 border-box。 */
.dsh-mcp-entry-item{box-sizing:border-box;display:flex;align-items:center;width:100%;padding:7px 10px;border:1px solid transparent;border-radius:var(--mcp-r-sm);background:transparent;color:var(--mcp-mut);font-family:inherit;font-size:12px;line-height:1.4;text-align:left;white-space:nowrap;cursor:pointer;transition:background .13s,border-color .13s,color .13s}
.dsh-mcp-entry-item:hover{background:var(--dsw-alias-interactive-bg-hover)}
.dsh-mcp-entry-item.sel{border-color:var(--mcp-accent);background:var(--dsw-alias-interactive-bg-hover-accent);color:var(--dsw-alias-label-primary);font-weight:600}.dsh-mcp-ws-body{width:288px;min-width:248px;min-height:0;display:flex;flex-direction:column;gap:12px;overflow:hidden}.dsh-mcp-section{display:flex;flex-direction:column;gap:8px;min-height:0;border:1px solid var(--mcp-line);border-radius:var(--mcp-r-lg);background:var(--mcp-bg-2);padding:12px;overflow:hidden}.dsh-mcp-section.local{flex:1 1 auto;min-height:124px;max-height:none;border-color:var(--mcp-line)}.dsh-mcp-section-actions{display:flex;justify-content:flex-end;gap:4px;flex:none}.dsh-mcp-global-list{flex:1;display:flex;flex-direction:column;gap:3px;overflow-y:auto;min-height:52px;margin:0 -4px;padding:0 4px}
.dsh-mcp-item.muted{opacity:.52}
.dsh-mcp-item.muted:hover{opacity:.85}
.dsh-mcp-global-search{position:relative;flex:none}
.dsh-mcp-global-search svg{position:absolute;left:10px;top:50%;transform:translateY(-50%);opacity:.5}
.dsh-mcp-global-search input{width:100%;box-sizing:border-box;padding:7px 10px 7px 30px;border-radius:var(--mcp-r-sm);border:1px solid var(--mcp-line);background:var(--mcp-bg-1);color:var(--dsw-alias-label-primary);font-size:11.5px;outline:none;transition:border-color .15s}
.dsh-mcp-global-search input::placeholder{color:var(--mcp-mut)}
/* 项目 / 全局共享是来源导航，和右侧概览 / 工具页签使用同一条下划线语言。 */
.dsh-mcp-source-tabs{display:flex;gap:14px;flex:none;border-bottom:1px solid var(--mcp-line)}
.dsh-mcp-source-tabs button{display:flex;align-items:center;gap:6px;flex:1;justify-content:center;padding:6px 0 10px;border:0;border-bottom:2px solid transparent;background:transparent;color:var(--mcp-mut);font:inherit;font-size:12px;cursor:pointer}
.dsh-mcp-source-tabs button[aria-selected='true']{color:var(--dsw-alias-label-primary);font-weight:600;border-bottom-color:var(--mcp-accent)}
.dsh-mcp-source-tabs button span{font-size:10.5px;color:var(--mcp-mut);font-variant-numeric:tabular-nums}
.dsh-mcp-source-tabs button:focus-visible{outline:1px solid var(--mcp-accent);outline-offset:-2px}
/* 折叠指示器：一个图标、一个方向。
   曾经三处各写一套（列表里的三角字符、组头的常驻三角 + CSS 旋转、诊断组头的感叹号），
   同一个「可展开」长得不一样不好认。收起态统一转 -90°。 */
.dsh-mcp-caret{display:inline-flex;align-items:center;justify-content:center;flex:none;width:14px;color:var(--mcp-mut);transition:transform .12s}
.dsh-mcp-caret.closed{transform:rotate(-90deg)}
.dsh-mcp-eye{box-sizing:border-box;width:30px;height:26px;flex:none;padding:0;display:inline-flex;align-items:center;justify-content:center;border:1px solid var(--mcp-line);border-radius:var(--mcp-r-sm);background:var(--dsw-alias-button-elevated-fill);color:var(--mcp-mut);cursor:pointer;transition:color .12s,border-color .12s,background .12s}
.dsh-mcp-eye:hover{color:var(--dsw-alias-label-primary);border-color:var(--mcp-accent)}
.dsh-mcp-eye.off{color:var(--mcp-err);border-color:var(--mcp-err);background:var(--dsw-alias-interactive-bg-hover-danger)}
.dsh-mcp-eye:disabled{opacity:.5;cursor:not-allowed}
/* ── 通知条（让位 / 降级 / 更新 / 读取失败）──────────────────────────────
   统一成一张三色卡片：中性（无色调）| warn | err | info。进 wrap 的纵向流、
   不挤头部，所以 Tab 行的位置不会因为「有没有通知」而上下跳。
   位置放在 head 之后、第二行之前：先说明状态，再给操作。 */
.dsh-mcp-notice{display:flex;align-items:flex-start;gap:10px;flex:none;padding:10px 12px;border-radius:var(--mcp-r-lg);border:1px solid var(--mcp-line);background:var(--mcp-bg-1);color:var(--dsw-alias-label-primary);font-family:var(--dsw-font-family,inherit);font-size:12px}
.dsh-mcp-notice>svg{flex:none;margin-top:1px}
.dsh-mcp-notice-body{flex:1;min-width:0;display:flex;flex-direction:column;gap:3px}
.dsh-mcp-notice-body b{font-size:12.5px}
.dsh-mcp-notice-body span{color:var(--mcp-mut);line-height:18px;overflow-wrap:anywhere}
.dsh-mcp-notice.warn{border-color:var(--mcp-warn);background:var(--dsw-alias-state-warn-tertiary)}
.dsh-mcp-notice.warn>svg{color:var(--mcp-warn)}
.dsh-mcp-notice.err{border-color:var(--mcp-err);background:var(--dsw-alias-interactive-bg-hover-danger)}
.dsh-mcp-notice.err>svg{color:var(--mcp-err)}
.dsh-mcp-notice.info{border-color:var(--mcp-info);background:var(--dsw-alias-state-business-tertiary)}
.dsh-mcp-notice.info>svg{color:var(--mcp-info)}
.dsh-mcp-notice-actions{display:flex;gap:6px;flex:none;align-items:center}
/* 让位提示不在面板里（它渲染在入口被占的位置），所以要自带定位与抬升。 */
.dsh-mcp-notice-dock{max-width:520px;margin:14px;box-shadow:var(--dsw-elevation-panel)}
/* 一键升级按钮：与 .dsh-mcp-btn.primary 同令牌，但更小——它长在提示条里，不该抢面板主操作的视觉权重。 */
/* 左侧栏底部入口（sidebar.footer.action）：与 DSH 侧栏底部其它控件同规格——
   展开态是 42px 行（图标 + 文字），收起轨道是 36px 圆钮（仅图标）。 */
.dsh-mcp-footer-action{display:inline-flex;align-items:center;gap:8px;width:100%;height:42px;box-sizing:border-box;margin:0 -2px;padding:0 10px 0 8px;border:none;border-radius:var(--mcp-r-md);background:transparent;color:var(--dsw-alias-label-primary);font-family:inherit;font-size:14px;cursor:pointer;transition:background .15s}
.dsh-mcp-footer-action:hover{background:var(--dsw-alias-interactive-bg-hover)}
.dsh-mcp-footer-action:active{background:var(--dsw-alias-interactive-bg-active)}
.dsh-mcp-footer-action.rail{justify-content:center;gap:0;width:36px;height:36px;margin:0;padding:0;border-radius:50%;corner-shape:round}
.dsh-mcp-footer-name{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
/* 响应式覆盖必须位于全部基础规则之后：同特异性下后出现者胜出。 */
@media (max-width:760px){.dsh-mcp-panel-overlay{padding:10px}.dsh-mcp-panel{max-width:none;width:100%;height:calc(100dvh - 20px);border-radius:var(--mcp-r-panel)}.dsh-mcp-panel .dsh-mcp-wrap{padding:12px}.dsh-mcp-head{align-items:flex-start}.dsh-mcp-body{flex-direction:column;overflow-y:auto;overflow-x:hidden}.dsh-mcp-side,.dsh-mcp-ws-body{width:auto;min-width:0;max-height:none;flex:none}.dsh-mcp-side:not(.embedded) .dsh-mcp-list{max-height:38vh}.dsh-mcp-section.local{flex:none;min-height:0;max-height:none}.dsh-mcp-section.local .dsh-mcp-list{max-height:30vh}.dsh-mcp-global-list{max-height:30vh}.dsh-mcp-detail{padding:12px;flex:none;overflow:visible}.dsh-mcp-d-body{overflow:visible}.dsh-mcp-d-title{flex:none}.dsh-mcp-d-head{flex-direction:column}.dsh-mcp-kv-edit{grid-template-columns:minmax(90px,35%) minmax(0,1fr) auto}}
/* 窄屏：标题与关闭留在第一行，能力层与操作区各占一整行。
   ⚠️ 必须显式钉每一样东西的行列。四列 grid 退成两列后，自动排布会把「关闭」挤到第二行
   （子元素顺序是 标题→能力层→操作区→关闭），而「关闭」在任何宽度下都该在右上角。 */
@media (max-width:900px){.dsh-mcp-head{grid-template-columns:minmax(0,1fr) auto}.dsh-mcp-title{grid-row:1;grid-column:1}.dsh-mcp-head>.dsh-mcp-btn{grid-row:1;grid-column:2}.dsh-mcp-head>.dsh-mcp-seg{grid-row:2;grid-column:1}.dsh-mcp-head-actions{grid-row:3;grid-column:1 / -1;justify-content:flex-start}.dsh-mcp-sub{height:auto;min-height:32px;grid-template-columns:minmax(0,1fr)}.dsh-mcp-sub-scope{grid-row:2}.dsh-mcp-runtime{grid-row:3}.dsh-mcp-market-scope{max-width:100%}.dsh-mcp-market-scope select{min-width:0;max-width:100%;flex:1}.dsh-mcp-market-tools .dsh-mcp-search{min-width:0}}
@media (max-width:480px){.dsh-mcp-head{grid-template-columns:minmax(0,1fr) auto}.dsh-mcp-title{grid-row:1;grid-column:1}.dsh-mcp-head>.dsh-mcp-btn{grid-row:1;grid-column:2}.dsh-mcp-head>.dsh-mcp-seg{grid-row:2;grid-column:1 / -1}.dsh-mcp-head-actions{grid-row:3;grid-column:1 / -1;width:100%;justify-content:flex-start}.dsh-mcp-btn{padding:7px 9px}.dsh-mcp-radio-row,.dsh-mcp-number-grid{grid-template-columns:1fr}.dsh-mcp-modal{max-width:none;width:100%;padding:0}.dsh-mcp-modal-head{padding:16px}.dsh-mcp-modal-body{padding:0 16px 16px}.dsh-mcp-modal-actions{padding:12px 16px}.dsh-mcp-kv{grid-template-columns:1fr;gap:4px}.dsh-mcp-kv>b{margin-top:4px}.dsh-mcp-secret-row{grid-template-columns:1fr;gap:4px}.dsh-mcp-secret{width:100%}.dsh-mcp-kv-edit{grid-template-columns:1fr auto}.dsh-mcp-kv-edit input:first-child{grid-column:1 / -1}.dsh-mcp-tool{flex-direction:column}.dsh-mcp-tool-name{max-width:100%}.dsh-mcp-tool-desc{white-space:normal}.dsh-mcp-tool-head{grid-template-columns:minmax(0,1fr) auto}.dsh-mcp-tool-head select{grid-column:1 / -1;width:100%}}
/* 动效约定：宿主官方客户端包普遍在 prefers-reduced-motion 下关掉过渡与弹入动画
   （ui-* 包 46 处 @media，另有若干 JS 侧 matchMedia 判定）。这里关掉缩放弹入与过渡；
   .dsh-mcp-dot.loading 的呼吸只改透明度、且是「正在连接」的状态线索，故保留。
   ⚠️ 本注释在模板字符串内部：不得出现反引号。 */
@media (prefers-reduced-motion:reduce){.dsh-mcp-panel,.dsh-mcp-whatsnew,.dsh-mcp-modal,.dsh-mcp-toast,.dsh-mcp-fab{animation:none}.dsh-mcp-wrap *,.dsh-mcp-panel-overlay *,.dsh-mcp-overlay *,.dsh-mcp-fab,.dsh-mcp-toggle::after{transition:none}}
`;

// ── Skills（能力层第二面）样式 ────────────────────────────────────────────────
//
// ⚠️ 本常量**不得**声明 --mcp-* 别名：别名层的唯一宿主是 MCP_CSS 里那个 body 规则。
// 自定义属性在**声明处**完成替换，所以第二处 body 声明会整体覆盖前一处（顺序靠后者胜），
// 一半界面会取到空值。这里只**消费**已声明的别名（有测试守着）。
//
// ⚠️ 注入必须与 MCP_CSS **合并成一次** __injectCss 调用：那个函数的 id 与 data-plugin-css
// 是写死的 'dsh-toolbox-ui/mcp.css'，以同一 id 二次调用会复用同一个 <style> 并覆写
// textContent——skills 样式会把 MCP 面板样式静默冲掉（不报错，只是面板变形）。
//
// 类名统一 dsh-skills-* 前缀：与 dsh-mcp-* 分开，两者各自的扫描器（theme-contract 的
// 「每个渲染出来的类都要有样式」）才不会互相误判，也便于一眼看出哪块属于哪个能力面。
const SKILLS_CSS = `.dsh-skills-root{display:flex;flex-direction:column;min-height:0;flex:1;gap:0}
.dsh-skills-sec{font-size:12px;line-height:18px;font-weight:600;color:var(--dsw-alias-label-primary);margin:14px 0 6px}
.dsh-skills-meta{display:grid;grid-template-columns:96px minmax(0,1fr);gap:4px 10px;font-size:12px;line-height:18px}
.dsh-skills-meta dt{color:var(--mcp-mut);margin:0}
.dsh-skills-meta dd{margin:0;color:var(--dsw-alias-label-primary);word-break:break-all}
.dsh-skills-pre{flex:none;margin:0;padding:14px;border-radius:var(--mcp-r-sm);background:var(--mcp-bg-1);border:.5px solid var(--mcp-line);font-family:var(--mcp-mono);font-size:12px;line-height:18px;color:var(--dsw-alias-label-primary);overflow:visible;white-space:pre-wrap;word-break:break-word}
/* 作用域组头：占满列表整行，所以路径放得下（这正是它取代筛选下拉的理由）。
   超长走 ellipsis，完整根路径在 title 里兜底。 */
.dsh-skills-group{display:flex;align-items:center;gap:6px;width:100%;box-sizing:border-box;margin:8px 0 3px;padding:5px 6px;border:0;border-radius:var(--mcp-r-sm);background:transparent;color:var(--mcp-mut);font-family:inherit;font-size:11px;font-weight:600;letter-spacing:.1px;text-align:left;cursor:pointer}
.dsh-skills-group:first-child{margin-top:0}
.dsh-skills-group:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}
.dsh-skills-group.static{cursor:default}
.dsh-skills-group.static:hover{background:transparent;color:var(--mcp-mut)}
/* 组头只定宽度；收起态的旋转由 .dsh-mcp-caret.closed 一处负责（别再写第二条旋转规则）。 */
.dsh-skills-group-caret{flex:none;width:12px}
.dsh-skills-group-label{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dsh-skills-group-count{flex:none;padding:0 6px;border-radius:999px;corner-shape:round;background:var(--mcp-line);color:var(--mcp-mut);line-height:15px;font-size:10px}
.dsh-skills-risk{border-radius:var(--mcp-r-lg);border:.5px solid var(--mcp-line);background:var(--mcp-bg-2);padding:10px;margin:10px 0}
.dsh-skills-risk-h{display:flex;align-items:center;gap:8px;font-size:12px;line-height:18px;font-weight:600;color:var(--dsw-alias-label-primary);margin-bottom:8px}
.dsh-skills-risk-row{display:flex;gap:10px;font-size:12px;line-height:18px;padding:3px 0;align-items:flex-start}
.dsh-skills-risk-row .k{flex:none;width:104px;color:var(--mcp-mut)}
/* 风险行左列有时带一个图标（如「声明不一致」的警示）。图标是行内 svg，靠 baseline 对齐会偏低。 */
.dsh-skills-risk-row .k svg{vertical-align:-2px;margin-right:3px}
.dsh-skills-risk-row .v{flex:1;min-width:0;color:var(--dsw-alias-label-primary)}
/* 红绿灯的文字承载：颜色不能是唯一载体（无障碍 + 「这点点是咋回事」的直接答案）。
   每个风险档一条自己的文字规则，卡片底栏按档位挑一条用。 */
.dsh-skills-blocked{color:var(--mcp-err);font-weight:600}
.dsh-skills-warn{color:var(--mcp-warn)}
/* 「安装时创建」：紧跟在路径后面，**不许在词组中间折行**（真机上被折成「安装时创/建」）。
   它自己占一行是可以的（选项窄的时候），所以只禁词内折行、不禁换行。 */
.dsh-skills-pending{color:var(--mcp-warn);font-weight:600;white-space:nowrap}
.dsh-skills-ack{display:flex;align-items:flex-start;gap:8px;font-size:12px;line-height:18px;padding:8px 0;color:var(--dsw-alias-label-primary);cursor:pointer}
.dsh-skills-ack input{margin:2px 0 0;flex:none;accent-color:var(--mcp-accent)}
.dsh-skills-note{padding:10px 12px;font-size:12px;line-height:18px;color:var(--mcp-mut);border-top:.5px solid var(--mcp-line);flex:none}
/* 市场翻页区：按钮居中。滚动到底的自动加载挂在 .dsh-mcp-market-view 的 onScroll 上。 */
.dsh-skills-hub-more{display:flex;justify-content:center;padding:4px 0 10px;flex:none}
/* 外部源的「上游页面」链接：与插件其余链接同一套（品牌色 + hover 下划线），
   不在弹窗里引入第二种链接样式。 */
.dsh-skills-link{color:var(--mcp-accent);text-decoration:none;word-break:break-all}
.dsh-skills-link:hover{text-decoration:underline}
.dsh-skills-empty{display:flex;flex:1;align-items:center;justify-content:center;padding:32px 16px;font-size:12px;line-height:18px;color:var(--mcp-mut);text-align:center}

/* ⚠️ 拼表顺序是契约的一部分：将来要加规则前先读这段。
   这两张样式表按 MCP_CSS → SKILLS_CSS 的顺序**拼成一张**（apply 里那一次 __injectCss），
   所以同特异性下 SKILLS_CSS 天然压过 MCP_CSS——而这件事在源码里完全看不出来。
   两次真机事故都出自这里：
     · .dsh-mcp-pane-off 被后面那条 .dsh-mcp-card{display:flex} 压掉 → 三个页签同时显示；
     · 外壳对齐块接在 MCP_CSS 末尾 → 圆角与选中背景根本没生效。
   现在的做法是**不留跨表覆盖块**：所有原语都在自己那张表的定义处一次写对
   （.dsh-mcp-tab 的药丸、.dsh-mcp-d-empty 的成块、分段控件都回了 MCP_CSS）。
   将来若确实需要覆盖 MCP_CSS，覆盖块只能放在**本常量最末尾**，并在这里写明为什么。
   另：整张样式表是模板字符串，注释里不得出现反引号。 */
`;

const h = React2.createElement;

