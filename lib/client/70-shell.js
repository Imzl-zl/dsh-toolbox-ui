// ── 复制到另一个工作区 ───────────────────────────────────────────────────
// 默认全选源项目的 MCP、默认跳过目标同名条目：这两个默认值的方向一致——先让最常见的
// 「把 A 的配置搬给 B」一次点完，同时让"改动目标已有配置"必须由用户显式选一次。
const WorkspaceCopyModal = ({ open, onClose, call, busy, setBusy, onCopied, from, fromName, servers, workspaces }) => {
  const targets = useMemo(() => copyTargets(workspaces, from), [workspaces, from]);
  const [to, setTo] = useState('');
  const [names, setNames] = useState([]);
  const [overwrite, setOverwrite] = useState(false);
  const [error, setError] = useState('');
  // 计划与"算出它的那份输入"一起存：只有两者对得上，手上这份才是当前选择的结论（见 copyPlanKey）。
  const [preview, setPreview] = useState({ key: '', plan: null, error: '' });
  // 选了目标就先把结果算给用户看：写入前说清「目标已有哪几条同名、按当前选择会怎么处理」，
  // 而不是写完才在结果提示里告诉他有几条被跳过。判断全在 Host（resolveWorkspaceCopy），
  // 这里只渲染——所以预览与实际落盘不可能用两套规则。
  // 竞态靠 cleanup 的 cancelled 标志：React 保证下一次 effect 之前先跑 cleanup，卸载时也跑，
  // 所以"先发的请求后到"不可能覆盖后发的结果（多养一个序号 ref 只会让人以为 cancelled 不够用）。
  // 但 cancelled 只解决"谁写状态"，不解决"手上这份计划是不是当前选择的"——那是 requestKey 的事。
  const requestKey = copyPlanKey({ from, to, names, overwrite });
  useEffect(() => {
    if (!requestKey) { setPreview({ key: '', plan: null, error: '' }); return undefined; }
    let cancelled = false;
    (async () => {
      try {
        const res = await call('previewWorkspaceCopy', { from, to, names, overwrite });
        if (cancelled) return;
        if (!res?.ok) throw new Error(res?.error || t('无法预览目标工作区'));
        setPreview({ key: requestKey, plan: res, error: '' });
      } catch (e) {
        if (cancelled) return;
        setPreview({ key: requestKey, plan: null, error: String(e?.message || e) });
      }
    })();
    return () => { cancelled = true; };
  }, [requestKey, from, to, names, overwrite, call]);
  const planCurrent = preview.key === requestKey;
  // 计划过时只影响展示与"能不能按确认"；写入语义仍由 Host 在写锁内按最新配置重算。
  const ready = copyPlanReady(requestKey, preview);
  const plan = planCurrent ? preview.plan : null;
  const planError = planCurrent ? preview.error : '';
  // 打开时重置选择。**不能**依赖 servers：面板每 5s 轮询一次、每次都换数组引用，
  // 依赖它会让用户勾到一半就被重置回全选。
  useEffect(() => {
    if (!open) return;
    setTo('');
    setNames((servers || []).map((server) => server.serverName));
    setOverwrite(false);
    setError('');
    setPreview({ key: '', plan: null, error: '' });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);
  if (!open) return null;
  const list = servers || [];
  const allSelected = list.length > 0 && names.length === list.length;
  const toggleName = (name, checked) => setNames((prev) => (checked ? (prev.includes(name) ? prev : [...prev, name]) : prev.filter((item) => item !== name)));
  const submit = async () => {
    setBusy(true);
    setError('');
    try {
      const res = await call('copyWorkspaceServers', { from, to, names, overwrite });
      if (!res?.ok) throw new Error(res?.error || t('复制失败'));
      onCopied(res);
      onClose();
    } catch (e) {
      setError(String(e?.message || e));
    } finally {
      setBusy(false);
    }
  };
  return h('div', { className: 'dsh-mcp-overlay', onClick: (e) => e.target === e.currentTarget && onClose() },
    h(Dialog, { label: t('复制项目 MCP'), onClose },
      h('h3', null, t('复制项目 MCP 到另一个工作区')),
      h('div', { className: 'dsh-mcp-source-detail' }, t('源：{source}。复制在宿主内完成，配置与凭据不会经过浏览器。', { source: fromName || from })),
      h('div', { className: 'dsh-mcp-field' },
        h('label', null, t('目标工作区')),
        targets.length
          ? h('select', { className: 'dsh-mcp-copy-target', value: to, onChange: (e) => setTo(e.target.value) },
            h('option', { value: '' }, t('选择目标工作区…')),
            targets.map((ws) => h('option', { key: ws.path, value: ws.path }, t('{name}（{count} 个 MCP）{suffix}', { name: ws.name, count: ws.serverCount, suffix: ws.error ? t(' · 配置无效') : '' }))),
          )
          : h('div', { className: 'dsh-mcp-source-detail' }, t('没有其他已注册的工作区：先在 DSH 里打开另一个项目，它会出现在顶部标签页里。')),
      ),
      targets.length ? h('div', { className: 'dsh-mcp-field' },
        h('label', null, t('要复制的 MCP（{selected}/{total}）', { selected: Math.min(names.length, list.length), total: list.length })),
        h('div', { className: 'dsh-mcp-check-toolbar' },
          h('button', { type: 'button', className: 'dsh-mcp-btn sm ghost', onClick: () => setNames(allSelected ? [] : list.map((server) => server.serverName)) }, allSelected ? t('全不选') : t('全选')),
          h('span', null, t('目标已有同名条目时按下方选择处理')),
        ),
        h('div', { className: 'dsh-mcp-check-list' }, list.map((server) => h('label', { key: server.serverName, className: 'dsh-mcp-check-row' },
          h('input', { type: 'checkbox', checked: names.includes(server.serverName), onChange: (e) => toggleName(server.serverName, e.target.checked) }),
          h('span', { className: 'dsh-mcp-check-name' }, server.serverName),
          h('span', { className: 'dsh-mcp-check-meta' }, server.transport === 'http' ? 'HTTP' : 'stdio'),
        ))),
      ) : null,
      targets.length ? h('div', { className: 'dsh-mcp-radio-row' },
        h('label', { className: overwrite ? '' : 'sel' }, h('input', { type: 'radio', checked: !overwrite, onChange: () => setOverwrite(false) }), t('跳过目标同名')),
        h('label', { className: overwrite ? 'sel' : '' }, h('input', { type: 'radio', checked: overwrite, onChange: () => setOverwrite(true) }), t('覆盖目标同名')),
      ) : null,
      to ? h('div', { className: 'dsh-mcp-field' },
        h('label', null, t('写入结果预览')),
        planError ? h('div', { className: 'dsh-mcp-d-err' }, planError) : null,
        plan
          ? h('div', { className: 'dsh-mcp-card dsh-mcp-import-preview' }, copyPlanText(plan))
          : (planError ? null : h('div', { className: 'dsh-mcp-source-detail' }, planCurrent ? t('正在读取目标工作区配置…') : t('选择已变化，正在按当前选择重算…'))),
      ) : null,
      error ? h('div', { className: 'dsh-mcp-d-err' }, error) : null,
      h('div', { className: 'dsh-mcp-modal-actions' },
        h(Btn, { onClick: onClose, children: t('取消') }),
        h(Btn, { cls: 'primary', onClick: submit, disabled: busy || !ready, title: ready ? '' : t('等预览算出当前选择的结果'), children: busy ? t('复制中…') : t('复制') }),
      ),
    ),
  );
};

const POLL_INTERVAL_MS = 5000;

// 面板靠轮询反映 MCP 连接状态。标签页不可见时没人看这份数据，却照样每 5s 打两个 RPC，
// 因此隐藏期间跳过拉取，并在重新可见时立刻补一次，避免用户回来先看到一屏陈旧状态。
function startVisibilityAwarePolling(doc, timer, intervalMs, run) {
  const visible = () => !doc || doc.visibilityState !== 'hidden';
  const disposeInterval = timer.interval(() => { if (visible()) run(); }, intervalMs);
  if (!doc || typeof doc.addEventListener !== 'function') return disposeInterval;
  const onVisibilityChange = () => { if (visible()) run(); };
  doc.addEventListener('visibilitychange', onVisibilityChange);
  return () => {
    disposeInterval();
    doc.removeEventListener('visibilitychange', onVisibilityChange);
  };
}

const McpTab = (props) => {
  const { call, callSkills, onClose, floating, timer, pluginManager } = props;
  const panelRef = useRef(null);
  const [servers, setServers] = useState([]);
  const [error, setError] = useState('');
  const [selected, setSelected] = useState('');
  const [query, setQuery] = useState('');
  const [tools, setTools] = useState([]);
  const [busy, setBusy] = useState(false);
  const [addOpen, setAddOpen] = useState(false);
  const [importOpen, setImportOpen] = useState(false);
  // C2：延迟加载参数的表单。与 add/import 同一层：它也是"改宿主配置"的一次性动作。
  // 统一工具加载策略（内置 + MCP 同一套规则、可整体切换）。与「延迟参数」分开：
  // 一个是**有哪些工具该常驻**，一个是**搜索机制自己的预算**，混在一起会让人以为是同一件事。
  const [editTarget, setEditTarget] = useState(null);
  const [toast, setToast] = useState('');
  const [refreshing, setRefreshing] = useState(false);
  const [transportFilter, setTransportFilter] = useState('all');
  const [statusFilter, setStatusFilter] = useState('all');
  // ---- workspace 项目层 ----
  const [scope, setScope] = useState('global');
  const [workspaces, setWorkspaces] = useState([]);
  const [globalServers, setGlobalServers] = useState([]);
  const [exclude, setExclude] = useState([]);
  const [mountErrors, setMountErrors] = useState([]);
  const [scopeErrors, setScopeErrors] = useState([]);
  const [restrictError, setRestrictError] = useState(null);
  const [liveAgents, setLiveAgents] = useState(0);
  const [globalOpen, setGlobalOpen] = useState(false);
  const [exportOpen, setExportOpen] = useState(false);
  const [copyOpen, setCopyOpen] = useState(false);
  const [updateHint, setUpdateHint] = useState(null);
  const loadSeq = useRef(0);
  const manualRefreshSeq = useRef(0);
  const revisionRef = useRef('');
  const revealRevisionRef = useRef('');
  const [revealed, setRevealed] = useState({});
  const revealGeneration = useRef(0);
  const clearRevealed = useCallback(() => {
    clearRevealState(revealGeneration, setRevealed);
  }, []);

  useEffect(() => {
    if (floating) panelRef.current?.focus();
  }, [floating]);

  const flash = useCallback(
    (msg, kind) => {
      setToast({ msg, kind: kind || 'ok' });
      timer.timeout(() => setToast(''), 3200);
    },
    [timer],
  );

  const load = useCallback(async (notify = false) => {
    const seq = ++loadSeq.current;
    // switchScope 在切换那一刻递增同一个序列号；过期响应不能写回新作用域。
    const requestScope = scope;
    const isWorkspace = requestScope !== 'global';
    if (notify) { manualRefreshSeq.current = seq; setRefreshing(true); }
    try {
      const viewPromise = isWorkspace ? call('getWorkspaceView', { wsPath: requestScope }) : call('list');
      const [res, wsRes] = await Promise.all([viewPromise, call('listWorkspaces')]);
      if (seq !== loadSeq.current) return;
      if (wsRes && wsRes.ok) setWorkspaces(wsRes.workspaces || []);
      if (res && res.ok) {
        if (isWorkspace) {
          const next = res.servers || [];
          setGlobalServers(res.global || []);
          setExclude(res.exclude || []);
          setMountErrors(res.mountErrors || []);
          setScopeErrors(res.scopeErrors || []);
          setRestrictError(res.restrictError || null);
          setLiveAgents(res.liveAgents || 0);
          setError(res.error || '');
          if (!Object.hasOwn(res, 'revision') || res.revision !== revisionRef.current) {
            revisionRef.current = res.revision || '';
            setServers(next);
          }
          if (notify) flash(t('已刷新项目 MCP，共 {count} 个', { count: next.length }));
        } else {
          const next = res.servers || [];
          if (consumeRevision(revealRevisionRef, res.revealRevision)) clearRevealed();
          const hasRevision = Object.hasOwn(res, 'revision');
          if (!hasRevision || res.revision !== revisionRef.current) {
            revisionRef.current = res.revision || '';
            setServers(next);
          }
          setError('');
          if (notify) flash(t('已刷新，共 {count} 个 MCP', { count: next.length }));
        }
      } else {
        const message = (res && res.error) || t('加载失败');
        setError(message);
        if (notify) flash(message, 'err');
      }
    } catch (e) {
      if (seq !== loadSeq.current) return;
      const message = String((e && e.message) || e);
      setError(message);
      if (notify) flash(message, 'err');
    } finally {
      if (notify && manualRefreshSeq.current === seq) setRefreshing(false);
    }
  }, [call, clearRevealed, flash, scope]);

  useEffect(() => {
    load(false);
    return startVisibilityAwarePolling(typeof document === 'undefined' ? null : document, timer, POLL_INTERVAL_MS, () => load(false));
  }, [load, timer]);

  // 更新提示：Host 每天最多查一次 npm registry（本包的 latest 端点，见 lib/index.js 的
  // updateLatestUrl）；纯增值信息，任何失败都静默，不打扰面板。
  useEffect(() => {
    let cancelled = false;
    call('updateHint').then((res) => {
      if (cancelled || !res?.ok || !res.updateAvailable) return;
      let dismissed = null;
      try { dismissed = localStorage.getItem('dsh-mcp-manager-ui.updateHint.dismissed'); } catch { /* 存储不可用时视为未关闭 */ }
      if (dismissed !== res.latest) setUpdateHint(res);
    }).catch(() => {});
    return () => { cancelled = true; };
  }, [call]);

  // 探测一键升级的可用性：官方 pluginManager 在不在 + 本插件是不是 npm 装的。
  // 与 updateHint 同一条纪律：任何失败都静默（按钮不出现即可），绝不因它让面板报错。
  // 只在确实有新版时才探测——没有新版时按钮本来就不显示，省一次 remote 调用。
  useEffect(() => {
    if (!updateHint?.latest || !pluginManager || typeof pluginManager[UPGRADE_METHOD] !== 'function') return undefined;
    let cancelled = false;
    (async () => {
      try {
        const res = await pluginManager.listBundles();
        if (cancelled || !res || res.ok !== true || !Array.isArray(res.value)) return;
        const bundle = res.value.find((b) => b && b.name === UPGRADE_PACKAGE) || null;
        // 只有判定为「可升级」才记 state；不可升级时保持 idle，按钮走旧的链接形态。
        const plan = upgradePlan({ service: pluginManager, hint: updateHint, bundle });
        if (!cancelled && plan.supported) setUpgradeState({ phase: 'idle', bundle, spec: plan.spec });
      } catch { /* 探测失败 = 没有一键升级，退回链接；不报错 */ }
    })();
    return () => { cancelled = true; };
  }, [pluginManager, updateHint]);

  // 挂载失败按 serverName 索引：既标到列表行上，也注入详情的错误区，避免「顶部报错但那一行看着正常」。
  // 挂载失败的汇总横幅用的就是这个列表；行与详情都读 Host 标在行上的 mountFailed。

  // 选中项可能来自项目列表或（项目 tab 下的）全局列表；后者标记为 foreign，详情区据此只读。
  const selectedServer = useMemo(() => {
    if (scope === 'global' || !globalOpen) return servers.find((row) => row.serverName === selected) || null;
    const shared = globalServers.find((row) => row.serverName === selected);
    return shared ? { ...shared, managed: false, foreign: 'global' } : null;
  }, [servers, globalServers, selected, scope, globalOpen]);

  // 默认选中第一个服务器：右侧详情是这一页的主体，空着等于把大半版面浪费掉，
  // 用户还得先猜「要不要点左边」。只在**当前没有选中项**时补选，绝不覆盖用户的选择；
  // 选中项被删掉后 selected 仍留着旧名（详情区自然变空态），此时也会补选到剩下的第一个。
  useEffect(() => {
    const rows = scope !== 'global' && globalOpen ? globalServers : servers;
    if (rows.some((row) => row.serverName === selected)) return;
    setSelected(rows[0]?.serverName || '');
  }, [servers, globalServers, globalOpen, scope, selected]);

  useEffect(() => {
    let cancelled = false;
    setTools([]);
    if (!selected) return () => { cancelled = true; };
    (async () => {
      try {
        // 项目 MCP 要带 wsPath 才能精确定位：serverName 的全 app 唯一性只在保存路径被校验，
        // 手工编辑 .dsh/mcp.json 能造出两个项目同名，光按名字问会拿到另一个项目的工具。
        const res = selectedServer?.scope === 'workspace' && scope !== 'global'
          ? await call('tools', { name: selected, wsPath: scope })
          : await call('tools', { name: selected });
        if (!cancelled && res?.ok) setTools(res.tools || []);
      } catch {
        if (!cancelled) setTools([]);
      }
    })();
    return () => { cancelled = true; };
  }, [selected, selectedServer?.scope, selectedServer?.toolRevision, scope, call]);

  /** 结果展示的**唯一**判据：宿主说了什么就说什么（`note`），没说才退回调用方文案。
   *  以前这里写死 `successMsg || res.note`，于是"写盘成功、运行中没生效"（`live: 'skipped'`）
   *  被报成"已保存"，正好把这条契约想告诉用户的那件事盖掉了。 */
  const resultMessage = (res, fallback) => res?.note || res?.liveReason || fallback
  /** `live: 'failed'` 是"盘上变了、运行中没跟上"，必须按错误显示，不能用普通成功色。 */
  const resultTone = (res) => (res?.live === 'failed' ? 'err' : undefined)
  const act = useCallback(
    async (method, args, successMsg) => {
      setBusy(true);
      try {
        const res = await call(method, args);
        if (res && res.ok) {
          flash(resultMessage(res, successMsg || t('{method} 成功', { method })), resultTone(res));
        } else {
          flash((res && res.error) || t('{method} 失败', { method }), 'err');
        }
      } catch (e) {
        flash(String((e && e.message) || e), 'err');
      } finally {
        setBusy(false);
        timer.timeout(load, 250);
      }
    },
    [call, flash, load, timer],
  );

  const toggleDeferOne = (s) => {
    if (busy || s.managed !== true) return;
    // 方向必须从**芯片显示的那个值**推出：芯片读 `deferEffective`（统一策略下的实际状态），
    // 若这里改读旧的 `defer`，用户点一颗写着"延迟"的芯片、方向却是"再打开一次延迟"，
    // 结果就是点了没反应却提示成功。
    const next = (s.deferEffective ?? s.defer) !== true;
    // 乐观更新只动被点的那一行（不是整个作用域），再由 act 完成后的 load 校准。
    revisionRef.current = '';
    setServers((prev) => prev.map((row) => (row.serverName === s.serverName && row.scope === s.scope ? { ...row, defer: next, deferEffective: next } : row)));
    return act(
      'setDefer',
      s.scope === 'workspace' ? { name: s.serverName, wsPath: scope, defer: next } : { name: s.serverName, defer: next },
      next ? t('已把 {name} 切到延迟加载', { name: s.serverName }) : t('已把 {name} 切回全量常驻', { name: s.serverName }),
    );
  };
  const onToggle = (s) => {
    if (busy || !s.managed) return;
    const next = !s.enabled;
    // 乐观更新：本地先翻转，操作完成后由 load 校准。
    revisionRef.current = '';
    setServers((prev) => prev.map((x) => (x.serverName === s.serverName ? { ...x, enabled: next } : x)));
    if (scope === 'global') {
      return act(next ? 'enable' : 'disable', s.serverName, (next ? t('已启用 ') : t('已禁用 ')) + s.serverName);
    }
    // 项目层：写 disabled 字段到项目配置。
    const spec = { ...s, name: s.serverName, transport: s.transport === 'stdio' ? 'stdio' : 'streamable-http', disabled: !next };
    return act('updateWorkspaceServer', { wsPath: scope, spec }, (next ? t('已启用 ') : t('已禁用 ')) + s.serverName);
  };
  /**
   * 一键把 MCP 切到延迟/全量。两个作用域各走各的 RPC 载荷：
   *   全局 → { defer }             Host 改 <profile>/cordis.patch.yml
   *   项目 → { wsPath: scope, defer }  Host 改 <项目>/.dsh/mcp.json
   *
   * 乐观更新本地行的 defer 标记，再由 act 完成后的 load 校准。defer 是**下一轮模型请求**
   * 才生效的属性（工具清单每步重新组装），不需要额外刷新会话。
   */
  const setDeferAll = (next) => {
    if (busy) return;
    const inWorkspace = scope !== 'global';
    revisionRef.current = '';
    setServers((prev) => prev.map((s) => (s.managed === true && (inWorkspace || s.scope !== 'workspace') ? { ...s, defer: next } : s)));
    return act('setDeferAll', inWorkspace ? { wsPath: scope, defer: next } : { defer: next }, next ? t('已开启全部延迟加载') : t('已关闭全部延迟加载'));
  };
  const onReconnect = (s) => {
    // 项目连接也要有出口：mcp-client 的重连预算耗尽后会注销工具并停止，只能靠重载配置/重启宿主
    // 恢复（它的 README 明写），而项目 MCP 不是常驻服务 —— 所以「重连」在这里是必需的能力，
    // 不是可选装饰。这条路径 = 拆掉旧连接 + 按当前配置重建 + 对齐存活会话。
    if (s.scope === 'workspace') {
      return act('reconnectWorkspaceServer', { wsPath: scope, name: s.serverName }, t('已重连 {name}', { name: s.serverName }));
    }
    act('reconnect', s.serverName, t('已请求重连 {name}', { name: s.serverName }));
  };
  const onRemove = (s) => {
    const isWorkspace = s.scope === 'workspace';
    if (confirm(t('确认移除 MCP「{name}」？将从{scope}中删除。', { name: s.serverName, scope: isWorkspace ? t('项目配置') : t('当前 Web profile 配置') }))) {
      clearRevealed();
      // 不传 successMsg：宿主那句 note 才是权威结果（它会说明「还有几条同名条目没动、
      // 要重启宿主才会重连」）。传了 successMsg 就等于用一个泛化文案把它盖掉。
      if (isWorkspace) act('removeWorkspaceServer', { wsPath: scope, name: s.serverName });
      else act('removeServer', s.serverName);
    }
  };
  const onToggleExclude = (serverName, hidden) => {
    if (busy || scope === 'global') return;
    revisionRef.current = '';
    setGlobalServers((prev) => prev.map((s) => (s.serverName === serverName ? { ...s, excluded: hidden } : s)));
    setExclude((prev) => (hidden ? (prev.includes(serverName) ? prev : [...prev, serverName]) : prev.filter((name) => name !== serverName)));
    // 屏蔽同样是"写盘即对齐"：Host 会立刻把新的 restrict 写进会话作用域，运行中的会话在**下一次
    // 模型请求**就不再见得到这些工具（工具清单是每步重新组装的，不是首轮定型）。
    act('setWorkspaceExclude', { wsPath: scope, serverName, hidden }, hidden ? t('已屏蔽 {name}，对运行中的会话立即生效', { name: serverName }) : t('已取消屏蔽 {name}，对运行中的会话立即生效', { name: serverName }));
  };
  useEffect(() => { clearRevealed(); }, [selected, clearRevealed]);
  const revealValue = useCallback(async (server, field, key) => {
    if (!server.managed) throw new Error(t('该 MCP 来自其他配置层，配置只读，无法查看具体值'));
    const res = server.scope === 'workspace'
      ? await call('revealWorkspaceServer', { wsPath: scope, name: server.serverName, field, key })
      : await call('reveal', { name: server.serverName, field, key });
    if (!res?.ok) throw new Error(res?.error || t('读取配置失败'));
    return res.value;
  }, [call, scope]);
  const onCopy = useCallback((text) => {
    copyText(text).then((ok) => flash(ok ? t('已复制到剪贴板') : t('复制失败'), ok ? 'ok' : 'err'));
  }, [flash]);
  const onReveal = useCallback(async (server, field, key) => {
    const id = server.serverName + ':' + field + (key !== undefined ? ':' + key : '');
    if (revealed[id]?.value !== undefined) { setRevealed((prev) => ({ ...prev, [id]: false })); return; }
    if (revealed[id]?.pending) return;
    const generation = revealGeneration.current;
    setRevealed((prev) => ({ ...prev, [id]: { pending: true } }));
    try {
      const value = await revealValue(server, field, key);
      if (generation !== revealGeneration.current) return;
      setRevealed((prev) => ({ ...prev, [id]: { value, field, key } }));
    } catch (e) {
      if (generation !== revealGeneration.current) return;
      setRevealed((prev) => ({ ...prev, [id]: false }));
      flash(String(e?.message || e), 'err');
    }
  }, [flash, revealValue, revealed]);
  const onSubmit = async (spec, setFormError) => {
    setBusy(true);
    const isWorkspace = scope !== 'global';
    try {
      const res = isWorkspace
        ? (editTarget
            ? await call('updateWorkspaceServer', { wsPath: scope, spec })
            : await call('addWorkspaceServer', { wsPath: scope, spec }))
        : (editTarget ? await call('update', spec) : await call('add', spec));
      if (res && res.ok) {
        // 同 act()：宿主说"已写入，重启后生效"时不能盖成"已保存"。
        clearRevealed();
        flash(resultMessage(res, editTarget ? t('已保存 {name}', { name: spec.name }) : t('已添加 {name}', { name: spec.name })), resultTone(res));
        setAddOpen(false);
        setEditTarget(null);
        timer.timeout(load, 1500);
      } else {
        setFormError((res && res.error) || (editTarget ? t('保存失败') : t('添加失败')));
      }
    } catch (e) {
      setFormError(String((e && e.message) || e));
    } finally {
      setBusy(false);
    }
  };
  const openAdd = () => { setEditTarget(null); setAddOpen(true); };
  const openEdit = (s) => { setEditTarget(s); setAddOpen(true); };
  const onImported = (res) => {
    clearRevealed();
    flash(res.note || t('已导入 MCP'));
    timer.timeout(load, 1200);
  };
  const onBuiltinsInstalled = (res) => {
    clearRevealed();
    flash(res.note || t('已安装所选 MCP'));
    timer.timeout(load, 1200);
  };
  // 复制写的是**另一个**工作区（不是当前标签页），这里刷新只为让结果尽快可见——
  // 「跳过 N 条同名」这类事实必须由 Host 的结果文案说出来，界面不猜。
  const onCopiedToWorkspace = (res) => {
    flash(res.note || t('已复制'));
    timer.timeout(load, 1200);
  };

  const dismissUpdateHint = () => {
    if (updateHint?.latest) { try { localStorage.setItem('dsh-mcp-manager-ui.updateHint.dismissed', updateHint.latest); } catch { /* 忽略：下次打开会再提示 */ } }
    setUpdateHint(null);
    // 升级完成的横幅不挂在 updateHint 上（那时它已经是 null），所以要把 state 也收掉，
    // 否则「关闭」按钮按下去横幅还在。
    setUpgradeState((current) => (current.phase === 'done' ? { phase: 'idle' } : current));
  };

  // 一键升级：探测官方 pluginManager → 读本插件那一行 → 判定 → 执行 → 按 application 分流。
  // 探测失败一律静默退回「查看更新方式」链接：老宿主 / 没这个 namespace 时按钮不该出现，
  // 更不该报错（这一整块是纯增值信息，与 updateHint 同一条纪律）。
  const [upgradeState, setUpgradeState] = useState({ phase: 'idle' });
  const runUpgrade = async () => {
    const svc = pluginManager;
    const plan = upgradePlan({ service: svc, hint: updateHint, bundle: upgradeState.bundle || null });
    if (!plan.supported) {
      // 只有「本地链接安装」值得明说：其余情况（宿主没提供、已是最新）按钮本来就不显示。
      setUpgradeState({ phase: 'blocked', reason: plan.reason });
      return;
    }
    setUpgradeState({ phase: 'running', version: plan.version });
    try {
      // 两个参数：installBundle(spec, options)。少传第二个会被 wire 直接拒绝
      // （client api: pluginManager/installBundle expected 2 argument(s), got 1）。
      const res = await svc[UPGRADE_METHOD](plan.spec, {});
      if (!res || res.ok !== true) {
        setUpgradeState({ phase: 'failed', text: (res && res.error && (res.error.message || res.error.code)) || t('调用失败') });
        return;
      }
      const r = res.value || {};
      if (r.application === 'failed' || r.application === 'cancelled') {
        // 三个参数：未知错误码时要靠 pnpm 的原文解释失败（见 upgradeFailureText）。
        setUpgradeState({
          phase: 'failed',
          text: upgradeFailureText(r.error, r.packageResult && r.packageResult.exitCode, r.packageResult && r.packageResult.output),
        });
        return;
      }
      // applied / restart-required / overridden 都算装上了。宿主代码在进程内执行，升级已存在的包
      // 时官方**无条件**返回 restart-required（installBundle 里 `if (Object.hasOwn(before, name))
      // return 'restart-required'`，与 HMR 开不开无关），所以这里必须告诉用户去重启。
      setUpgradeState({ phase: 'done', version: plan.version || updateHint?.latest || '' });
    } catch (e) {
      setUpgradeState({ phase: 'failed', text: String(e?.message || e) });
    }
  };
  const filtered = useMemo(() => {
    const q = (query || '').toLowerCase();
    return servers.filter((s) => {
      if (transportFilter !== 'all' && s.transport !== transportFilter) return false;
      if (statusFilter !== 'all') {
        const status = s.status || s.phase || 'waiting';
        if (statusFilter === 'connected' && status !== 'connected') return false;
        if (statusFilter === 'failed' && status !== 'failed') return false;
        if (statusFilter === 'disabled' && s.enabled) return false;
      }
      if (!q) return true;
      return s.serverName.toLowerCase().includes(q) || (s.url || s.command || '').toLowerCase().includes(q);
    });
  }, [servers, query, transportFilter, statusFilter]);

  const visibleGlobalCount = useMemo(() => {
    const hidden = new Set(exclude || []);
    return globalServers.reduce((count, s) => (hidden.has(s.serverName) ? count : count + 1), 0);
  }, [globalServers, exclude]);

  const scopeTabs = useMemo(() => {
    const tabs = [{ key: 'global', label: t('全局') }];
    for (const ws of workspaces) {
      tabs.push({ key: ws.path, label: ws.name, count: ws.serverCount, title: ws.path + (ws.error ? t('（配置无效：{error}）', { error: ws.error }) : '') });
    }
    return tabs;
  }, [workspaces]);
  const scopeName = scope === 'global' ? t('全局') : (workspaces.find((ws) => ws.path === scope)?.name || scope);
  const switchScope = useCallback((next) => {
    if (next === scope) return;
    // 先让旧请求失效，再清掉旧作用域的视图数据。否则新 scope 已渲染、
    // 旧 servers 仍在树里，用户就会先看到「项目里有全局 MCP」，下一次刷新又消失。
    loadSeq.current += 1;
    setScope(next);
    setServers([]);
    setGlobalServers([]);
    setTools([]);
    setExclude([]);
    setMountErrors([]);
    setScopeErrors([]);
    setRestrictError(null);
    setLiveAgents(0);
    setSelected('');
    setQuery('');
    // 状态过滤在两种作用域下语义不同（项目 MCP 无连接态），切换时归零避免「空列表且控件已隐藏」。
    setTransportFilter('all');
    setStatusFilter('all');
    setGlobalOpen(false);
    setExportOpen(false);
    setCopyOpen(false);
    setAddOpen(false);
    setImportOpen(false);
    setEditTarget(null);
    setError('');
    revisionRef.current = '';
    clearRevealed();
    // 新作用域只由 [load, timer] effect 拉取；这里的 load 仍捕获旧 scope。
  }, [scope, clearRevealed]);

  // 工作区路径列表：宿主 skillsManager.list 要的是字符串数组，而 workspaces 状态里是
  // { path, name, serverCount, … } 对象。单独抽出来是因为 SkillsPanel 也要用同一份
  // （它不能自己问服务——那个方法在 mcpManager 上，问 skillsManager 只会静默失败）。
  const workspacePaths = useMemo(
    () => (Array.isArray(workspaces) ? workspaces : [])
      .map((item) => (typeof item === 'string' ? item : item?.path))
      .filter((value) => typeof value === 'string' && value !== ''),
    [workspaces],
  );

  // ── 能力层（MCP / 技能）与模式层（已安装 / 发现市场）─────────────────────
  //
  // 两层都由**外壳**渲染，而且是同一种控件（.dsh-mcp-seg）：能力层在标题栏（管哪个能力），
  // 模式层在第二行（看哪一面）。位置固定，所以切面时两排控件都不动。
  //
  // 为什么模式层也住在这里：曾经它是各能力面自己画的（MCP 面一个「市场」按钮弹窗、
  // 技能面一条自己的 bar），于是「同一个概念、两种形态、两个渲染者」。现在只有这一个。
  const [ability, setAbility] = useState('mcp');
  const [mode, setMode] = useState('manage');
  // 技能面的作用域药丸（全部 + 每个实际存在的作用域组）。选择值就是组的 key，
  // 与列表分组同源（skillGroupKey），所以药丸上的数字和它筛出来的行数一定相等。
  const [scopeFilter, setScopeFilter] = useState('all');
  const [mcpSort, setMcpSort] = useState('default');
  const [skillSort, setSkillSort] = useState('default');
  // { state: 'unknown' | 'ready' | 'down', count, error }
  const [skillsService, setSkillsService] = useState({ state: 'unknown', count: null, error: '' });

  // 技能服务可用性：**在 MCP 面也要能知道**。技能面没打开时 SkillsPanel 根本没挂载，
  // 所以外壳自己探一次。
  //
  // ⚠️ 这里原来探的是 `skillsManager/market`——它读的是随宿主返回的内置目录（离线、无网络
  // 请求），是当时最便宜的探针。2026-10-10 内置目录随市场一起删掉后，这个端点不存在了，
  // 探针于是**必然**走失败分支、把面板先标成「服务未连接」，直到 SkillsPanel 的 `list`
  // 报回真实结果。现在改探 `list`：它同样只读本机技能根、不发网络请求，而且是权威答案
  // （`market` 当年也只是回答「服务在不在」）。代价是技能面打开时会各查一次，可忽略。
  //
  // 为什么要专门有一条：宿主可以禁掉 dsh-skill 内置插件，那种 profile 里技能面只是不可用，
  // 但用户看到的是「技能页一直空着/一直加载」，没有任何线索指向原因（SPEC 约束 16）。
  useEffect(() => {
    let cancelled = false;
    Promise.resolve(callSkills('list', { workspaces: [] })).then((res) => {
      if (cancelled) return;
      if (res && res.ok) {
        // 探测成功只把 unknown 推进到 ready；已经有 SkillsPanel 报过结果就不覆盖它
        // （list 才是权威，探针只回答「服务在不在」）。
        setSkillsService((current) => (current.state === 'unknown' ? { state: 'ready', count: null, error: '' } : current));
        return;
      }
      setSkillsService({ state: 'down', count: null, error: (res && res.error) || t('技能服务未连接') });
    }).catch(() => { /* callSkills 自身不抛；真抛了也只是探测失败，不打扰面板 */ });
    return () => { cancelled = true; };
  }, [callSkills]);

  const onSkillsSummary = useCallback((info) => {
    setSkillsService((current) => ({ ...current, ...info }));
  }, []);

  // ⚠️ item.label 必须过 t()：两张表（ABILITY_TABS / SKILL_MODES）存的是**中文原文**，
  // 在这里翻而不是在建表时翻——建表发生在 apply() 拿到 locale 之前，那时翻等于把语言
  // 锁死在加载那一刻（真机表现：切 English 后页签仍是中文）。这里是**唯一**的分段控件
  // 渲染点，能力层与模式层都过它，所以翻这一处就够。
  const seg = (items, active, onSelect, label) => h('div', { className: 'dsh-mcp-seg', role: 'tablist', 'aria-label': label },
    ...items.map((item) => h('button', {
      key: item.id,
      type: 'button',
      role: 'tab',
      'aria-selected': active === item.id,
      className: 'dsh-mcp-btn' + (active === item.id ? ' sel' : ''),
      onClick: () => onSelect(item.id),
    },
      t(item.label),
      item.count === undefined || item.count === null ? null : h('span', { className: 'dsh-mcp-seg-count' }, String(item.count)),
    )),
  );

  // 能力层计数：技能的来自 SkillsPanel 回传的 list 结果（**行数**——已停用的技能也在列表里）。
  // MCP 面**不显示数字**——跨作用域总数外壳拿不到（list 只回答当前作用域那批），
  // 编一个出来比不显示更糟：用户会拿它当「一共有几个 MCP」。
  const abilityTabs = seg(
    ABILITY_TABS.map((tab) => (tab.id === 'skills' ? { ...tab, count: skillsService.count } : tab)),
    ability,
    setAbility,
    t('能力层'),
  );

  // 悬浮窗外壳：**两个能力面共用这一处**。
  // `.dsh-mcp-wrap` 只提供列布局与内边距；面板真正的外观（背景、圆角、阴影、遮罩、层级）
  // 全部来自 .dsh-mcp-panel-overlay / .dsh-mcp-panel。所以任何返回内容的出口都必须过这里，
  // 否则得到的是一个没有背景、没有定位的裸 div——页面其它内容会直接透过来。
  const wrapFloating = (content) => (floating
    ? h(
      'div',
      { className: 'dsh-mcp-panel-overlay', onClick: (e) => e.target === e.currentTarget && onClose && onClose() },
      h('div', { ref: panelRef, className: 'dsh-mcp-panel', role: 'dialog', 'aria-modal': true, 'aria-label': t('扩展中心'), tabIndex: -1, onKeyDown: (e) => { if (e.key === 'Escape' && onClose) onClose(); } }, content),
    )
    : content);

  // ── 第二行：模式分段 | 作用域药丸 | 连接状态 ────────────────────────────
  //
  // 这一条由**外壳**渲染，两个能力面共用（曾经技能面自己画一条 bar、MCP 面直接把作用域
  // 药丸当第二行，于是切面时这一行的形状与控件都换了）。
  //
  // 作用域只在**已安装**模式出现：市场是随宿主一起发下来的目录，没有作用域语义，
  // 留着它只会让人以为「筛选了市场」（原型同款处理：市场模式下这段 display:none、不留空档）。
  const skillsScopeTabs = skillsService.scopeTabs || [];
  const runtime = ability === 'tool-loading'
    ? null
    : ability === 'skills'
      ? (skillsService.state === 'down'
        ? { cls: ' err', icon: 'warn', text: t('skills 服务未就绪') }
        : skillsService.state === 'unknown'
          ? { cls: '', icon: 'info', text: t('正在连接 skills 服务…') }
          : null)
      : (error ? { cls: ' err', icon: 'warn', text: t('宿主 MCP 读取失败') } : null);

  // 工具页没有作用域：它管的是宿主全局注册的工具，与当前选中哪个项目无关。
  // 所以这一行在工具页只留右侧那句状态，模式与作用域两列都不渲染。
  const subRow = h('div', { className: 'dsh-mcp-sub' },
    ability === 'tool-loading' ? null : seg(SKILL_MODES, mode, setMode, t('模式')),
    h('div', { className: 'dsh-mcp-sub-scope' },
      ability === 'tool-loading'
        ? null
        : mode === 'manage'
          ? (ability === 'skills'
            ? (skillsScopeTabs.length > 1 ? h(ScopeTabs, { tabs: skillsScopeTabs, active: scopeFilter, onSelect: setScopeFilter }) : null)
            : h(ScopeTabs, { tabs: scopeTabs, active: scope, onSelect: switchScope }))
          : null,
    ),
    runtime ? h('div', { className: 'dsh-mcp-runtime' + runtime.cls, title: runtime.text }, h(Icon, { d: ICONS[runtime.icon], size: 13 }), runtime.text) : null,
  );

  // ── 通知条 ──────────────────────────────────────────────────────────────
  // 顺序固定：降级 → 读取失败 → 项目级故障 → 更新。前三条是「现在有问题」，
  // 更新是纯增值信息，所以它排最后（也最容易被忽略，但它本来就不该抢注意力）。
  const notices = [
    // 技能服务缺失：**在 MCP 面也要说**。MCP 面照常可用，但用户切到技能面时不能
    // 只看到一个空列表——他需要知道是宿主没挂 dsh-skill，而不是自己没有技能。
    skillsService.state === 'down'
      ? h(Notice, {
        key: 'skills-down', tone: 'err', icon: 'shield',
        title: t('宿主 skills 服务未就绪，技能面已降级'),
        children: t('未取到 remote.skillsManager（{reason}）。技能面不可用，MCP 面不受影响。', { reason: skillsService.error || t('原因未知') }),
        actions: [h(Btn, { key: 'how', cls: 'sm', onClick: () => flash(t('检查宿主是否挂载并启用了 @deepseek-ai/dsh-skill')), children: t('排查') })],
      })
      : null,
    error
      ? h(Notice, {
        key: 'load-failed', tone: 'err', icon: 'warn',
        title: t('MCP 配置读取失败'),
        children: error,
        actions: [h(Btn, { key: 'retry', cls: 'sm', onClick: () => load(true), disabled: refreshing, children: t('重试') })],
      })
      : null,
    scope !== 'global' && mountErrors.length
      ? h(Notice, {
        key: 'mount-failed', tone: 'warn', icon: 'warn',
        title: t('{count} 个项目 MCP 未能挂载到会话', { count: mountErrors.length }),
        // 项目 MCP 是「该项目所有会话共享一份连接」，同一项目内不会因并发会话而撞名；这里只
        // 如实给出并发会话数作为上下文（挂载失败的常见外部原因），不再把它说成 serverName 占用。
        // 只列 serverName 等于把真因留给用户自己逐条点开，所以正文直接摆出首条原因（Host 记的
        // 官方原文；同名占用时还带「和谁同名」与根因），其余各条在详情里给全文。
        children: mountErrors.map((m) => m.serverName).join(t('、'))
          + t('。首个原因：{reason}　点开对应条目查看每一条的具体错误。', { reason: firstFailureReason(mountErrors[0]) })
          + (liveAgents > 1 ? t('　本项目当前有 {count} 个会话在运行。', { count: liveAgents }) : ''),
      })
      : null,
    scope !== 'global' && scopeErrors.length
      ? h(Notice, {
        key: 'scope-failed', tone: 'warn', icon: 'warn',
        // 「作用域隔离失败」说清后果：这批工具会出现在**所有**项目的会话里（不是只在这一个项目里
        // 少工具），所以它不是"某个 server 没配好"，而是这台机器的安装让作用域失效——横幅因此
        // 也必须带出原因，否则用户只会去查 MCP 配置。
        title: t('{count} 个项目 MCP 的工具无法隔离（会出现在所有项目的会话里）', { count: scopeErrors.length }),
        children: scopeErrors.map((m) => m.serverName).join(t('、'))
          + t('。首个原因：{reason}　点开对应条目查看每一条的具体错误。', { reason: firstFailureReason(scopeErrors[0]) }),
      })
      : null,
    scope !== 'global' && restrictError
      ? h(Notice, { key: 'restrict', tone: 'warn', icon: 'warn', title: t('屏蔽未能写入会话作用域'), children: restrictError.error })
      : null,
    // 更新条的存活条件：有新版本，**或者**刚升完（要告诉用户重启，否则「点完就消失」
    // 等于没说——实测就是这样：升级成功后 updateHint 立刻变成「已是最新」，这条随之消失）。
    (updateHint || upgradeState.phase === 'done') ? h(Notice, {
      key: 'update', tone: 'info', icon: 'up',
      title: upgradeState.phase === 'running'
        ? t('正在升级到 v{version}…', { version: upgradeState.version })
        // ⚠️ done 分支**不得**再读 updateHint 的字段：那时它已经是 null（宿主已认不出旧版）。
        : upgradeState.phase === 'done' ? t('已升级到 v{version}，重启宿主后生效', { version: upgradeState.version })
          : upgradeState.phase === 'failed' ? t('升级失败：{text}', { text: upgradeState.text })
            : upgradeState.phase === 'blocked' && upgradeState.reason === 'not-npm'
              ? t('本地链接安装，无法一键升级{suffix}', { suffix: updateHint?.current ? t('（当前 v{version}）', { version: updateHint.current }) : '' })
              : t('新版本 v{version} 可用', { version: updateHint.latest }),
      children: upgradeState.phase === 'done' ? t('宿主代码在进程内执行，不重启等于没升级。') : t('升级由官方 pluginManager 执行，装完需要重启宿主。'),
      actions: [
        // 可升级时给按钮，否则退回链接。按钮只在探测确认过 service + npm 来源后出现——
        // 探测失败时这一整条与改动前完全一致，不会出现点了没反应的按钮。
        upgradeState.phase === 'idle' && upgradeState.spec
          ? h(Btn, { key: 'go', cls: 'sm primary', title: t('升级由官方 pluginManager 执行，装完需要重启宿主'), onClick: runUpgrade, children: t('升级') })
          : h('a', {
            key: 'link',
            className: 'dsh-mcp-btn sm',
            href: (updateHint && updateHint.url) || 'https://github.com/Imzl-zl/dsh-toolbox-ui/releases',
            target: '_blank',
            rel: 'noreferrer',
          }, upgradeState.phase === 'done' ? t('看这次改了什么') : t('查看更新方式')),
        h(Btn, { key: 'close', cls: 'icon ghost', title: t('本版本内不再提示'), onClick: dismissUpdateHint }, h(Icon, { d: ICONS.x })),
      ],
    }) : null,
  ].filter(Boolean);

  // ── 两个能力面共用的外壳 ────────────────────────────────────────────────
  //
  // ⚠️ 三个不变量，都有真机故障作依据：
  //
  // 1) **两个能力面必须走同一个出口**（.dsh-mcp-panel-overlay → .dsh-mcp-panel → .dsh-mcp-wrap）。
  //    `.dsh-mcp-wrap` 只负责列布局与内边距，没有背景/定位/层级；裸返回会让面板被当成
  //    页面里的普通 div，设置页内容直接透过来（实测糊成一片、完全不可读）。
  //
  // 2) **标题栏与第二行必须同构**。切换能力层只该换「管什么」，不该换「怎么操作」。
  //    曾经技能面自己另起了一套（标题栏空着、模式切换另起一条 bar、关闭按钮画两遍），
  //    一按「技能」整个面板换了个样——用户的原话是「一切换换一套操作逻辑」。
  //    所以现在**只有一处** head + subRow，能力层与模式层都归外壳。
  //
  // 3) **只有 .dsh-mcp-d-body 滚**：head / 通知条 / subRow 全是 flex:none。
  //    通知条进流（而不是浮在头部之上）也是为了让 Tab 行的位置恒定——有没有通知都一样。
  const head = h('div', { className: 'dsh-mcp-head' },
    // 标题是**常量**「扩展中心」，能力名由旁边的分段控件承载。
    // 之前这里写的是当前面的名字（「技能」/「MCP 市场」），标题随切面变、和分段控件
    // 说的是同一件事，等于把同一信息说两遍，还让用户以为换了个地方。
    h('div', { className: 'dsh-mcp-title' }, t('扩展中心')),
    // 第二列：能力层。**单独一列**，不塞进操作区里——塞进去它就跟按钮一起被推到同一边，
    // 而原型是「能力层贴标题在左、功能按钮贴右」。
    abilityTabs,
    // 第三列：功能按钮，内容右对齐。作用域由第二行的药丸承载，按钮文案不再重复项目名：
    // 项目名长度不可控，塞进按钮会把工具栏挤到换行；完整作用域放在药丸的 title 里。
    h('div', { className: 'dsh-mcp-head-actions' },
      ability === 'mcp' && mode === 'manage'
        ? h(Btn, { icon: 'refresh', onClick: () => load(true), disabled: refreshing, children: refreshing ? t('刷新中…') : t('刷新') })
        : null,
      ability === 'mcp' ? h(Btn, { onClick: () => setImportOpen(true), title: t('导入 MCP（{scope}）', { scope: scopeName }), children: t('导入 MCP') }) : null,
      ability === 'mcp'
        ? h(Btn, { cls: 'primary', icon: 'plus', onClick: openAdd, title: (scope === 'global' ? t('添加 MCP') : t('添加项目 MCP')) + t('（{name}）', { name: scopeName }), children: scope === 'global' ? t('添加 MCP') : t('添加项目 MCP') })
        // 技能面这里**不放「发现技能」**：市场已经是第二行那个模式分段（同一屏、同一位置）。
        // 两个入口指向同一件事，正是「同一个概念两个渲染者」——用户会问「这两个按钮一样吗」。
        // 技能面也没有「添加技能」这个动作（安装走市场，创建要新 RPC），所以主行为位留空。
        : null,
      h(EntryMenu, null),
    ),
    // 关闭按钮**不在**上面那一列里：它单独占 grid 第四列。与技能面来回切换时
    // 操作区的按钮数量差 5 倍，一起 flex-end 会让「关闭」每次横移几百像素。
    onClose ? h(Btn, { icon: 'x', onClick: onClose, children: t('关闭') }) : null,
  );

  // 统计取**当前看得见的那一批**（filtered），不是全量 servers。
  // 底栏就贴在列表下面：写着「25 个技能」而屏幕上只有 12 行，读起来像 bug；
  // 作用域的总量由上面那颗药丸自己带着（它写的就是 12），不必在这里再说一遍。
  //
  // 一键「全部延迟」：两个作用域都能用，各写各的文件。
  //   全局 → setDeferAll({defer})  改 <profile>/cordis.patch.yml
  //   项目 → setDeferAll({wsPath, defer})  改 <项目>/.dsh/mcp.json
  // **计数取当前作用域的全量行（servers），不是筛选后的 filtered**：Host 的 setDeferAll
  // 遍历 patch/项目配置里的全部 managed 条目，一次全改。按 filtered 算的话，一有筛选，
  // 按钮 title 写「所有 MCP（N 个）」而完成后 toast 写「已把 M 个服务器…」——同一次交互
  // 两个数，而用户没有任何理由知道该信哪个。项目作用域要打开 includeWorkspace，
  // 否则项目行全被滤掉、按钮永远禁用。
  const deferAll = deferAllState(servers, scope === 'global' ? {} : { includeWorkspace: true });
  const mcpListFooter = h(ListFooter, {
    text: mcpStatsText(filtered),
    sortKey: mcpSort,
    onSort: setMcpSort,
    onRefresh: () => load(true),
    refreshing,
    sortTitle: t('排序 MCP'),
  });

  // 「全部延迟」的**唯一**渲染处：列表的过滤器行（ServerList 的 toolbarAction）。
  // 曾经它同时出现在底栏，一屏放不下时用户根本看不到——现在是唯一入口，位置固定在第一屏。
  const deferAllAction = {
    label: deferAll.all ? t('取消全部延迟') : t('全部延迟'),
    title: (deferAll.all
      ? (scope === 'global'
        ? t('把当前 Web profile 的所有 MCP 切回全量常驻（{count} 个）', { count: deferAll.total })
        : t('把该项目的所有 MCP 切回全量常驻（{count} 个）', { count: deferAll.total }))
      : (scope === 'global'
        ? t('把当前 Web profile 的所有 MCP 切到延迟加载（{count} 个）：模型经 tool_search 按需搜索，命中后才进工具列表', { count: deferAll.total })
        : t('把该项目的所有 MCP 切到延迟加载（{count} 个）：模型经 tool_search 按需搜索，命中后才进工具列表', { count: deferAll.total }))),
    disabled: deferAll.total === 0 || busy,
    onClick: () => setDeferAll(!deferAll.all),
  };

  // 市场里的「安装到」候选：全局 + 每个工作区。
  // ⚠️ 与「已安装」模式的药丸是**同一份 state**（scope / switchScope）——
  // 两个控件、两个模式，任一时刻只显示一个，所以不存在两个真值。
  // MCP 的落盘位置只有 `<profile>/mcp.json`（全局）与 `<项目>/.dsh/mcp.json`（项目）
  // 两种，没有 `.agents/` 变体（那是 skills 侧的社区约定，见 skillScopeOptions）。
  const scopeChoices = useMemo(() => [
    { key: 'global', label: t('全局（当前 profile）'), title: t('写入当前 Web profile 的 MCP 配置，所有项目共享') },
    ...(Array.isArray(workspaces) ? workspaces : []).map((ws) => ({
      key: ws.path,
      label: t('项目 {name}', { name: ws.name || projectLabelOf(ws.path) }),
      title: t('{path}（.dsh/mcp.json，只对该项目的会话生效）', { path: ws.path }),
    })),
  ], [workspaces]);

  const mcpBody = mode === 'market'
    ? h(McpMarketView, {
      call, busy, setBusy,
      onInstalled: onBuiltinsInstalled,
      scope, scopeName,
      scopeOptions: scopeChoices,
      onScope: switchScope,
      knownNames: servers,
      // 从表头按钮进来的一次性切换已经删掉，市场现在是模式层的一种，进来就加载。
      active: true,
    })
    : (scope === 'global'
      ? h(
        'div',
        { className: 'dsh-mcp-body' },
        h(ServerList, {
          servers: sortServers(filtered, mcpSort),
          total: servers.length,
          selected,
          query,
          onQuery: setQuery,
          onSelect: setSelected,
          onToggle,
          onToggleDefer: toggleDeferOne,
          busy,
          transportFilter,
          statusFilter,
          onTransportFilter: setTransportFilter,
          onStatusFilter: setStatusFilter,
          footer: mcpListFooter,
          toolbarAction: deferAllAction,
        }),
        h(ServerDetailPane, {
          server: selectedServer,
          tools,
          onToggle,
          onReconnect,
          onEdit: openEdit,
          onRemove,
          busy,
          onReveal,
          revealed,
          onCopy,
        }),
      )
      : h(
        'div',
        { className: 'dsh-mcp-body' },
        // 两份来源共用左栏，切换只换列表，右侧详情始终保留。
        h('div', { className: 'dsh-mcp-ws-body', key: scope, 'data-ws-path': scope },
          h('div', { className: 'dsh-mcp-section local' },
            h('div', { className: 'dsh-mcp-source-tabs', role: 'tablist', 'aria-label': t('MCP 来源') },
              h('button', { type: 'button', role: 'tab', 'aria-selected': !globalOpen,
                onClick: () => { setGlobalOpen(false); setSelected(''); } },
                t('项目 MCP'), h('span', null, servers.length)),
              h('button', { type: 'button', role: 'tab', 'aria-selected': globalOpen,
                title: t('共享的全局 MCP'), onClick: () => { setGlobalOpen(true); setSelected(''); } },
                t('全局共享'), h('span', null, globalServers.length)),
            ),
            !globalOpen && servers.length > 0 ? h('div', { className: 'dsh-mcp-section-actions' },
              h(Btn, { cls: 'sm ghost', disabled: busy,
                title: t('导出本项目的 MCP 配置（JSON，可备份、跨机器迁移或分享）'),
                onClick: () => setExportOpen(true), children: t('导出') }),
              h(Btn, { cls: 'sm ghost', disabled: busy,
                title: t('把本项目的 MCP 复制到另一个已注册的工作区'),
                onClick: () => setCopyOpen(true), children: t('复制到…') }),
            ) : null,
            globalOpen ? h(React2.Fragment, null,
              h(GlobalServerList, { servers: globalServers, exclude, onToggleExclude, onSelect: setSelected, selected, busy }),
              h(ListFooter, { text: t('{visible}/{total} 可见', { visible: visibleGlobalCount, total: globalServers.length }),
                onRefresh: () => load(true), refreshing }),
            ) : h(ServerList, {
              servers: sortServers(filtered, mcpSort),
              total: servers.length,
              selected,
              query,
              onQuery: setQuery,
              onSelect: setSelected,
              onToggle,
              onToggleDefer: toggleDeferOne,
              busy,
              transportFilter,
              statusFilter,
              onTransportFilter: setTransportFilter,
              onStatusFilter: setStatusFilter,
              embedded: true,
              workspace: true,
              emptyHint: t('还没有项目 MCP。点上方「添加项目 MCP」，或去「发现市场」安装。'),
              footer: mcpListFooter,
              toolbarAction: deferAllAction,
            }),
          ),
        ),
        h(ServerDetailPane, {
          server: selectedServer,
          tools,
          onToggle,
          onReconnect,
          onEdit: openEdit,
          onRemove,
          busy,
          onReveal,
          revealed,
          onCopy,
          excluded: exclude.includes(selected),
          onToggleExclude,
          emptyTitle: !globalOpen && servers.length === 0 ? t('此项目还没有 MCP') : undefined,
          emptyActions: !globalOpen && servers.length === 0 ? [
            h(Btn, { key: 'add', cls: 'primary', icon: 'plus', onClick: openAdd, children: t('添加项目 MCP') }),
            h(Btn, { key: 'market', onClick: () => setMode('market'), children: t('发现市场') }),
          ] : undefined,
        }),
      ));

  // workspaces 由 McpTab 传下去：它已经用**正确的** call（mcpManager）取到了列表，
  // 而 SkillsPanel 手上的 call 是 callSkills（skillsManager），自己取会静默失败。
  //
  // 模式 / 作用域药丸 / 排序都**由外壳持有**（它们是第二行与底栏的一部分），
  // 这里只把值传进去——SkillsPanel 因此只负责「技能面那具身体」。
  const skillsBody = h(SkillsPanel, {
    call: callSkills,
    workspaces: workspacePaths,
    mode,
    scopeFilter,
    onScopeFilter: setScopeFilter,
    sortKey: skillSort,
    onSort: setSkillSort,
    onSummary: onSkillsSummary,
    // 技能面的行动作失败时要说出宿主的原话（见 SkillsPanel 里 act 的说明）——与 MCP 面共用这一条 flash。
    flash,
  });

  const inner = h(
    'div',
    { className: 'dsh-mcp-wrap' },
    head,
    ...notices,
    ability === 'tool-loading' ? null : subRow,
    ability === 'skills'
      ? skillsBody
      : ability === 'tool-loading'
        ? h(ToolLoadingModal, {
          open: true,
          inline: true,
          onClose: () => {},
          call,
          onSaved: (_fresh, note) => flash(note || t('已保存工具加载策略')),
        })
        : mcpBody,
    h(AddEditModal, { open: addOpen, onClose: () => { setAddOpen(false); setEditTarget(null); }, onSubmit, busy, initial: editTarget, onRevealValue: revealValue, revealEpoch: revealGeneration.current, scope, scopeName }),
    h(JsonImportModal, { open: importOpen, onClose: () => setImportOpen(false), call, busy, setBusy, onImported, scope, scopeName }),
    // 更新提示也挂在面板的弹层列表里：面板一开它就挂载，向宿主问一次「这次变了什么」。
    h(WhatsNewModal, { call }),
    h(WorkspaceExportModal, { open: exportOpen && scope !== 'global', onClose: () => setExportOpen(false), call, scope, scopeName }),
    h(WorkspaceCopyModal, {
      open: copyOpen && scope !== 'global',
      onClose: () => setCopyOpen(false),
      call,
      busy,
      setBusy,
      onCopied: onCopiedToWorkspace,
      from: scope,
      fromName: scopeName,
      servers,
      workspaces,
    }),
    toast
      ? h('div', { className: 'dsh-mcp-toast ' + toast.kind }, toast.msg)
      : null,
  );

  return wrapFloating(inner);
};


// ── 右下角浮动按钮（shell.overlay 常驻，可拖拽 + 记忆位置）──────────────
// shell.overlay 是「叠加式」挂载层，DSH 不做多插件避让，所以按钮定位由本插件
// 自己负责：默认右下角，用户可拖动到任意位置，位置存 localStorage 跨会话还原。
//
// 跟手性要点（参考 dnd-kit / react-draggable / 社区 FAB 拖拽惯例）：
// - 拖拽期间直接写 DOM，不走 setState：pointermove 高频，每个事件都让 React 重渲染
//   会掉帧、不跟手；最终位置只在松手时提交一次。
// - Pointer Events + setPointerCapture 统一鼠标/触摸/笔，快速拖动不丢事件。
// - touch-action:none 是触摸下唯一可靠的滚动抑制手段（iOS Safari 尤其如此）。
//   本按钮是 position:fixed 的 50px 圆钮，脱离文档流，left/top 重绘成本可忽略，
//   故保留 left/top 定位以复用现有 :hover/:active 的 transform 缩放反馈。
const FAB_POS_KEY = 'dsh-mcp-manager-ui/fab-pos';
const FAB_SIZE = 48;
const FAB_EDGE = 22;
const DRAG_THRESHOLD = 5;

function fabViewport() {
  const w = typeof window !== 'undefined' ? window.innerWidth : 0;
  const h = typeof window !== 'undefined' ? window.innerHeight : 0;
  return { w, h };
}
function clampFabPos(x, y) {
  const { w, h } = fabViewport();
  return {
    x: Math.min(Math.max(x, 0), Math.max(0, w - FAB_SIZE)),
    y: Math.min(Math.max(y, 0), Math.max(0, h - FAB_SIZE)),
  };
}
function defaultFabPos() {
  const { w, h } = fabViewport();
  return { x: w - FAB_SIZE - FAB_EDGE, y: h - FAB_SIZE - FAB_EDGE };
}
function readFabPos() {
  try {
    if (typeof localStorage === 'undefined') return null;
    const raw = localStorage.getItem(FAB_POS_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    // Number.isFinite 兜底：JSON 里 1e999 会解析成 Infinity，typeof number 挡不住，
    // 混进 clamp 会产出 NaNpx 让按钮凭空消失。
    if (!parsed || typeof parsed.x !== 'number' || typeof parsed.y !== 'number' || !Number.isFinite(parsed.x) || !Number.isFinite(parsed.y)) return null;
    return clampFabPos(parsed.x, parsed.y);
  } catch {
    return null;
  }
}
function saveFabPos(pos) {
  try {
    if (typeof localStorage === 'undefined') return;
    localStorage.setItem(FAB_POS_KEY, JSON.stringify({ x: pos.x, y: pos.y }));
  } catch {
    // 存储不可用（无痕/禁用）：拖拽仍可用，只是不跨会话记忆。
  }
}

// ── 面板开合状态：悬浮按钮与左侧栏入口共享同一份 ──────────────────────────────
// 两个入口分属不同的 slot 子树（shell.overlay / sidebar.footer.action），没有公共
// React 祖先，因此用模块级订阅而不是 context。单一数据源：两个入口看到的开关状态
// 永远一致，不会出现「一个说开着、一个说关着」。
function createPanelVisibility() {
  let open = false;
  const listeners = new Set();
  return {
    isOpen: () => open,
    set(next) {
      if (open === next) return;
      open = next;
      for (const listener of [...listeners]) listener();
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
  };
}
const panelVisibility = createPanelVisibility();

const usePanelOpen = () => {
  const [open, setOpen] = useState(panelVisibility.isOpen());
  useEffect(() => panelVisibility.subscribe(() => setOpen(panelVisibility.isOpen())), []);
  return open;
};

// ── 当前语言版本：让 effect 依赖能感知语言切换 ──────────────────────────────
// 组件渲染时直接读 localeActive 就够了（宿主每个 outlet 在语言切换时都会重渲染），
// 但 **effect 依赖不行**：切语言不会改变任何 props/state，依赖里没有它，
// 「按语言重新拉取」这类 effect 就不会跑（真机表现：切英文后技能市场的描述与
// 分类名停在中文，要等下次搜索/重挂才变）。所以给语言一个版本号 store，
// readActive 在语言真变时 bump，组件用 useLocaleVersion() 把它列进依赖。
function createLocaleVersion() {
  let version = 0;
  const listeners = new Set();
  return {
    get: () => version,
    bump: () => {
      version += 1;
      for (const listener of [...listeners]) listener();
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
  };
}
const localeVersion = createLocaleVersion();
const useLocaleVersion = () => {
  const [version, setVersion] = useState(localeVersion.get());
  useEffect(() => localeVersion.subscribe(() => setVersion(localeVersion.get())), []);
  return version;
};

// ── 入口显示偏好：两个入口都可关，但不能都关 ─────────────────────────────────
// 面板只能从这两个入口打开（右下角悬浮按钮 / 左侧栏底部「MCP」）。所以「两个都关」是一
// 个必须**无法表达**的状态：真出现了，用户就再也打不开面板，只能手改 localStorage 回来。
// 这里因此不存两个 boolean，而是存一张「模式 → 入口可见性」表：非法组合在表里根本不存在，
// 不需要额外的守卫、禁用逻辑或「至少留一个」的提示文案。新增入口时，这张表的不变式
// （每一项至少一个入口可见）由 test/client-entry.test.mjs 直接对表断言。
const ENTRY_KEY = 'dsh-mcp-manager-ui/entry';
const ENTRY_VISIBILITY = {
  both: { fab: true, sidebar: true },
  fab: { fab: true, sidebar: false },
  sidebar: { fab: false, sidebar: true },
};
// 同 SCOPE_LABELS：存中文原文，渲染时翻。
const ENTRY_LABELS = {
  both: '悬浮按钮 + 侧栏入口',
  fab: '仅悬浮按钮',
  sidebar: '仅侧栏入口',
};
const ENTRY_DEFAULT = 'both';
const ENTRY_MODES = Object.keys(ENTRY_VISIBILITY);

// localStorage 是外部输入（旧版本写的、用户手改的）：不认识的值一律退回默认，
// 不半信半疑地拿去查表（查不到会得到一个 undefined 的可见性，等于悄悄关掉所有入口）。
function normalizeEntryMode(value) {
  return Object.prototype.hasOwnProperty.call(ENTRY_VISIBILITY, value) ? value : ENTRY_DEFAULT;
}
function readEntryMode() {
  try {
    if (typeof localStorage === 'undefined') return ENTRY_DEFAULT;
    return normalizeEntryMode(localStorage.getItem(ENTRY_KEY));
  } catch {
    return ENTRY_DEFAULT;
  }
}
function saveEntryMode(mode) {
  try {
    if (typeof localStorage === 'undefined') return;
    localStorage.setItem(ENTRY_KEY, mode);
  } catch {
    // 存储不可用（无痕 / 被禁用）：本次会话内仍然生效，只是不跨会话记忆。
  }
}
function createEntryMode() {
  let mode = readEntryMode();
  const listeners = new Set();
  return {
    get: () => mode,
    set(next) {
      const normalized = normalizeEntryMode(next);
      if (normalized === mode) return;
      mode = normalized;
      saveEntryMode(mode);
      for (const listener of [...listeners]) listener();
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
  };
}
const entryMode = createEntryMode();

const useEntryMode = () => {
  const [mode, setMode] = useState(entryMode.get());
  useEffect(() => entryMode.subscribe(() => setMode(entryMode.get())), []);
  return mode;
};

// shell.overlay 那个注册里到底渲染什么：面板挂载点与悬浮按钮是两件事——
//   面板：只要 open 就渲染。侧栏入口只改 panelVisibility，真正渲染面板的是这里，
//         所以把面板也用入口偏好门住 = 关掉悬浮按钮后侧栏入口点了没反应（把自己锁死）。
//   按钮：才看入口偏好，且只在面板没开着时占位。
// 抽成纯函数也是为了让这条不变式能脱离 React 被测：测试替身的 hooks 是空实现，组件本身
// 在 node 里渲染不起来（见 test/client-entry.test.mjs）。
function overlaySeats(mode, open) {
  return { panel: open, fab: !open && ENTRY_VISIBILITY[mode].fab };
}

// 入口偏好的开关就放在面板头部：它必须能从面板里改回来（关掉一个入口后用户还在面板里），
// 而面板本身只有这两个入口能打开——所以这个控件不能藏得更深。低频操作，用图标按钮 + 弹层，
// 不占 Tab（作用域 tab 讲的是「管哪一份配置」，与显示偏好无关）。
const EntryMenu = () => {
  const mode = useEntryMode();
  const [open, setOpen] = useState(false);
  const boxRef = useRef(null);
  useEffect(() => {
    if (!open) return;
    const close = (e) => { if (!boxRef.current || !boxRef.current.contains(e.target)) setOpen(false); };
    document.addEventListener('click', close);
    return () => document.removeEventListener('click', close);
  }, [open]);
  return h(
    'div',
    { className: 'dsh-mcp-entry', ref: boxRef },
    h(Btn, {
      icon: 'entry',
      title: t('入口显示：{mode}', { mode: t(ENTRY_LABELS[mode]) }),
      onClick: (e) => { e.stopPropagation(); setOpen((value) => !value); },
      children: t('入口'),
    }),
    // 行用原生 <button> 而不是 div[role=menuitemradio]：menu 语义要求方向键 / Home / Esc /
    // roving tabindex 一整套键盘行为，不实现就等于这个设置对键盘用户不存在，还多了一句假声明。
    // 原生按钮免费给到 Tab 与 Enter/Space，状态用 aria-pressed 表达（与面板里那个眼睛开关同一个惯用法）。
    open ? h('div', { className: 'dsh-mcp-tab-pop dsh-mcp-entry-pop' },
      ENTRY_MODES.map((value) =>
        h('button', {
          key: value,
          type: 'button',
          'aria-pressed': mode === value,
          className: 'dsh-mcp-entry-item' + (mode === value ? ' sel' : ''),
          onClick: () => { entryMode.set(value); setOpen(false); },
        }, t(ENTRY_LABELS[value])),
      ),
    ) : null,
  );
};

// 左侧栏底部入口（sidebar.footer.action，DSH 0.1.5 起提供）：官方标准的发现入口。
// 点击打开的是同一个浮层面板——不切换主面板、不打断正在进行的会话。
const McpFooterAction = ({ wide }) => {
  const open = usePanelOpen();
  const mode = useEntryMode();
  // 文案层补接的第二个时机：侧栏入口比面板更早挂载（页面加载就渲染），桌面壳下
  // 在这里补接，用户还没点开面板语言就已经跟上。幂等，overlay 挂载时那次是兜底。
  useEffect(() => { ensureLocaleWired() }, []);
  // 「仅悬浮按钮」模式：返回 null 就够了，不需要注销注册。list 型 slot 的每个条目直接渲染
  // 进侧栏的 .footerActions（display:flex、无 gap/padding），外层 outlet 锚点又是
  // display:contents，所以空子树不占任何布局、也不留空行。
  if (!ENTRY_VISIBILITY[mode].sidebar) return null;
  return h(
    'button',
    {
      type: 'button',
      className: 'dsh-mcp-footer-action' + (wide ? '' : ' rail'),
      title: t('工具箱面板'),
      'aria-label': t('打开工具箱面板'),
      'aria-expanded': open,
      onClick: () => panelVisibility.set(true),
    },
    h(Icon, { d: ICONS.plug, size: wide ? 16 : 18 }),
    wide ? h('span', { className: 'dsh-mcp-footer-name' }, t('工具箱')) : null,
  );
};

// ── 更新提示：升级后说一次「这次变了什么」────────────────────────────
// 为什么要有它：新能力只写在 README / release note 里，用户根本不会去找——面板头部的
// 「入口」开关就是这么被忽略掉的。所以升级后主动说一次，并指出它在哪。
// 内容真源在 lib/whats-new.js（宿主侧），这里只管「这次该不该说」：
//   - 记的是「上次确认过的版本」（与 updateHint 的 dismissed 同一个惯用法，确认才落盘）；
//   - 认得出上次那版 → 报它之后的全部（跨版本升级不漏）；
//   - 认不出（新装，或从还没有这个功能的版本升上来）→ 只报当前这一条。这两者从
//     localStorage 里分不辨，而后者正是要覆盖的人，所以偏向「说一次」，代价只是新装
//     用户看到一条本次更新。
const WHATS_NEW_SEEN_KEY = 'dsh-mcp-manager-ui.whatsNew.seen';

// ── 一键升级：借官方 pluginManager，不自己 spawn 包管理器 ──────────────
// 为什么能这么做：`@deepseek-ai/dsh-plugin-manager` 随 dsh-base / dsh-web-app 提供
// （人人都有，不依赖任何第三方市场插件），它把 installBundle 挂进共享的 ctx.remote。
// 官方 UI 自己不做升级（它的安装对话框会先拦「该插件已安装。如需升级，请卸载后重新安装」），
// 但那个拦截发生在 inspect()（仅按包名判重），而 installBundle 自己**不调 inspect**——
// 所以覆盖安装是它的既定能力，官方只是没在 UI 上开放。
//
// 为什么值得做：升级 = 改用户机器上的安装，而覆盖安装由官方完成版本校验与失败还原
// （executePluginCommand 失败时 restoreFiles 会回滚 manifest/lockfile）。自己 spawn pnpm
// 就要把 Windows 的 .cmd 外壳、pnpm 9/10/11 差异、跨平台 PATH 全部重做一遍。
const UPGRADE_NAMESPACE = 'pluginManager';
const UPGRADE_METHOD = 'installBundle';
const UPGRADE_PACKAGE = 'dsh-toolbox-ui';

/**
 * 这次升级能不能做、为什么不能——纯判定，便于单测。
 *
 * 三种「不能升」的来源各不相同，报给用户的话也必须不同：
 *   - 宿主没提供 pluginManager（老宿主 / 非 web 形态）→ 退回手动命令；
 *   - 插件不是 npm 装的（link:/file:/github:）→ 覆盖安装会把它换成 npm 包，不能做；
 *   - 当前版本不低于最新 → 无需升级。
 *
 * @param {object} input - 判定输入。
 * @param {object|null} input.service - 探测到的 pluginManager 命名空间（null = 宿主没提供）。
 * @param {object|null} input.hint - updateHint 的结果（current / latest / updateAvailable）。
 * @param {object|null} input.bundle - listBundles 里本插件那一行（source / installed / version）。
 * @returns {{supported: boolean, reason: string, spec: string|null, canRestart: boolean}} 判定结果。
 */
function upgradePlan({ service, hint, bundle }) {
  const hasMethod = !!service && typeof service[UPGRADE_METHOD] === 'function';
  if (!hasMethod) return { supported: false, reason: 'no-service', spec: null };
  if (!hint?.updateAvailable || !hint?.latest) return { supported: false, reason: 'up-to-date', spec: null };
  // 本地安装形态（link:/file:/github:/tarball）不归 installBundle 管：拿 npm spec 覆盖会把
  // 用户的本地开发链接换成 npm 包，那是破坏而不是升级。只认 registry 来源。
  const source = typeof bundle?.source === 'string' ? bundle.source : '';
  const isRegistry = source === '' || /^\d|^\^|^~|^latest$/.test(source);
  if (!isRegistry) return { supported: false, reason: 'not-npm', spec: null };
  return {
    supported: true,
    reason: 'ok',
    // 带 ^：与 profile 里已有的前缀风格一致（实测 pnpm 沿用原 spec 前缀，不会因这次调用
    // 把 `^1.4.2` 改成精确的 `1.4.2`，所以用户不会因此失去 `dsh plugin update` 的自动升级）。
    spec: `${UPGRADE_PACKAGE}@^${hint.latest}`,
    // 目标版本随判定一起带出来：升级完成后 updateHint 会被宿主刷成「已是最新」，
    // 那时就没有版本可显示了，必须在这里记住。
    version: hint.latest,
  };
}

/**
 * 从官方 `packageResult.output` 里挑出**pnpm 自己说的那句话**。
 *
 * 为什么不直接把 output 贴上去：它整段是 pnpm 的完整输出（进度行、`npm notice` 噪声、
 * 可能还有 ANSI 颜色码），几千字符贴进横幅等于没说话。这里只取"有信息量"的末尾几行。
 *
 * 为什么值得做：真机实测过一次失败，面板只显示「错误码 operation-error，pnpm 退出码
 * 3221226505」（那个退出码是 Windows 上的崩溃码），而 pnpm 原文写得很清楚：
 * `ERR_PNPM_NO_MATCHING_VERSION … The latest release of <包名> is "1.5.3"`。
 * 官方早就把这段放在 `packageResult.output` 里回给我们了，之前一直没用。
 */
function pnpmOutputTail(output, limit = 3) {
  const text = typeof output === 'string' ? output : '';
  if (!text) return '';
  const lines = text
    // eslint-disable-next-line no-control-regex
    .replace(/\u001b\[[0-9;]*m/g, '')
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line && !/^npm (notice|warn)\b/.test(line) && !/^Progress:/.test(line));
  if (lines.length === 0) return '';
  // 从**最后一条报错行**起取（含它后面那几行）：pnpm 把结论写在报错行的紧后面——
  // `[ERR_PNPM_NO_MATCHING_VERSION] No matching version found for <包名>@1.6.0` 的下一行就是
  // `The latest release of <包名> is "1.5.3".`，那句才是用户最需要的。只挑含 error 的行会把它丢掉。
  // 没有报错行时取末尾几行（pnpm 同样把结论放在最后）。
  const errorAt = lines.reduce((found, line, index) => (/ERR_|error|Error|failed|ENOENT|ETIMEDOUT|ENOTFOUND|E404|EACCES/.test(line) ? index : found), -1);
  const picked = errorAt >= 0 ? lines.slice(errorAt, errorAt + limit) : lines.slice(-limit);
  const joined = picked.join(' ').replace(/\s+/g, ' ').trim();
  return joined.length > 300 ? joined.slice(0, 297) + '…' : joined;
}

/**
 * 升级失败时给用户看的话。
 *
 * 为什么不能只写「升级失败」：desktop 直接改当前 profile 且**没有自动回滚**（见
 * deepseek-harness 的 desktop-in-place-profile 决策），用户必须知道发生了什么、下一步做什么。
 * 这些码来自 plugin-manager 的 ManagementError.code，逐个给出可操作的解释；**未知码**则把
 * 码、退出码和 pnpm 的原文一起带出来——只写一个崩溃码，用户和我们都不无从查起。
 * @param {object|null} error - ChangeResult.error（{code, diagnostic?}）。
 * @param {number|null} exitCode - pnpm 退出码。
 * @param {string|null} output - ChangeResult.packageResult.output（pnpm 的原始输出）。
 * @returns {string} 中文说明。
 */
function upgradeFailureText(error, exitCode, output) {
  const code = error?.code;
  const known = {
    'incompatible-version': t('新版本与当前 DSH 不兼容，未升级。'),
    'not-bundle': t('该包没有声明组合包，不能作为插件安装。'),
    'invalid-spec': t('版本号不合法，未升级。'),
    'ambiguous-install': t('无法确定要升级哪个包，未升级。'),
    'unknown-plugin': t('在 profile 里找不到这个插件，未升级。'),
    'stop-profile': t('宿主正在停止，未升级；请重启后再试。'),
    'bundle-in-use': t('该包正在被使用，未升级。'),
    'stale-approval': t('构建授权已过期，未升级；请重试。'),
    'management-required': t('当前 profile 由应用托管，不允许在这里改动。'),
    'unaddressable': t('这一项无法被单独改动（随 DSH 提供）。'),
  };
  if (known[code]) return known[code];
  // 未知码不吞掉：把码和 pnpm 的退出码如实带出来，否则用户和我们都无从查起。
  const bits = [];
  if (code) bits.push(t('错误码 {code}', { code }));
  if (typeof exitCode === 'number' && exitCode !== 0) bits.push(t('pnpm 退出码 {code}', { code: exitCode }));
  const tail = pnpmOutputTail(output);
  // 已知码的解释已经说清了原因，就不再拿 pnpm 的输出淹没它；未知码才把原文接上。
  if (tail) return (bits.length ? t('升级失败（{bits}）：', { bits: bits.join(t('，')) }) : t('升级失败：')) + tail;
  return bits.length ? t('升级失败（{bits}）。', { bits: bits.join(t('，')) }) : t('升级失败。');
}

function whatsNewFor(current, lastSeen, entries) {
  if (!current || !Array.isArray(entries) || entries.length === 0) return [];
  if (lastSeen === current) return [];
  const index = entries.findIndex((entry) => entry.version === lastSeen);
  return index >= 0 ? entries.slice(index + 1) : entries.filter((entry) => entry.version === current);
}

// 自带 RPC 与状态：面板只管「在这儿渲染一个」。它挂在面板里，就自然随面板挂载/卸载——
// 这正是「升级后第一次打开面板时弹一次」的触发点，不需要另外判开合。
const WhatsNewModal = ({ call }) => {
  const [notice, setNotice] = useState(null);
  const boxRef = useRef(null);
  const confirmRef = useRef(null);
  const bouncedRef = useRef(null);

  // 打开面板时问一次有没有「这次更新」要讲。RPC 失败 / 服务未连接时静默：与 updateHint
  // 同一条理由（纯增值信息，不允许影响面板可用性，也不该在控制台报错吓人）。
  useEffect(() => {
    let alive = true;
    call('whatsNew')
      .then((res) => {
        if (!alive || !res || !res.ok || !Array.isArray(res.entries)) return;
        let seen = null;
        try { seen = localStorage.getItem(WHATS_NEW_SEEN_KEY); } catch { /* 存储不可用：这次仍提示，只是下次还会提示 */ }
        const unseen = whatsNewFor(res.current, seen, res.entries);
        if (unseen.length) setNotice({ current: res.current, entries: unseen });
      })
      .catch(() => { /* 见上：提示失败不影响面板 */ });
    return () => { alive = false; };
  }, []);

  const dismiss = () => {
    try { if (notice?.current) localStorage.setItem(WHATS_NEW_SEEN_KEY, notice.current); } catch { /* 存储不可用：本次关闭有效，下次打开面板会再提示一次 */ }
    setNotice(null);
  };

  // 自己弹出来的东西，键盘可达性就是它自己的责任，而它比面板里那几个多一个坑：
  // 宿主应用会把焦点抢到自己的输入框，所以不能“延迟一点再 focus”——那是在赌对方的时序。
  // 这里用“焦点守卫”：任何落在弹框外的 focusin 都拉回来，同时记下对方本来想聚焦谁，
  // 关闭时还给它（不猜选择器，也不改应用的 DOM）。Esc 关闭；点击遮罩关闭已支持。
  // 依赖跟 notice 而不是空数组：没提示时不该装监听；也不跟 onClose，否则父组件每次重渲染
  // 都会把焦点反复抢回按钮。
  useEffect(() => {
    if (!notice) return undefined;
    confirmRef.current?.focus();
    const onFocusIn = (event) => {
      if (boxRef.current && !boxRef.current.contains(event.target)) {
        bouncedRef.current = event.target;
        confirmRef.current?.focus();
      }
    };
    // 捕获阶段 + stopPropagation：提示渲染在面板内部，而面板自己也有 Esc 处理器（关面板），
    // 不拦住的话按一次 Esc 会把面板和提示一起关掉。这样 Esc 只关最内一层，再按一次才关面板。
    const onKeyDown = (event) => {
      if (event.key !== 'Escape') return;
      event.stopPropagation();
      dismiss();
    };
    document.addEventListener('focusin', onFocusIn);
    document.addEventListener('keydown', onKeyDown, true);
    return () => {
      document.removeEventListener('focusin', onFocusIn);
      document.removeEventListener('keydown', onKeyDown, true);
      const target = bouncedRef.current;
      // 尽力而为：对方可能在弹框期间重建了那个节点（实测过），那就让它留在插件自己的界面上，
      // 而不是去猜一个选择器把焦点塞回应用内部。
      if (target && document.contains(target) && typeof target.focus === 'function') target.focus();
    };
  }, [notice]);

  if (!notice) return null;
  return h(
    'div',
    { className: 'dsh-mcp-overlay', onClick: (e) => e.target === e.currentTarget && dismiss() },
    h(
      'div',
      { ref: boxRef, className: 'dsh-mcp-whatsnew', role: 'dialog', 'aria-modal': 'true', 'aria-label': t('本次更新内容') },
      h('div', { className: 'dsh-mcp-whatsnew-head' },
        // 版本中性：首次打开（没有任何记录）与从旧版本升上来走的是同一个分支，
        // 写「更新到」会把前者的文案说错。
        h('b', null, t('v{version} 的更新', { version: notice.current })),
        h('span', null, t('这些变化你可能想知道')),
      ),
      h('div', { className: 'dsh-mcp-whatsnew-body' },
        notice.entries.map((entry) =>
          h('div', { key: entry.version, className: 'dsh-mcp-whatsnew-entry' },
            // 一次跳多个版本时每条自带版本号；只报一条时标题里的版本号就够了。
            notice.entries.length > 1 ? h('div', { className: 'dsh-mcp-whatsnew-ver' }, 'v' + entry.version) : null,
            entry.items.map((item, position) =>
              h('div', { key: position, className: 'dsh-mcp-whatsnew-item' },
                h('span', { className: 'dsh-mcp-whatsnew-dot', 'aria-hidden': true }, '·'),
                h('span', null,
                  localized(item.text),
                  item.where ? h('span', { className: 'dsh-mcp-whatsnew-where' }, localized(item.where)) : null,
                ),
              ),
            ),
          ),
        ),
      ),
      h('div', { className: 'dsh-mcp-whatsnew-foot' },
        h('button', { ref: confirmRef, type: 'button', className: 'dsh-mcp-btn primary', onClick: dismiss }, t('知道了')),
      ),
    ),
  );
};

