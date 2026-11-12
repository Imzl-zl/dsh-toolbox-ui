const McpOverlay = ({ call, callSkills, timer, pluginManager }) => {
  const open = usePanelOpen();
  const mode = useEntryMode();
  const seats = overlaySeats(mode, open);
  const [pos, setPos] = useState(() => readFabPos() || defaultFabPos());
  const fabRef = useRef(null);
  const dragRef = useRef(null);
  const suppressClickRef = useRef(false);

  // 文案层补接：apply 时 locale 服务可能还没 provide（桌面壳的原生桥让它的 apply
  // 变成异步的）。面板挂载是第一个「宿主肯定已启动完」的时刻，在这里补接——
  // 词典注册会 bump revision，已挂载的 outlet 自动重渲染，语言当即跟上。
  useEffect(() => { ensureLocaleWired() }, []);

  // 窗口尺寸变化时把按钮拉回可视区，避免记忆的位置因分辨率变化而出界。
  // 悬浮按钮被偏好关掉时不订阅：给一个看不见的按钮算位置只是白渲染。
  useEffect(() => {
    if (!ENTRY_VISIBILITY[mode].fab) return;
    const onResize = () => setPos((current) => clampFabPos(current.x, current.y));
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, [mode]);

  const handlePointerDown = (event) => {
    if (event.button !== undefined && event.button !== 0) return;
    const el = fabRef.current;
    if (!el) return;
    // 起始位置取 state 的 left/top（而非 getBoundingClientRect），避免 :hover 的 scale
    // 微移左上角带来的几像素误差。
    dragRef.current = {
      startClientX: event.clientX,
      startClientY: event.clientY,
      startX: pos.x,
      startY: pos.y,
      live: { x: pos.x, y: pos.y },
      moved: false,
    };
    try { el.setPointerCapture(event.pointerId); } catch { /* 忽略不支持捕获的环境 */ }
  };
  const handlePointerMove = (event) => {
    const drag = dragRef.current;
    const el = fabRef.current;
    if (!drag || !el) return;
    const dx = event.clientX - drag.startClientX;
    const dy = event.clientY - drag.startClientY;
    if (!drag.moved && Math.hypot(dx, dy) < DRAG_THRESHOLD) return;
    drag.moved = true;
    drag.live = clampFabPos(drag.startX + dx, drag.startY + dy);
    // 跟手：直接写 DOM，不触发 React 渲染；松手时才 setPos 提交。
    el.style.left = drag.live.x + 'px';
    el.style.top = drag.live.y + 'px';
    el.style.cursor = 'grabbing';
  };
  const handlePointerEnd = () => {
    const drag = dragRef.current;
    dragRef.current = null;
    if (fabRef.current) fabRef.current.style.cursor = '';
    if (!drag) return;
    if (drag.moved) {
      // 拖动收尾：吞掉紧随其后的 click，避免「拖动后误打开面板」；提交位置 + 落盘。
      suppressClickRef.current = true;
      setTimeout(() => { suppressClickRef.current = false; }, 0);
      setPos(drag.live);
      saveFabPos(drag.live);
    }
  };
  const handleClick = () => {
    if (suppressClickRef.current) { suppressClickRef.current = false; return; }
    panelVisibility.set(true);
  };

  const style = { left: pos.x + 'px', top: pos.y + 'px', right: 'auto', bottom: 'auto' };

  return h(
    React2.Fragment,
    null,
    seats.panel ? h(McpTab, { call, callSkills, timer, pluginManager, onClose: () => panelVisibility.set(false), floating: true }) : null,
    seats.fab ? h(
      'button',
      {
        ref: fabRef,
        type: 'button',
        className: 'dsh-mcp-fab',
        title: t('工具箱面板（可拖拽移动）'),
        'aria-label': t('打开工具箱面板'),
        'aria-expanded': false,
        style,
        onClick: handleClick,
        onPointerDown: handlePointerDown,
        onPointerMove: handlePointerMove,
        onPointerUp: handlePointerEnd,
        onPointerCancel: handlePointerEnd,
      },
      h(Icon, { d: ICONS.panel, size: 20 }),
    ) : null,
  );
};

function createTimer() {
  const timeouts = new Set();
  const intervals = new Set();
  return {
    timeout(fn, ms) {
      const id = setTimeout(() => {
        timeouts.delete(id);
        fn();
      }, ms);
      timeouts.add(id);
      return () => {
        clearTimeout(id);
        timeouts.delete(id);
      };
    },
    interval(fn, ms) {
      const id = setInterval(fn, ms);
      intervals.add(id);
      return () => {
        clearInterval(id);
        intervals.delete(id);
      };
    },
    dispose() {
      for (const id of timeouts) clearTimeout(id);
      for (const id of intervals) clearInterval(id);
      timeouts.clear();
      intervals.clear();
    },
  };
}

// strict codec 与 lib/typert.js 是同一份契约的两份产物：宿主 loader 校验 host 那份，
// typert-registry 的**浏览器半**校验这份，两边规则一致而两个渠道查不同的键——
//   0.1.5-rc.x（= 当时 latest/next，npx 默认装到的那条）查 `codec.schema.parse`；
//   0.1.6-alpha.2 起查 `typeof codec.create === 'function'` 并用它物化 schema。
// 所以两个键都写（少写一半就是「面板能加载、一调用就炸」或「加载即拒」）。
// 浏览器侧不需要 zod：宿主只要求 create() 返回带 parse 的 schema。两处必须一起改。
const ANY_VALUE_SCHEMA = { parse: (v) => v };
const STRING_SCHEMA = { parse: (v) => { if (typeof v !== 'string') throw new TypeError('Expected string'); return v; } };
function strictCodec(symbol, schema) {
  return { mode: 'strict', typeSymbol: 'dsh-toolbox-ui/typert#' + symbol, schema: schema, create: () => schema };
}
function mcpCodec(m) { return strictCodec(m, ANY_VALUE_SCHEMA); }
function mcpParam(name, sym) { return { name: name, wire: name, source: 'json', codec: strictCodec(sym, sym === 'String' ? STRING_SCHEMA : ANY_VALUE_SCHEMA) }; }
// skills 侧：id/service/namespace 三处都必须写 skillsManager，且必须与 lib/typert.js 的
// mvs() 逐字节一致（test/client-lifecycle.test.mjs 会 deepEqual 两侧）。
// 三个 Skills* 结果码复用 ANY_VALUE_SCHEMA：与 MCP 侧同一策略（宿主只要求 create() 返回带
// parse 的 schema，真正校验在宿主的 TYPERT 那份 zod 上）。
function skParam(name, sym) { return { name: name, wire: name, source: 'json', codec: strictCodec(sym, ANY_VALUE_SCHEMA) }; }
function sk(method, parameters, resultSym) {
  return {
    id: 'dsh-toolbox-ui#skillsManager/' + method,
    service: 'skillsManager',
    namespace: 'skillsManager',
    method: method,
    invocation: { kind: 'direct' },
    parameters: parameters,
    result: mcpCodec(resultSym),
  };
}
const MCP_CONTRIBUTION = {
  package: 'dsh-toolbox-ui',
  descriptors: [
    // <rpc-contract:begin> 由 scripts/rpc-contract.mjs 生成，勿手改
    { id: 'dsh-toolbox-ui#toolboxMcp/list', service: 'toolboxMcp', namespace: 'toolboxMcp', method: 'list', invocation: { kind: 'direct' }, parameters: [], result: mcpCodec('ListResult') },
    { id: 'dsh-toolbox-ui#toolboxMcp/status', service: 'toolboxMcp', namespace: 'toolboxMcp', method: 'status', invocation: { kind: 'direct' }, parameters: [mcpParam('name', 'String')], result: mcpCodec('StatusResult') },
    { id: 'dsh-toolbox-ui#toolboxMcp/enable', service: 'toolboxMcp', namespace: 'toolboxMcp', method: 'enable', invocation: { kind: 'direct' }, parameters: [mcpParam('name', 'String')], result: mcpCodec('NoteResult') },
    { id: 'dsh-toolbox-ui#toolboxMcp/disable', service: 'toolboxMcp', namespace: 'toolboxMcp', method: 'disable', invocation: { kind: 'direct' }, parameters: [mcpParam('name', 'String')], result: mcpCodec('NoteResult') },
    { id: 'dsh-toolbox-ui#toolboxMcp/reconnect', service: 'toolboxMcp', namespace: 'toolboxMcp', method: 'reconnect', invocation: { kind: 'direct' }, parameters: [mcpParam('name', 'String')], result: mcpCodec('NoteResult') },
    { id: 'dsh-toolbox-ui#toolboxMcp/tools', service: 'toolboxMcp', namespace: 'toolboxMcp', method: 'tools', invocation: { kind: 'direct' }, parameters: [mcpParam('payload', 'ImportPayload')], result: mcpCodec('ToolsResult') },
    { id: 'dsh-toolbox-ui#toolboxMcp/builtins', service: 'toolboxMcp', namespace: 'toolboxMcp', method: 'builtins', invocation: { kind: 'direct' }, parameters: [], result: mcpCodec('BuiltinCatalogResult') },
    { id: 'dsh-toolbox-ui#toolboxMcp/installBuiltins', service: 'toolboxMcp', namespace: 'toolboxMcp', method: 'installBuiltins', invocation: { kind: 'direct' }, parameters: [mcpParam('payload', 'BuiltinInstallPayload')], result: mcpCodec('BuiltinInstallResult') },
    { id: 'dsh-toolbox-ui#toolboxMcp/add', service: 'toolboxMcp', namespace: 'toolboxMcp', method: 'add', invocation: { kind: 'direct' }, parameters: [mcpParam('spec', 'Spec')], result: mcpCodec('NoteResult') },
    { id: 'dsh-toolbox-ui#toolboxMcp/update', service: 'toolboxMcp', namespace: 'toolboxMcp', method: 'update', invocation: { kind: 'direct' }, parameters: [mcpParam('spec', 'Spec')], result: mcpCodec('NoteResult') },
    { id: 'dsh-toolbox-ui#toolboxMcp/removeServer', service: 'toolboxMcp', namespace: 'toolboxMcp', method: 'removeServer', invocation: { kind: 'direct' }, parameters: [mcpParam('name', 'String')], result: mcpCodec('NoteResult') },
    { id: 'dsh-toolbox-ui#toolboxMcp/setDeferAll', service: 'toolboxMcp', namespace: 'toolboxMcp', method: 'setDeferAll', invocation: { kind: 'direct' }, parameters: [mcpParam('payload', 'DeferAllPayload')], result: mcpCodec('DeferAllResult') },
    { id: 'dsh-toolbox-ui#toolboxMcp/setDefer', service: 'toolboxMcp', namespace: 'toolboxMcp', method: 'setDefer', invocation: { kind: 'direct' }, parameters: [mcpParam('payload', 'DeferPayload')], result: mcpCodec('NoteResult') },
    { id: 'dsh-toolbox-ui#toolboxMcp/toolSearchSettings', service: 'toolboxMcp', namespace: 'toolboxMcp', method: 'toolSearchSettings', invocation: { kind: 'direct' }, parameters: [], result: mcpCodec('ToolSearchSettings') },
    { id: 'dsh-toolbox-ui#toolboxMcp/updateToolSearchSettings', service: 'toolboxMcp', namespace: 'toolboxMcp', method: 'updateToolSearchSettings', invocation: { kind: 'direct' }, parameters: [mcpParam('payload', 'ToolSearchSettingsPayload')], result: mcpCodec('ToolSearchSettings') },
    { id: 'dsh-toolbox-ui#toolboxMcp/toolLoadingSettings', service: 'toolboxMcp', namespace: 'toolboxMcp', method: 'toolLoadingSettings', invocation: { kind: 'direct' }, parameters: [], result: mcpCodec('ToolLoadingSettings') },
    { id: 'dsh-toolbox-ui#toolboxMcp/updateToolLoadingSettings', service: 'toolboxMcp', namespace: 'toolboxMcp', method: 'updateToolLoadingSettings', invocation: { kind: 'direct' }, parameters: [mcpParam('payload', 'ToolLoadingPayload')], result: mcpCodec('ToolLoadingSettings') },
    { id: 'dsh-toolbox-ui#toolboxMcp/workspaceToolLoading', service: 'toolboxMcp', namespace: 'toolboxMcp', method: 'workspaceToolLoading', invocation: { kind: 'direct' }, parameters: [mcpParam('payload', 'ToolLoadingPayload')], result: mcpCodec('ToolLoadingSettings') },
    { id: 'dsh-toolbox-ui#toolboxMcp/setWorkspaceToolLoading', service: 'toolboxMcp', namespace: 'toolboxMcp', method: 'setWorkspaceToolLoading', invocation: { kind: 'direct' }, parameters: [mcpParam('payload', 'ToolLoadingPayload')], result: mcpCodec('ToolLoadingSettings') },
    { id: 'dsh-toolbox-ui#toolboxMcp/reveal', service: 'toolboxMcp', namespace: 'toolboxMcp', method: 'reveal', invocation: { kind: 'direct' }, parameters: [mcpParam('payload', 'ImportPayload')], result: mcpCodec('RevealResult') },
    { id: 'dsh-toolbox-ui#toolboxMcp/previewImport', service: 'toolboxMcp', namespace: 'toolboxMcp', method: 'previewImport', invocation: { kind: 'direct' }, parameters: [mcpParam('payload', 'ImportPayload')], result: mcpCodec('ImportPreview') },
    { id: 'dsh-toolbox-ui#toolboxMcp/importJson', service: 'toolboxMcp', namespace: 'toolboxMcp', method: 'importJson', invocation: { kind: 'direct' }, parameters: [mcpParam('payload', 'ImportPayload')], result: mcpCodec('ImportResult') },
    { id: 'dsh-toolbox-ui#toolboxMcp/scanImportSources', service: 'toolboxMcp', namespace: 'toolboxMcp', method: 'scanImportSources', invocation: { kind: 'direct' }, parameters: [mcpParam('payload', 'ImportPayload')], result: mcpCodec('ImportSourcesResult') },
    { id: 'dsh-toolbox-ui#toolboxMcp/previewImportSource', service: 'toolboxMcp', namespace: 'toolboxMcp', method: 'previewImportSource', invocation: { kind: 'direct' }, parameters: [mcpParam('payload', 'ImportPayload')], result: mcpCodec('ImportPreview') },
    { id: 'dsh-toolbox-ui#toolboxMcp/importSource', service: 'toolboxMcp', namespace: 'toolboxMcp', method: 'importSource', invocation: { kind: 'direct' }, parameters: [mcpParam('payload', 'ImportPayload')], result: mcpCodec('ImportResult') },
    { id: 'dsh-toolbox-ui#toolboxMcp/listWorkspaces', service: 'toolboxMcp', namespace: 'toolboxMcp', method: 'listWorkspaces', invocation: { kind: 'direct' }, parameters: [], result: mcpCodec('WorkspaceListResult') },
    { id: 'dsh-toolbox-ui#toolboxMcp/getWorkspaceView', service: 'toolboxMcp', namespace: 'toolboxMcp', method: 'getWorkspaceView', invocation: { kind: 'direct' }, parameters: [mcpParam('payload', 'ImportPayload')], result: mcpCodec('WorkspaceViewResult') },
    { id: 'dsh-toolbox-ui#toolboxMcp/addWorkspaceServer', service: 'toolboxMcp', namespace: 'toolboxMcp', method: 'addWorkspaceServer', invocation: { kind: 'direct' }, parameters: [mcpParam('payload', 'ImportPayload')], result: mcpCodec('NoteResult') },
    { id: 'dsh-toolbox-ui#toolboxMcp/updateWorkspaceServer', service: 'toolboxMcp', namespace: 'toolboxMcp', method: 'updateWorkspaceServer', invocation: { kind: 'direct' }, parameters: [mcpParam('payload', 'ImportPayload')], result: mcpCodec('NoteResult') },
    { id: 'dsh-toolbox-ui#toolboxMcp/removeWorkspaceServer', service: 'toolboxMcp', namespace: 'toolboxMcp', method: 'removeWorkspaceServer', invocation: { kind: 'direct' }, parameters: [mcpParam('payload', 'ImportPayload')], result: mcpCodec('NoteResult') },
    { id: 'dsh-toolbox-ui#toolboxMcp/setWorkspaceExclude', service: 'toolboxMcp', namespace: 'toolboxMcp', method: 'setWorkspaceExclude', invocation: { kind: 'direct' }, parameters: [mcpParam('payload', 'ImportPayload')], result: mcpCodec('NoteResult') },
    { id: 'dsh-toolbox-ui#toolboxMcp/installWorkspaceBuiltins', service: 'toolboxMcp', namespace: 'toolboxMcp', method: 'installWorkspaceBuiltins', invocation: { kind: 'direct' }, parameters: [mcpParam('payload', 'BuiltinInstallPayload')], result: mcpCodec('BuiltinInstallResult') },
    { id: 'dsh-toolbox-ui#toolboxMcp/previewWorkspaceImport', service: 'toolboxMcp', namespace: 'toolboxMcp', method: 'previewWorkspaceImport', invocation: { kind: 'direct' }, parameters: [mcpParam('payload', 'ImportPayload')], result: mcpCodec('ImportPreview') },
    { id: 'dsh-toolbox-ui#toolboxMcp/importWorkspaceJson', service: 'toolboxMcp', namespace: 'toolboxMcp', method: 'importWorkspaceJson', invocation: { kind: 'direct' }, parameters: [mcpParam('payload', 'ImportPayload')], result: mcpCodec('ImportResult') },
    { id: 'dsh-toolbox-ui#toolboxMcp/copyWorkspaceServers', service: 'toolboxMcp', namespace: 'toolboxMcp', method: 'copyWorkspaceServers', invocation: { kind: 'direct' }, parameters: [mcpParam('payload', 'ImportPayload')], result: mcpCodec('WorkspaceCopyResult') },
    { id: 'dsh-toolbox-ui#toolboxMcp/previewWorkspaceCopy', service: 'toolboxMcp', namespace: 'toolboxMcp', method: 'previewWorkspaceCopy', invocation: { kind: 'direct' }, parameters: [mcpParam('payload', 'ImportPayload')], result: mcpCodec('WorkspaceCopyPreview') },
    { id: 'dsh-toolbox-ui#toolboxMcp/exportWorkspaceJson', service: 'toolboxMcp', namespace: 'toolboxMcp', method: 'exportWorkspaceJson', invocation: { kind: 'direct' }, parameters: [mcpParam('payload', 'ImportPayload')], result: mcpCodec('WorkspaceExportResult') },
    { id: 'dsh-toolbox-ui#toolboxMcp/exportGlobalJson', service: 'toolboxMcp', namespace: 'toolboxMcp', method: 'exportGlobalJson', invocation: { kind: 'direct' }, parameters: [], result: mcpCodec('WorkspaceExportResult') },
    { id: 'dsh-toolbox-ui#toolboxMcp/revealWorkspaceServer', service: 'toolboxMcp', namespace: 'toolboxMcp', method: 'revealWorkspaceServer', invocation: { kind: 'direct' }, parameters: [mcpParam('payload', 'ImportPayload')], result: mcpCodec('RevealResult') },
    { id: 'dsh-toolbox-ui#toolboxMcp/projectConnections', service: 'toolboxMcp', namespace: 'toolboxMcp', method: 'projectConnections', invocation: { kind: 'direct' }, parameters: [], result: mcpCodec('ProjectConnectionsResult') },
    { id: 'dsh-toolbox-ui#toolboxMcp/reconnectWorkspaceServer', service: 'toolboxMcp', namespace: 'toolboxMcp', method: 'reconnectWorkspaceServer', invocation: { kind: 'direct' }, parameters: [mcpParam('payload', 'ImportPayload')], result: mcpCodec('NoteResult') },
    { id: 'dsh-toolbox-ui#toolboxMcp/updateHint', service: 'toolboxMcp', namespace: 'toolboxMcp', method: 'updateHint', invocation: { kind: 'direct' }, parameters: [], result: mcpCodec('UpdateHintResult') },
    { id: 'dsh-toolbox-ui#toolboxMcp/whatsNew', service: 'toolboxMcp', namespace: 'toolboxMcp', method: 'whatsNew', invocation: { kind: 'direct' }, parameters: [], result: mcpCodec('WhatsNewResult') },
    sk('list', [skParam('payload', 'SkillPayload')], 'SkillListResult'),
    sk('detail', [skParam('payload', 'SkillPayload')], 'SkillDetailResult'),
    sk('setEnabled', [skParam('payload', 'SkillPayload')], 'SkillMutationResult'),
    sk('setModelInvocable', [skParam('payload', 'SkillPayload')], 'SkillMutationResult'),
    sk('setUserInvocable', [skParam('payload', 'SkillPayload')], 'SkillMutationResult'),
    sk('removeSkill', [skParam('payload', 'SkillPayload')], 'SkillMutationResult'),
    sk('importSkill', [skParam('payload', 'SkillPayload')], 'SkillMutationResult'),
    sk('skillTargets', [skParam('payload', 'SkillPayload')], 'SkillTargetsResult'),
    sk('skillHubSearch', [skParam('payload', 'SkillPayload')], 'SkillHubSearchResult'),
    sk('skillHubDetail', [skParam('payload', 'SkillPayload')], 'SkillHubDetailResult'),
    sk('skillHubCategories', [skParam('payload', 'SkillPayload')], 'SkillHubCategoriesResult'),
    sk('skillHubInstall', [skParam('payload', 'SkillPayload')], 'SkillMutationResult'),
    sk('conflictingManager', [], 'SkillConflictResult'),
    // <rpc-contract:end>
  ].map((descriptor) => ({ ...descriptor, sourceLocation: { file: 'dsh-toolbox-ui/lib/typert.js', line: 7, column: 1 } }))
};
async function apply(ctx) {
  const disposeMount = await ctx.remote.$mount(MCP_CONTRIBUTION);
  let disposeCss;
  let timer;
  // 文案层接线。**必须早于任何组件注册**：槽位一旦注册就会渲染，渲染时 t() 已经在用
  // localeT 了——晚接线会让首帧显示中文、切换后才变英文（闪一下）。
  // locale 服务不在时（没挂 dsh-client-locale）整段跳过，t() 退化成恒等，面板照常。
  //
  // ⚠️ 但「不在」可能只是**迟到**：桌面壳给 locale 插件的 apply 挂了原生桥
  // （`__DSH_LOCALE__.read()` 是异步的），它要先 await 才 provide；我们的 apply
  // 先跑完时 ctx.get('locale') 就是 null。真机表现：桌面版面板恒中文、在设置里
  // 切语言也不跟随（web 没有这座桥、同步 provide，所以 web 一直是好的）。
  // 不能改用 inject 声明依赖：宿主没有 locale 插件时 inject 会让 fiber 保持
  // inactive——整个面板直接不出现（见 docs/design.en.md 对 inject 的说明）。
  // 所以：apply 探一次；没探到就把 ctx 留下，面板首次挂载时重探——那一刻桌面壳的
  // 异步 provide 早已完成，而词典注册会 bump revision，已挂载的 outlet 自动重渲染。
  if (!wireLocale(ctx)) localeProbeCtx = ctx;
  let cleanupPromise;
  const cleanup = () => {
    cleanupPromise ??= (async () => {
      try {
        timer?.dispose();
      } finally {
        try {
          disposeCss?.();
        } finally {
          await disposeMount();
        }
      }
    })();
    return cleanupPromise;
  };

  try {
    // 让位检测（D15）放在**注册入口之前**：一旦注册了 slot，两个面板就会并存。
    // 检测失败一律视为「无冲突」（fail-open，SPEC 约束 10）——见 callSkills 的降级形态。
    let conflict = null;
    try {
      const svc = typeof ctx.get === 'function' ? ctx.get('remote.skillsManager') : null;
      if (svc && typeof svc.conflictingManager === 'function') {
        const probe = await svc.conflictingManager();
        const value = probe && probe.ok ? probe.value : probe;
        if (value && typeof value.name === 'string') conflict = value;
      }
    } catch {
      // 刻意吞掉：探测本身失败不得挡住面板（fail-open）。
      conflict = null;
    }
    // ⚠️ 必须**合并成一次**注入：__injectCss 的 id 与 data-plugin-css 写死为
    // 'dsh-toolbox-ui/mcp.css'，以同一 id 二次调用会复用同一个 <style> 标签并覆写
    // textContent——skills 样式会把 MCP 面板样式静默冲掉（不报错，只是面板变形）。
    // 合并同时也让 client-lifecycle 的 document.styles.length === 1 断言继续成立。
    disposeCss = __injectCss(MCP_CSS + '\n' + SKILLS_CSS);
    timer = createTimer();
    const call = async (method, args) => {
      // 服务名从**生成段**读（`lib/rpc-contract.js` 的 MCP_SERVICE），不在这里再写一遍：
      // 曾经写死 `remote.mcpManager`，而那个名字是宿主自己的（0.2.2-rc.2 起被
      // @deepseek-ai/dsh-mcp-manager 占用），两边撞名会让对方的插件起不来。
      const svc = (typeof ctx.get === 'function' ? ctx.get('remote.' + MCP_CONTRIBUTION.descriptors[0].namespace) : null) || null;
      if (!svc || typeof svc[method] !== 'function') return { ok: false, error: t('MCP 市场服务未连接（面板仍可用）') };
      const r = args === undefined || args === null ? await svc[method]() : await svc[method](args);
      if (r && r.ok) return { ok: true, ...((r.value && typeof r.value === 'object') ? r.value : {}) };
      if (r && !r.ok) return { ok: false, error: (r.error && (r.error.message || r.error.code)) || t('调用失败') };
      return r;
    };
    // 技能侧**独立的** call：skillsManager 与 mcpManager 是两个服务，取不到时降级成
    // 「技能服务未连接」，MCP 面板照常可用（SPEC 约束 16：宿主可禁用 dsh-skill 内置插件，
    // 那种 profile 里技能面必须只是不可用，不能连累 MCP 面）。
    const callSkills = async (method, args) => {
      const svc = (typeof ctx.get === 'function' ? ctx.get('remote.skillsManager') : null) || null;
      if (!svc || typeof svc[method] !== 'function') return { ok: false, error: t('技能服务未连接（需要宿主挂载 dsh-skill）') };
      const r = args === undefined || args === null ? await svc[method]() : await svc[method](args);
      if (r && r.ok) return { ok: true, ...((r.value && typeof r.value === 'object') ? r.value : {}) };
      if (r && !r.ok) return { ok: false, error: (r.error && (r.error.message || r.error.code)) || t('调用失败') };
      return r;
    };
    // 一键升级要用官方 pluginManager，而它只在 apply 的 ctx 上取得到（面板组件拿不到 ctx——
    // 它的 props 来自 slot 的 inject）。所以在这里取好、随 inject 传进面板，与 call 同一手法；
    // 取不到就给 null，面板据此不显示按钮。
    if (conflict) {
      // 只渲染提示、不注册入口。样式仍要注入，否则提示没有排版。
      ctx.slots.inject('shell.overlay', () =>
        ctx.slots.register({ name: 'shell.overlay', id: 'mcp-handover', order: 1000, label: () => t('工具箱') }, () => h(HandoverNotice, { conflict })),
      );
      return cleanup;
    }
    const pluginManager = (typeof ctx.get === 'function' ? ctx.get('remote.' + UPGRADE_NAMESPACE) : null)
      || (ctx.remote && ctx.remote[UPGRADE_NAMESPACE])
      || null;
    ctx.slots.inject('shell.overlay', () =>
      ctx.slots.register({ name: 'shell.overlay', id: 'mcp-fab', order: 1000, label: () => t('工具箱'), inject: () => ({ call, callSkills, timer, pluginManager }) }, McpOverlay),
    );
    // 官方标准侧栏入口（sidebar.footer.action，0.1.5 起声明）：与悬浮按钮共享同一个
      // 面板和开关状态。用 inject 而不是直接 register：它声明感知，会等侧边栏把 slot 声明出来
      // （插件加载顺序不保证晚于侧边栏）。
    // ⚠️ label 就是侧栏里**看得见的那几个字**（slot 的 label 由外壳渲染）。这里从 'MCP' 改成
    // t('工具箱')：面板早就不是只有 MCP 了（还有技能面与技能市场），而 name/包名是 dsh-toolbox-ui
    // ——入口上写着 MCP、点开却是 MCP + 技能，用户第一眼就会问"名字怎么还是 MCP"。
    // ⚠️ label 必须写成 **thunk**（() => t('工具箱')）而不是求值好的字符串：宿主的 SlotLabel
    // 契约是「string | (() => string)」，侧栏每读一次条目就 resolveSlotLabel 一次（且订阅
    // locale 变化重解），thunk 才会跟着当前语言走；直接写 t('工具箱') 会把语言冻在插件加载
    // 那一刻，切语言后侧栏入口停在旧语言直到宿主重启。
    ctx.slots.inject('sidebar.footer.action', () =>
      ctx.slots.register({ name: 'sidebar.footer.action', id: 'mcp-manager', order: 100, label: () => t('工具箱') }, McpFooterAction),
    );
    return cleanup;
  } catch (error) {
    await cleanup();
    throw error;
  }
}
const inject = ['slots', 'remote', 'typert', 'remote.pluginManager'];
exports.apply = apply;
exports.inject = inject;

		return module.exports;
	}
});


