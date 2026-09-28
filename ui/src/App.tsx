import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Activity, ArrowDown, ArrowUp, Check, ChevronDown, ChevronRight, CircleHelp, Code2, Copy, ExternalLink, Folder, LoaderCircle, MessageSquare, Monitor, MoreHorizontal, Plus, RefreshCw, Search, Settings2, ShieldCheck, Square, Terminal, Unplug, Wifi, X } from 'lucide-react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { errorMessage, getHistory, getProjects, getSessions, getState, isDemo, request } from './api';
import type { AppState, Config, Conversation, DesktopAction, DesktopPreferences, DesktopResult, DesktopStatus, Message, PendingRequest, Project, Session } from './types';
import { useConfigAutosave, type ConfigAutosave, type ConfigPatch } from './useConfigAutosave';

const basename = (value: string) => value.replace(/[\\/]+$/, '').split(/[\\/]/).at(-1) || '未选择项目';
const shortTime = (value?: string) => value && !Number.isNaN(Date.parse(value)) ? new Date(value).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' }) : '';
const dateLabel = (value: string) => {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  return date.toDateString() === new Date().toDateString() ? shortTime(value) : `${date.getMonth() + 1}月${date.getDate()}日`;
};
const connectionLabel = { connected: '飞书已连接', connecting: '飞书连接中', stopped: '飞书未连接', error: '飞书连接异常' };
const readPreference = (key: string) => { try { return localStorage.getItem(key) || ''; } catch { return ''; } };
const writePreference = (key: string, value: string) => { try { localStorage.setItem(key, value); } catch { /* Optional convenience. */ } };

function IconButton({ title, children, onClick, disabled, className = '' }: { title: string; children: ReactNode; onClick?: () => void; disabled?: boolean; className?: string }) {
  return <button className={`icon-button ${className}`} title={title} aria-label={title} onClick={onClick} disabled={disabled}>{children}</button>;
}
function Brand({ small = false }: { small?: boolean }) { return <img className={`brand-mark ${small ? 'small' : ''}`} src="/feishu-codex-icon.png" alt="Feishu Codex" draggable={false} />; }
function StatusDot({ good, busy = false }: { good?: boolean; busy?: boolean }) { return <span className={`status-dot ${good ? 'good' : ''} ${busy ? 'busy' : ''}`} />; }
function CopyButton({ text, label = '复制' }: { text: string; label?: string }) {
  const [copied, setCopied] = useState(false);
  useEffect(() => { if (!copied) return; const timer = setTimeout(() => setCopied(false), 1800); return () => clearTimeout(timer); }, [copied]);
  return <button className="copy-button" title={label} aria-label={label} onClick={() => { void navigator.clipboard.writeText(text).then(() => setCopied(true)).catch(() => {}); }}>{copied ? <Check size={13} /> : <Copy size={13} />}</button>;
}
function textOf(node: ReactNode): string {
  if (typeof node === 'string' || typeof node === 'number') return String(node);
  if (Array.isArray(node)) return node.map(textOf).join('');
  if (node && typeof node === 'object' && 'props' in node) return textOf((node.props as { children?: ReactNode }).children);
  return '';
}
function Markdown({ text }: { text: string }) {
  return <div className="markdown"><ReactMarkdown remarkPlugins={[remarkGfm]} skipHtml components={{
    a: ({ children, ...props }) => <a {...props} target="_blank" rel="noreferrer noopener">{children}</a>,
    pre: ({ children }) => <div className="code-block"><div className="code-toolbar"><span>代码</span><CopyButton text={textOf(children)} label="复制代码" /></div><pre>{children}</pre></div>,
    table: ({ children }) => <div className="table-scroll"><table>{children}</table></div>
  }}>{text}</ReactMarkdown></div>;
}

function durationLabel(milliseconds: number): string {
  const seconds = Math.max(0, Math.floor(milliseconds / 1000));
  if (seconds < 60) return `${seconds}秒`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}分${String(seconds % 60).padStart(2, '0')}秒`;
  return `${Math.floor(minutes / 60)}小时${minutes % 60}分`;
}

function WorkingIndicator({ conversation }: { conversation: Conversation }) {
  const [now, setNow] = useState(Date.now());
  const [observedAt] = useState(Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);
  const runtimeStart = Date.parse(conversation.startedAt || '');
  const startedAt = Number.isNaN(runtimeStart) ? observedAt : runtimeStart;
  const runtimeActivity = Date.parse(conversation.lastActivityAt || '');
  const lastActivity = Number.isNaN(runtimeActivity) ? observedAt : runtimeActivity;
  const silentFor = Math.max(0, now - lastActivity);
  const progress = conversation.progress || (silentFor >= 30_000 ? '暂未收到新的运行信息' : '正在等待 Codex 更新');
  return <div className="working-indicator"><span className="working-symbol"><LoaderCircle size={15} className="spin" /></span><div><strong>Codex 正在处理</strong><span>{progress}</span><small className="working-meta">{Number.isNaN(runtimeStart) ? '页面已等待' : '已运行'} {durationLabel(now - startedAt)}{silentFor >= 10_000 && ` · ${durationLabel(silentFor)}没有新进度`}</small></div></div>;
}

export function App() {
  const [state, setState] = useState<AppState>();
  const configSave = useConfigAutosave(config => setState(previous => previous ? { ...previous, config } : previous));
  const [desktop, setDesktop] = useState<DesktopStatus>();
  const [page, setPage] = useState<'chat' | 'settings'>(() => new URLSearchParams(window.location.search).get('setup') === 'feishu' ? 'settings' : 'chat');
  const firstStateSeen = useRef(false);
  const [projects, setProjects] = useState<Project[]>([]);
  const [sessions, setSessions] = useState<Session[]>([]);
  const [messages, setMessages] = useState<Message[]>([]);
  const [chatId, setChatId] = useState(() => readPreference('feishu-codex.chat'));
  const [search, setSearch] = useState('');
  const [projectSearch, setProjectSearch] = useState('');
  const [projectMenu, setProjectMenu] = useState(false);
  const [logsOpen, setLogsOpen] = useState(false);
  const [helpOpen, setHelpOpen] = useState(false);
  const [error, setError] = useState('');
  const [offline, setOffline] = useState(false);
  const [toast, setToast] = useState('');
  const [action, setAction] = useState('');
  const [historyLoading, setHistoryLoading] = useState(false);
  const [sessionsLoading, setSessionsLoading] = useState(false);
  const [epoch, setEpoch] = useState(0);
  const [draft, setDraft] = useState('');
  const [showJump, setShowJump] = useState(false);
  const refreshRunning = useRef(false);
  const refreshAgain = useRef(false);
  const scroll = useRef<HTMLDivElement>(null);
  const pinnedToBottom = useRef(true);
  const composer = useRef<HTMLTextAreaElement>(null);
  const projectMenuRef = useRef<HTMLDivElement>(null);
  const currentThread = useRef<string | undefined>(undefined);
  const streamed = useRef(new Map<string, { message: Message; sequence: number }>());
  const streamSequence = useRef(0);
  const lastStreamRefresh = useRef(0);
  const currentBinding = useRef('');
  const lastActionError = useRef('');
  const sessionWorkspace = useRef('');
  const pendingSubmission = useRef<{ binding: string; text: string; id: string } | undefined>(undefined);
  const active = state?.conversations.find((item) => item.chatId === chatId);
  const cwd = active?.cwd || state?.config.defaultWorkspace || '';
  const threadId = active?.threadId;
  const bindingKey = JSON.stringify([chatId, cwd, active?.revision ?? 0]);
  currentBinding.current = bindingKey;
  currentThread.current = threadId;
  const busy = Boolean(active?.busy);
  const canWrite = !offline && desktop?.canWrite !== false;
  const independentDesktop = desktop?.desktop?.mode === 'independent';
  const switchingDesktop = desktop?.launch?.state === 'switching' || desktop?.launch?.state === 'confirming';
  const openingDesktop = desktop?.launch?.state === 'opening';
  const canOpenDesktop = desktop?.desktop?.mode === 'shared' || (desktop?.canWrite === true && desktop?.runtime?.state === 'ready' && desktop?.bridge?.state === 'ready');
  const capability = collaborationStatus(state, desktop, offline);
  const selectedSession = sessions.find((item) => item.id === threadId);
  const taskTitle = selectedSession?.title || active?.title || '新任务';
  const pending = state?.pendingRequests.filter((item) => item.chatId === chatId) || [];
  const visibleSessions = useMemo(() => sessions.filter((item) => `${item.title} ${item.preview}`.toLowerCase().includes(search.toLowerCase())), [sessions, search]);

  const refresh = useCallback(async () => {
    if (refreshRunning.current) { refreshAgain.current = true; return; }
    refreshRunning.current = true;
    try {
      const next = await getState();
      setState(next); setOffline(false); setEpoch((value) => value + 1);
      if (!firstStateSeen.current) {
        firstStateSeen.current = true;
        if (!isDemo && !next.config.appId && !next.config.hasSecret) setPage('settings');
      }
      setError((previous) => previous === '暂时无法连接本机服务，正在尝试恢复。' ? '' : previous);
      if (next.runtime && !window.feishuCodex) setDesktop(next.runtime);
      setChatId((previous) => next.conversations.some((item) => item.chatId === previous) ? previous : next.conversations.find((item) => item.chatId !== 'local-preview')?.chatId || 'local-preview');
    } catch (caught) {
      setOffline(true);
      setError((previous) => previous === '提交结果尚未确认，请先查看任务记录，避免重复发送。' ? previous : errorMessage(caught));
    }
    finally {
      refreshRunning.current = false;
      if (refreshAgain.current) { refreshAgain.current = false; void refresh(); }
    }
  }, []);

  useEffect(() => {
    void refresh();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const changed = () => { if (timer) return; timer = setTimeout(() => { timer = undefined; void refresh(); }, 300); };
    if (isDemo) {
      window.addEventListener('demo-change', changed);
      return () => { window.removeEventListener('demo-change', changed); clearTimeout(timer); };
    }
    const source = new EventSource('/api/events');
    source.onmessage = changed;
    source.onopen = changed;
    for (const event of ['state', 'history', 'changed']) source.addEventListener(event, changed);
    source.addEventListener('runtime', (event) => {
      try {
        const { delta } = JSON.parse((event as MessageEvent<string>).data) as { delta?: { threadId: string; turnId: string; itemId: string; text: string; phase?: string } };
        if (!delta) { changed(); return; }
        if (delta.threadId !== currentThread.current || !delta.text) return;
        const message: Message = { id: delta.itemId, role: 'assistant', text: delta.text, turnId: delta.turnId, phase: delta.phase, streaming: true };
        streamed.current.set(message.id, { message, sequence: ++streamSequence.current });
        setMessages((previous) => {
          const index = previous.findIndex((item) => item.id === message.id);
          if (index < 0) return [...previous, message];
          const next = [...previous]; next[index] = { ...previous[index], ...message }; return next;
        });
        if (Date.now() - lastStreamRefresh.current >= 4000) { lastStreamRefresh.current = Date.now(); changed(); }
      } catch { changed(); }
    });
    // SSE handles normal updates; this interval also recovers a backend that was unavailable at startup.
    let streamAlive = false;
    source.addEventListener('open', () => { streamAlive = true; });
    source.addEventListener('error', () => { streamAlive = false; });
    const fallback = setInterval(() => { if (!streamAlive) void refresh(); }, 4000);
    return () => { source.close(); clearInterval(fallback); clearTimeout(timer); };
  }, [refresh]);

  useEffect(() => {
    if (!state) return;
    let cancelled = false;
    void getProjects().then((value) => { if (!cancelled) setProjects(value.projects); }).catch(() => {});
    return () => { cancelled = true; };
  }, [state?.config.defaultWorkspace, state?.conversations.length, cwd]);

  useEffect(() => {
    if (!cwd) return;
    let cancelled = false;
    if (sessionWorkspace.current !== cwd) { sessionWorkspace.current = cwd; setSessions([]); }
    setSessionsLoading(true);
    void getSessions(cwd).then((value) => { if (!cancelled) setSessions(value.sessions); }).catch((caught) => { if (!cancelled) setError(errorMessage(caught)); }).finally(() => { if (!cancelled) setSessionsLoading(false); });
    return () => { cancelled = true; };
  }, [cwd, threadId, active?.title]);

  useEffect(() => {
    if (!chatId || !state) return;
    let cancelled = false;
    const requestedBinding = bindingKey;
    const sequenceAtRequest = streamSequence.current;
    void getHistory(chatId).then((value) => {
      if (cancelled || currentBinding.current !== requestedBinding) return;
      if (value.threadId !== threadId) { void refresh(); return; }
      const next = value.messages.slice();
      for (const [id, { message: item, sequence }] of streamed.current) {
        const newerThanHistory = sequence > sequenceAtRequest;
        const belongsToActiveTurn = busy && (!active?.activeTurnId || item.turnId === active.activeTurnId);
        if (!newerThanHistory && !belongsToActiveTurn) { streamed.current.delete(id); continue; }
        const index = next.findIndex((candidate) => candidate.id === item.id);
        if (index < 0) next.push(item);
        else if (newerThanHistory || item.text.length > next[index].text.length) next[index] = item;
      }
      setMessages(next); setHistoryLoading(false);
    }).catch((caught) => { if (!cancelled) { setError(errorMessage(caught)); setHistoryLoading(false); } });
    return () => { cancelled = true; };
  }, [chatId, threadId, bindingKey, epoch]);

  useLayoutEffect(() => {
    pendingSubmission.current = undefined;
    streamed.current.clear(); setMessages([]); setHistoryLoading(Boolean(threadId)); setDraft(''); pinnedToBottom.current = true; setShowJump(false);
    if (chatId) writePreference('feishu-codex.chat', chatId);
  }, [bindingKey]);

  useLayoutEffect(() => {
    if (pinnedToBottom.current && scroll.current) scroll.current.scrollTop = scroll.current.scrollHeight;
  }, [messages, busy, pending.length, page]);

  useEffect(() => {
    const content = scroll.current?.firstElementChild;
    if (!content) return;
    const observer = new ResizeObserver(() => {
      if (pinnedToBottom.current && scroll.current) scroll.current.scrollTop = scroll.current.scrollHeight;
    });
    observer.observe(content);
    return () => observer.disconnect();
  }, [page, Boolean(state)]);

  useEffect(() => {
    let cancelled = false;
    const update = async () => {
      try {
        const value = window.feishuCodex ? await window.feishuCodex.getStatus() : !isDemo ? await request<DesktopStatus>('/api/runtime-status') : undefined;
        if (!cancelled && value) setDesktop(value);
      } catch { /* Service startup status is optional while the host becomes ready. */ }
    };
    void update();
    const unsubscribe = window.feishuCodex?.onStatus?.((value) => { if (!cancelled) setDesktop(value); });
    const timer = setInterval(() => { void update(); }, 5000);
    return () => { cancelled = true; clearInterval(timer); unsubscribe?.(); };
  }, []);

  useEffect(() => { if (!toast) return; const timer = setTimeout(() => setToast(''), 3500); return () => clearTimeout(timer); }, [toast]);
  useEffect(() => {
    if (desktop?.actionError && lastActionError.current !== desktop.actionError) {
      lastActionError.current = desktop.actionError; setError(desktop.actionError);
    }
  }, [desktop?.actionError]);
  useEffect(() => {
    if (!projectMenu) return;
    const outside = (event: MouseEvent) => { if (!projectMenuRef.current?.contains(event.target as Node)) setProjectMenu(false); };
    document.addEventListener('mousedown', outside);
    return () => document.removeEventListener('mousedown', outside);
  }, [projectMenu]);
  useEffect(() => {
    const key = (event: KeyboardEvent) => {
      if (event.key === 'Escape') { setProjectMenu(false); setLogsOpen(false); setHelpOpen(false); }
      if ((event.ctrlKey || event.metaKey) && event.key === '/') { event.preventDefault(); composer.current?.focus(); }
    };
    window.addEventListener('keydown', key);
    return () => window.removeEventListener('keydown', key);
  }, []);

  const perform = async (name: string, operation: () => Promise<unknown>, success?: string) => {
    if (action) return;
    setAction(name); setError('');
    try { await operation(); await refresh(); if (success) setToast(success); }
    catch (caught) { setError(errorMessage(caught)); await refresh(); }
    finally { setAction(''); }
  };
  const selectProject = (project: Project) => {
    setProjectMenu(false); setProjectSearch(''); setSearch('');
    if (cwd === project.path) return;
    void perform('binding', () => request('/api/bind', { chatId, cwd: project.path, revision: active?.revision }), '已切换项目，飞书将接续这里的任务');
  };
  const selectSession = (session: Session) => {
    if (session.id === threadId) return;
    void perform('binding', () => request('/api/bind', { chatId, cwd, threadId: session.id, revision: active?.revision }));
  };
  const newTask = () => { void perform('new', () => request('/api/new', { chatId, cwd, revision: active?.revision })); };
  const refreshLists = () => perform('refreshLists', async () => {
    const [projectList, sessionList] = await Promise.all([getProjects(), cwd ? getSessions(cwd) : Promise.resolve({ sessions: [] })]);
    setProjects(projectList.projects); setSessions(sessionList.sessions);
  });
  const send = async () => {
    const text = draft.trim();
    if (!text || action || !canWrite || !cwd) return;
    const saved = pendingSubmission.current;
    const submission = saved?.binding === bindingKey && saved.text === text ? saved : { binding: bindingKey, text, id: crypto.randomUUID() };
    pendingSubmission.current = submission;
    await perform('send', async () => {
      await request('/api/chat', { chatId, cwd, text, revision: active?.revision, messageId: submission.id });
      if (pendingSubmission.current?.id === submission.id) pendingSubmission.current = undefined;
      if (currentBinding.current === submission.binding) {
        setDraft((current) => current.trim() === text ? '' : current);
        pinnedToBottom.current = true;
      }
    });
    composer.current?.focus();
  };
  const desktopAction = async (method: DesktopAction) => {
    if (isDemo) { setToast('界面演示模式，不会启动或关闭真实服务'); return; }
    if (!window.feishuCodex) { setToast(method === 'openCodex' ? '请从 Feishu Codex 桌面应用打开 Codex' : '请在桌面应用中执行这项操作'); return; }
    await perform(method, async () => {
      const result = await window.feishuCodex![method]() as DesktopResult;
      if (result?.cancelled) { setDesktop(await window.feishuCodex!.getStatus()); return; }
      if (result && (result.error || result.ok === false)) throw new Error(result.error || result.message || '操作未完成');
      if (result?.message) setToast(result.message);
      setDesktop(await window.feishuCodex!.getStatus());
    });
  };

  return <div className="app-shell">
    <nav className="rail" aria-label="主导航">
      <div className="rail-brand" title="Feishu Codex"><Brand /></div>
      <div className="rail-items">
        <button className={`rail-button ${page === 'chat' ? 'selected' : ''}`} onClick={() => setPage('chat')} title="对话"><MessageSquare size={21} /><span>对话</span></button>
        <button className={`rail-button ${page === 'settings' ? 'selected' : ''}`} onClick={() => setPage('settings')} title="设置"><Settings2 size={21} /><span>设置</span>{Boolean(state?.pendingActors.length) && <i className="notification-dot" />}</button>
      </div>
      <div className="rail-bottom"><IconButton title="使用帮助" onClick={() => setHelpOpen(true)}><CircleHelp size={20} /></IconButton><span className="rail-version">{isDemo ? '演示' : 'FC'}</span></div>
    </nav>

    <div className="workspace">
      <header className="app-header"><div className="wordmark">Feishu <strong>Codex</strong><span className="wordmark-divider" /><span className="app-section">{page === 'chat' ? '对话工作台' : '偏好设置'}</span></div>
        <div className="header-status"><span className="connection-pill" title={state?.connection.detail || '飞书消息连接状态'}><StatusDot good={state?.connection.status === 'connected'} busy={state?.connection.status === 'connecting'} />{state ? connectionLabel[state.connection.status] : '正在启动'}</span><button className="subtle-button status-trigger" onClick={() => setLogsOpen(true)} title="查看运行状态和日志"><Activity size={15} /><span>{state?.codex.available ? 'Codex 可用' : offline ? '正在重连' : '连接 Codex 中'}</span></button></div>
      </header>

      {error && <div className={`notice-bar ${offline ? 'warning' : 'error'}`} role="alert"><span>{error}</span><button onClick={() => { setError(''); void refresh(); }}><RefreshCw size={13} />重试</button><IconButton title="收起提示" onClick={() => setError('')}><X size={14} /></IconButton></div>}
      {configSave.feedback.error && <div className="notice-bar error" role="alert"><span>{configSave.feedback.error} 修改已保留。</span><button disabled={configSave.feedback.phase === 'saving'} onClick={() => void configSave.retry()}><RefreshCw size={13} />重试保存</button></div>}
      {switchingDesktop ? <div className="notice-bar desktop-guidance opening" role="status"><LoaderCircle size={15} className="spin" /><span>{desktop?.launch?.state === 'confirming' ? '请在弹窗中确认是否重启 Codex。' : '正在重启 Codex 并连接飞书…'}</span></div>
        : independentDesktop ? <div className="notice-bar warning desktop-guidance"><span><strong>Codex 已打开，但尚未连接飞书</strong><small>{desktop?.launch?.state === 'error' ? desktop.launch.message : '飞书发送已暂停。连接会重启 Codex；若有正在运行的任务，将会停止。'}{!window.feishuCodex && '请在 Feishu Codex 桌面应用中连接。'}</small></span>{window.feishuCodex && <button disabled={Boolean(action)} onClick={() => void desktopAction('switchToShared')}>连接飞书<ChevronRight size={14} /></button>}</div>
        : openingDesktop ? <div className="notice-bar desktop-guidance opening" role="status"><LoaderCircle size={15} className="spin" /><span>正在打开 Codex，连接后可与飞书共同操作。</span></div>
        : desktop?.launch?.state === 'error' ? <div className="notice-bar warning desktop-guidance"><span>{desktop.launch.message || 'Codex 尚未打开，可以重试。'}</span><button disabled={Boolean(action)} onClick={() => void desktopAction(canOpenDesktop ? 'openCodex' : 'retry')}>{canOpenDesktop ? '重试打开' : '重试连接'}</button></div>
        : desktop?.canWrite === false && <div className="notice-bar warning"><span>{String(desktop.reason || '当前暂不能发送消息，请查看连接状态。')}</span><button onClick={() => setLogsOpen(true)}>查看状态<ChevronRight size={14} /></button></div>}

      {!state ? <div className="startup"><Brand /><h1>{offline ? '正在恢复连接' : '正在准备工作台'}</h1><p>{offline ? '连接恢复后可继续使用。' : '正在读取项目、任务和飞书连接状态…'}</p><button className="secondary-button" onClick={() => { void desktopAction('retry'); void refresh(); }}><RefreshCw size={15} />重新连接</button></div>
        : page === 'settings' ? <Settings state={state} configSave={configSave} desktop={desktop} action={action} perform={perform} desktopAction={desktopAction} openLogs={() => setLogsOpen(true)} />
        : <main className="workbench">
          <aside className="task-sidebar">
            <div className="sidebar-heading"><span className="eyebrow">工作空间</span><IconButton title="刷新项目与任务" disabled={Boolean(action)} onClick={() => void refreshLists()}><RefreshCw size={14} /></IconButton></div>
            <div className="project-control" ref={projectMenuRef}>
              <button className={`project-button ${projectMenu ? 'open' : ''}`} onClick={() => setProjectMenu(!projectMenu)} disabled={Boolean(action)} aria-expanded={projectMenu}><span className="folder-tile"><Folder size={18} /></span><span className="project-label"><strong>{basename(cwd)}</strong><small>{projects.find((item) => item.path === cwd)?.threadCount ?? sessions.length} 个任务</small></span><ChevronDown size={15} /></button>
              {projectMenu && <div className="project-menu"><label className="search-field"><Search size={15} /><input autoFocus value={projectSearch} onChange={(event) => setProjectSearch(event.target.value)} placeholder="搜索历史项目" /></label><div className="project-options">{projects.filter((item) => `${item.name} ${item.path}`.toLowerCase().includes(projectSearch.toLowerCase())).map((project) => <button key={project.path} className={project.path === cwd ? 'chosen' : ''} onClick={() => selectProject(project)}><Folder size={16} /><span><strong>{project.name}</strong><small title={project.path}>{project.path}</small></span>{project.path === cwd && <Check size={15} />}</button>)}{!projects.length && <p className="small-empty">还没有发现历史项目，可在设置中指定默认目录。</p>}</div></div>}
            </div>
            <button className="new-task-button" onClick={newTask} disabled={Boolean(action) || !cwd}><Plus size={17} />新建任务<span>New</span></button>
            <label className="search-field task-search"><Search size={15} /><input aria-label="搜索任务" placeholder="搜索任务" value={search} onChange={(event) => setSearch(event.target.value)} /><kbd>⌕</kbd></label>
            <div className="list-label"><span>最近任务</span><span>{sessionsLoading ? <LoaderCircle size={12} className="spin" /> : visibleSessions.length}</span></div>
            <div className="session-list">
              {!threadId && !search && <button className="session-item selected" onClick={() => composer.current?.focus()}><div className="session-top"><span>新任务</span><span className="binding-dot" /></div><p>从一个想法开始</p><div className="session-meta"><span className="bound-label">当前接续</span></div></button>}
              {threadId && !selectedSession && !search && <button className="session-item selected"><div className="session-top"><span>{taskTitle}</span><span className="binding-dot" /></div><p>{active?.preview || '当前 Codex 任务'}</p><div className="session-meta"><span className="bound-label">当前接续</span></div></button>}
              {visibleSessions.map((session) => <button key={session.id} className={`session-item ${threadId === session.id ? 'selected' : ''}`} disabled={Boolean(action)} onClick={() => selectSession(session)}><div className="session-top"><span>{session.title || '未命名任务'}</span>{threadId === session.id && <span className="binding-dot" />}</div><p>{session.preview || '打开查看对话内容'}</p><div className="session-meta">{threadId === session.id ? <span className="bound-label">当前接续</span> : <span>{dateLabel(session.updatedAt)}</span>}{threadId === session.id && <span>{busy ? '进行中' : dateLabel(session.updatedAt)}</span>}</div></button>)}
              {!visibleSessions.length && search && <div className="small-empty">没有匹配的任务</div>}
              {!sessionsLoading && !sessions.length && threadId && <div className="small-empty">这里会显示当前项目的历史任务</div>}
            </div>
            <div className="binding-footer"><span className="small-icon"><Wifi size={15} /></span><div><strong>{chatId === 'local-preview' ? '本地工作区' : '与飞书接续'}</strong>{state.conversations.filter((item) => item.chatId !== 'local-preview').length > 1 ? <select aria-label="飞书对话" value={chatId} onChange={(event) => setChatId(event.target.value)}>{state.conversations.map((item, index) => <option key={item.chatId} value={item.chatId}>{item.chatId === 'local-preview' ? '本地工作区' : `飞书对话 ${index + 1}`}</option>)}</select> : <small>{chatId === 'local-preview' ? '连接飞书后即可双端使用' : '选择的项目与任务同步到飞书'}</small>}</div><StatusDot good={chatId !== 'local-preview'} /></div>
          </aside>

          <section className="conversation-pane" aria-label="当前任务">
            <header className="conversation-header"><div className="conversation-heading"><div className="breadcrumb"><Folder size={13} /><span>{basename(cwd)}</span><ChevronRight size={12} /><span>当前任务</span></div><div className="title-row"><h1 title={taskTitle}>{taskTitle}</h1><span className={`task-state ${busy ? 'working' : ''}`}><StatusDot good={!busy} busy={busy} />{busy ? '进行中' : '就绪'}</span></div><div className="directory"><span title={cwd}>{cwd}</span><CopyButton text={cwd} label="复制项目路径" /></div></div><button className="open-codex-button" aria-label={independentDesktop ? '连接飞书' : '打开 Codex'} onClick={() => void desktopAction(independentDesktop ? 'switchToShared' : 'openCodex')} disabled={Boolean(action) || switchingDesktop || openingDesktop}><Monitor size={16} /><span>{switchingDesktop ? '正在连接' : openingDesktop ? '正在打开' : independentDesktop ? '连接飞书' : '打开 Codex'}</span><ExternalLink size={13} /></button></header>
            <div className="chat-area">
              <div className="messages" ref={scroll} onScroll={() => { const element = scroll.current; if (element) { pinnedToBottom.current = element.scrollHeight - element.scrollTop - element.clientHeight < 100; setShowJump(!pinnedToBottom.current); } }}>
                <div className="message-column">
                  {historyLoading && !messages.length ? <div className="history-loading"><LoaderCircle size={19} className="spin" /><span>正在读取任务历史</span></div> : !messages.length ? <div className="empty-conversation"><div className="empty-icon"><Code2 size={29} /></div><h2>接着你的想法，开始做事</h2><p>{chatId === 'local-preview' ? '选择一个项目，开始新的 Codex 任务。' : '这里与飞书接续同一个任务，随时切换设备继续。'}</p><div className="suggestions">{['介绍一下这个项目', '帮我检查当前改动', '继续上一次的工作'].map((text) => <button key={text} onClick={() => { setDraft(text); composer.current?.focus(); }}>{text}<ChevronRight size={14} /></button>)}</div></div> : <>
                    <div className="history-divider"><span /> <span>任务对话</span><span /></div>
                    {messages.map((message, index) => <article className={`message ${message.role}`} key={message.id || `${index}`}><div className="message-avatar">{message.role === 'assistant' ? <Code2 size={16} /> : message.role === 'user' ? '我' : <Activity size={15} />}</div><div className="message-content"><div className="message-author"><strong>{message.role === 'assistant' ? 'Codex' : message.role === 'user' ? '你' : '运行提示'}</strong><span>{shortTime(message.at)}</span>{message.role !== 'system' && <CopyButton text={message.text} label="复制消息" />}</div><Markdown text={message.text} /></div></article>)}
                  </>}
                  {busy && active && <WorkingIndicator key={`${active.chatId}:${active.revision ?? 0}:${threadId ?? ''}:${active.activeTurnId ?? ''}`} conversation={active} />}
                  {pending.map((item) => <QuestionCard key={item.id} request={item} disabled={Boolean(action)} answer={(answer) => perform('answer', () => request('/api/answer', { id: item.id, ...answer }))} />)}
                </div>
              </div>
              {showJump && <button className="jump-bottom" onClick={() => { pinnedToBottom.current = true; scroll.current?.scrollTo({ top: scroll.current.scrollHeight, behavior: 'smooth' }); }}><ArrowDown size={15} />最新消息</button>}
            </div>
            <div className="composer-area"><div className={`composer ${busy ? 'active' : ''}`}><textarea ref={composer} aria-label="发送给 Codex 的消息" placeholder={busy ? '补充要求，直接加入当前任务…' : '告诉 Codex 你想做什么…'} value={draft} rows={2} maxLength={30000} onChange={(event) => setDraft(event.target.value)} onKeyDown={(event) => { if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) { event.preventDefault(); void send(); } }} disabled={!canWrite} /><div className="composer-tools"><div className="model-indicator"><Code2 size={14} /><span>{active?.model || state.config.model || 'Codex 默认模型'}</span><span className="tiny-separator" /><span>{effortLabel(active?.effort || state.config.effort)}</span></div><div className="composer-actions">{busy && <button className="stop-button" disabled={Boolean(action)} onClick={() => void perform('stop', () => request('/api/stop', { chatId, revision: active?.revision }))}><Square size={11} fill="currentColor" />停止</button>}<button className="send-button" aria-label={busy ? '补充当前任务' : '发送消息'} title={busy ? '补充当前任务（Enter）' : '发送（Enter）'} disabled={!draft.trim() || Boolean(action) || !canWrite || !cwd} onClick={() => void send()}>{action === 'send' ? <LoaderCircle size={18} className="spin" /> : <ArrowUp size={19} strokeWidth={2.2} />}</button></div></div></div><div className="composer-caption"><span>{chatId !== 'local-preview' ? '当前选择已与飞书同步' : '本地消息不会主动发送到飞书'}</span><span><kbd>Enter</kbd> 发送 · <kbd>Shift Enter</kbd> 换行</span></div></div>
          </section>
        </main>}
      <footer className="status-bar"><span><StatusDot good={capability.good} /><span className="capability-status">{capability.text}</span>{state?.codex.version && <span className="version-text">{state.codex.version}</span>}</span><span>{window.feishuCodex ? '关闭窗口后，继续在托盘运行' : isDemo ? '界面预览 · 不连接真实服务' : '本机工作台'}<button onClick={() => setLogsOpen(true)}><Terminal size={12} />运行日志</button></span></footer>
    </div>
    {toast && <div className="toast" role="status"><Check size={16} />{toast}</div>}
    {logsOpen && <div className="overlay" onMouseDown={(event) => { if (event.target === event.currentTarget) setLogsOpen(false); }}><aside className="logs-drawer" aria-label="运行状态和日志"><div className="drawer-title"><div><span className="eyebrow">DIAGNOSTICS</span><h2>运行状态与日志</h2></div><IconButton title="关闭日志" onClick={() => setLogsOpen(false)}><X size={20} /></IconButton></div><div className="runtime-overview"><StatusRow label="Codex 后台" value={state?.codex.available ? '已就绪' : '未连接'} good={state?.codex.available} /><StatusRow label="飞书消息" value={state ? connectionLabel[state.connection.status] : '等待连接'} good={state?.connection.status === 'connected'} /><StatusRow label="桌面运行模式" value={desktopModeLabel(desktop)} good={desktop?.desktop?.mode === 'shared'} />{Boolean(desktop?.reason || desktop?.error) && <p className="runtime-detail">{String(desktop?.reason || desktop?.error)}</p>}<div className="row-buttons"><button className="secondary-button" onClick={() => void desktopAction('retry')}><RefreshCw size={14} />重试连接</button><button className="secondary-button" onClick={() => void desktopAction('openLogs')}><Folder size={14} />日志目录</button></div></div><div className="log-heading"><span>最近事件</span><span>{state?.logs.length || 0} 条</span></div><div className="log-list">{state?.logs.map((entry) => <div key={entry.id} className={`log-entry ${entry.level}`}><span>{shortTime(entry.at)}</span><p>{entry.text}</p></div>)}{!state?.logs.length && <div className="small-empty">还没有运行日志</div>}</div><div className="drawer-footer">日志只保存在本机。应用密钥不会在这里展示。</div></aside></div>}
    {helpOpen && <div className="overlay modal-overlay" onMouseDown={(event) => { if (event.target === event.currentTarget) setHelpOpen(false); }}><div className="help-dialog" role="dialog" aria-modal="true" aria-label="如何使用"><div className="drawer-title"><h2>飞书与 Codex，随时接续</h2><IconButton title="关闭帮助" onClick={() => setHelpOpen(false)}><X size={20} /></IconButton></div><p>连接飞书机器人后，在这里或飞书选择项目与会话，就能接着同一项工作。</p><div className="help-item"><span>01</span><div><strong>先连接飞书</strong><p>在“设置 → 飞书连接”填写应用凭据，并允许自己的飞书账号；开发者后台链接也在该页面。</p></div></div><div className="help-item"><span>02</span><div><strong>选择项目和会话</strong><p>工作台与飞书共享选择。原 Codex 图标单独打开时不连接飞书；桌面切换标签也不会改变飞书绑定的会话。</p></div></div><div className="help-item"><span>03</span><div><strong>控制通知与运行</strong><p>桌面任务可在“Codex 偏好”开启完成通知，或单次说“做完飞书通知我”。开机自启和关闭窗口方式在“应用与运行”设置。</p></div></div><div className="help-commands"><strong>飞书快捷命令</strong><p>/project 项目　/session 会话　/new 新建<br />/stop 停止　/model 模型　/effort 推理强度<br />/usage 套餐余量　/status 当前状态　/help 帮助</p></div><button className="primary-button full-width" onClick={() => setHelpOpen(false)}>开始使用</button></div></div>}
  </div>;
}

function collaborationStatus(state: AppState | undefined, desktop: DesktopStatus | undefined, offline: boolean) {
  if (desktop?.desktop?.mode === 'independent') return { text: 'Codex 未接入飞书，飞书发送已暂停', good: false };
  if (offline || !state?.codex.available || desktop?.runtime?.state !== 'ready' || desktop?.bridge?.state !== 'ready') return { text: '连接尚未就绪，飞书暂不可用', good: false };
  if (state.connection.status !== 'connected') return { text: '飞书尚未连接', good: false };
  if (desktop?.canWrite !== true) return { text: '正在确认桌面状态，飞书发送已暂停', good: false };
  if (desktop.desktop?.mode === 'shared') return { text: '飞书与桌面可共同操作', good: true };
  if (desktop.desktop?.mode === 'closed') return { text: '飞书可用，Codex 桌面未打开', good: true };
  return { text: '正在确认桌面状态', good: false };
}
function desktopModeLabel(desktop?: DesktopStatus) {
  return ({ shared: '可与飞书接续', independent: '未接入飞书', closed: '未打开' } as Record<string, string>)[desktop?.desktop?.mode || ''] || '正在确认';
}
function effortLabel(value: string) { return ({ none: '不额外思考', minimal: '精简', low: '快速', medium: '标准', high: '深入', xhigh: '更深入', max: '最高' } as Record<string, string>)[value] || (value || '默认思考'); }
function StatusRow({ label, value, good }: { label: string; value: string; good?: boolean }) { return <div className="status-row"><span>{label}</span><span><StatusDot good={good} />{value}</span></div>; }
function QuestionCard({ request: pending, disabled, answer }: { request: PendingRequest; disabled: boolean; answer: (body: Record<string, unknown>) => Promise<void> }) {
  const [answers, setAnswers] = useState<Record<string, string>>({});
  return <div className="question-card"><div><CircleHelp size={17} /><strong>{pending.title || '需要你的补充'}</strong></div><Markdown text={pending.text} />{pending.questions?.map((question) => <label key={question.id} className="field-label">{question.question}{question.options && <div className="question-options">{question.options.map((option) => <button key={option.label} className={answers[question.id] === option.label ? 'chosen' : ''} title={option.description} onClick={() => setAnswers({ ...answers, [question.id]: option.label })}>{option.label}</button>)}</div>}<input value={answers[question.id] || ''} placeholder="输入你的回答" onChange={(event) => setAnswers({ ...answers, [question.id]: event.target.value })} /></label>)}<div className="row-buttons">{pending.kind === 'approval' ? <><button className="primary-button" disabled={disabled} onClick={() => void answer({ decision: 'accept' })}>允许</button><button className="secondary-button" disabled={disabled} onClick={() => void answer({ decision: 'decline' })}>拒绝</button></> : <button className="primary-button" disabled={disabled || Boolean(pending.questions?.some((question) => !answers[question.id]?.trim()))} onClick={() => void answer({ answers: Object.fromEntries(Object.entries(answers).map(([key, value]) => [key, { answers: [value] }])) })}>提交回答</button>}</div></div>;
}

type Perform = (name: string, operation: () => Promise<unknown>, success?: string) => Promise<void>;
function Settings({ state, configSave, desktop, action, perform, desktopAction, openLogs }: { state: AppState; configSave: ConfigAutosave; desktop?: DesktopStatus; action: string; perform: Perform; desktopAction: (method: DesktopAction) => Promise<void>; openLogs: () => void }) {
  const [tab, setTab] = useState<'connection' | 'defaults' | 'application'>('connection');
  const [form, setForm] = useState<Config>({ ...state.config, ...configSave.draft });
  const [notificationMinutes, setNotificationMinutes] = useState(String(configSave.draft.desktopNotificationMinMinutes ?? state.config.desktopNotificationMinMinutes ?? 1));
  const [notificationMinutesError, setNotificationMinutesError] = useState('');
  const [secret, setSecret] = useState(configSave.draft.appSecret || '');
  const [credentialsHint, setCredentialsHint] = useState('');
  const [credentialSaving, setCredentialSaving] = useState(false);
  const credentials = useRef({ appId: form.appId, secret });
  credentials.current = { appId: form.appId, secret };
  const credentialSave = useRef<{ appId: string; secret: string; promise: Promise<boolean> } | undefined>(undefined);
  const previousSecretDraft = useRef(configSave.draft.appSecret);
  useEffect(() => {
    const previous = previousSecretDraft.current;
    previousSecretDraft.current = configSave.draft.appSecret;
    if (previous && configSave.draft.appSecret === undefined && form.appId.trim() === state.config.appId && state.config.hasSecret) {
      setSecret(value => value.trim() === previous ? '' : value);
    }
  }, [configSave.draft.appSecret, form.appId, state.config.appId, state.config.hasSecret]);
  const [actor, setActor] = useState('');
  const [models, setModels] = useState<{ id: string; name: string; efforts: string[]; defaultEffort: string }[]>([]);
  const [preferences, setPreferences] = useState<DesktopPreferences>();
  const [preferencesError, setPreferencesError] = useState('');
  const [workspacePicking, setWorkspacePicking] = useState(false);
  const [workspaceError, setWorkspaceError] = useState('');
  useEffect(() => {
    let cancelled = false;
    if (window.feishuCodex?.getPreferences && !isDemo) void window.feishuCodex.getPreferences().then((value) => { if (!cancelled) setPreferences(value); }).catch((caught) => { if (!cancelled) setPreferencesError(errorMessage(caught)); });
    return () => { cancelled = true; };
  }, []);
  const saveDesktopPreferences = (patch: Partial<DesktopPreferences>, success: string) => perform('preferences', async () => {
    if (!preferences) return;
    const value = await window.feishuCodex!.setPreferences({ ...preferences, ...patch });
    setPreferences(value); setPreferencesError('');
  }, success);
  useEffect(() => { if (tab === 'defaults') void request<{ models: typeof models }>('/api/models').then((value) => setModels(value.models)).catch(() => {}); }, [tab]);
  const savePreference = (patch: ConfigPatch) => {
    setForm(previous => ({ ...previous, ...patch }));
    void configSave.save(patch);
  };
  const chooseWorkspace = async () => {
    if (!window.feishuCodex?.chooseWorkspace || workspacePicking) return;
    setWorkspacePicking(true);
    setWorkspaceError('');
    try {
      const selected = await window.feishuCodex.chooseWorkspace();
      if (selected && selected !== form.defaultWorkspace) savePreference({ defaultWorkspace: selected });
    } catch (caught) {
      setWorkspaceError(`无法选择文件夹：${errorMessage(caught)}`);
    } finally {
      setWorkspacePicking(false);
    }
  };
  const saveNotificationMinutes = () => {
    const minutes = Number(notificationMinutes);
    if (!notificationMinutes.trim() || !Number.isInteger(minutes) || minutes < 1 || minutes > 1440) {
      setNotificationMinutesError('请输入 1–1440 的整数分钟'); return;
    }
    setNotificationMinutesError('');
    setNotificationMinutes(String(minutes));
    if (minutes !== state.config.desktopNotificationMinMinutes || configSave.draft.desktopNotificationMinMinutes !== undefined) savePreference({ desktopNotificationMinMinutes: minutes });
  };
  const saveCredentials = (): Promise<boolean> => {
    const appId = credentials.current.appId.trim();
    const appSecret = credentials.current.secret.trim();
    if (!appId) { setCredentialsHint('填好 App ID 和 App Secret 后会自动保存。'); return Promise.resolve(false); }
    if (!/^cli_[a-zA-Z0-9]+$/.test(appId)) { setCredentialsHint('App ID 应为 cli_ 开头的字母和数字。'); return Promise.resolve(false); }
    if ((appId !== state.config.appId || !state.config.hasSecret || (configSave.draft.appId !== undefined && configSave.draft.appId !== appId)) && !appSecret) {
      setCredentialsHint('请填写这个 App ID 对应的 App Secret，两项将一起自动保存。');
      return Promise.resolve(false);
    }
    setCredentialsHint('');
    const pending = credentialSave.current;
    if (pending?.appId === appId && pending.secret === appSecret) return pending.promise;
    if (appId === state.config.appId && !appSecret) return Promise.resolve(true);
    setCredentialSaving(true);
    const promise = configSave.saveCredentials({ appId, appSecret });
    credentialSave.current = { appId, secret: appSecret, promise };
    void promise.then(saved => {
      if (saved && credentials.current.appId.trim() === appId && credentials.current.secret.trim() === appSecret) setSecret('');
      if (credentialSave.current?.promise === promise) credentialSave.current = undefined;
    }).finally(() => setCredentialSaving(false));
    return promise;
  };
  const busy = Boolean(action);
  const credentialsEdited = form.appId.trim() !== state.config.appId || Boolean(secret.trim()) || !state.config.hasSecret;
  return <main className="settings-page"><aside className="settings-nav"><span className="eyebrow">偏好设置</span><h1>按你的方式连接</h1><p>管理连接、访问权限和应用偏好。</p><button className={tab === 'connection' ? 'active' : ''} onClick={() => setTab('connection')}><Wifi size={17} />飞书连接{state.pendingActors.length > 0 && <span className="count-badge">{state.pendingActors.length}</span>}</button><button className={tab === 'defaults' ? 'active' : ''} onClick={() => setTab('defaults')}><Code2 size={17} />Codex 偏好</button><button className={tab === 'application' ? 'active' : ''} onClick={() => setTab('application')}><Monitor size={17} />应用与运行</button><div className={`settings-save-status ${configSave.feedback.phase}`} role="status" aria-live="polite">{configSave.feedback.phase === 'saving' ? <><LoaderCircle size={13} className="spin" />正在保存…</> : configSave.feedback.phase === 'saved' ? <><Check size={13} />已保存</> : configSave.feedback.phase === 'error' ? '尚未保存，请重试' : '修改后自动保存'}</div></aside><div className={`settings-content ${tab === 'application' ? 'application-settings' : tab === 'defaults' ? 'defaults-settings' : ''}`}>
    {tab === 'connection' && <><div className="settings-title"><span className="section-icon"><Wifi size={21} /></span><div><h2>飞书连接</h2><p>创建或连接飞书机器人，让它接入你的 Codex 工作空间。</p></div></div><section className="settings-section"><div className="section-heading"><h3>应用凭据</h3><span className="inline-status"><StatusDot good={state.connection.status === 'connected'} />{connectionLabel[state.connection.status]}</span></div><div className="form-grid credential-fields" onBlur={(event) => { if (!event.currentTarget.contains(event.relatedTarget)) void saveCredentials(); }}><label className="field-label">App ID<input disabled={credentialSaving} value={form.appId} placeholder="cli_…" autoComplete="off" spellCheck={false} onChange={(event) => { setForm({ ...form, appId: event.target.value }); setCredentialsHint(''); }} /></label><label className="field-label">App Secret<span className="field-hint">{state.config.hasSecret ? '已保存，留空保留现有密钥' : '只保存在本机'}</span><input disabled={credentialSaving} value={secret} type="password" placeholder={state.config.hasSecret ? '••••••••••••••••' : '填写应用密钥'} autoComplete="new-password" onChange={(event) => { setSecret(event.target.value); setCredentialsHint(''); }} /></label></div><p className="section-description">{credentialSaving ? "正在验证并连接…" : "离开输入框后自动验证并连接。"}</p><a className="settings-external-link" href="https://open.feishu.cn/app" target="_blank" rel="noopener noreferrer">飞书开发者后台：open.feishu.cn/app<ExternalLink size={12} /></a>{credentialsHint && <p className="field-error" role="alert">{credentialsHint}</p>}<div className="settings-action-row"><button className="secondary-button" disabled={busy || credentialSaving || !form.appId.trim() || (!secret.trim() && !state.config.hasSecret)} onClick={() => { if (credentialsEdited) { void saveCredentials(); return; } void perform('connection', () => request('/api/connection', { enabled: state.connection.status !== 'connected' && state.connection.status !== 'connecting' })); }}>{credentialsEdited || (state.connection.status !== 'connected' && state.connection.status !== 'connecting') ? <Wifi size={14} /> : <Unplug size={14} />}{credentialsEdited ? '验证并连接' : state.connection.status === 'connected' || state.connection.status === 'connecting' ? '断开连接' : '连接飞书'}</button></div>{state.connection.detail && <p className="field-error">{state.connection.detail}</p>}</section><section className="settings-section"><div className="section-heading"><h3>可以使用机器人的账号</h3><ShieldCheck size={17} /></div><p className="section-description">首次私聊机器人后，账号会出现在这里，允许后才能操作本机 Codex。</p>{state.pendingActors.map((item) => <div className="actor-row pending" key={item.actorId}><div><strong>新账号请求</strong><small title={item.actorId}>{item.actorId}</small></div><button className="primary-button compact" disabled={busy} onClick={() => void perform('actor', () => request('/api/actors', { actorId: item.actorId, allow: true }), '已允许这个账号')}>允许访问</button></div>)}{state.config.allowedActors.map((actorId) => <div className="actor-row" key={actorId}><span className="actor-avatar"><ShieldCheck size={16} /></span><div><strong>已授权账号</strong><small title={actorId}>{actorId}</small></div><button className="text-button" disabled={busy} onClick={() => void perform('actor', () => request('/api/actors', { actorId, allow: false }), '已撤销账号授权')}>移除</button></div>)}{!state.config.allowedActors.length && !state.pendingActors.length && <div className="small-empty">还没有授权账号。先在飞书中给机器人发一条消息。</div>}<details className="manual-authorize"><summary>手动添加账号</summary><div className="inline-form"><input aria-label="飞书账号 open_id" value={actor} placeholder="ou_ 开头的账号 ID" onChange={(event) => setActor(event.target.value)} /><button className="secondary-button" disabled={busy || !actor.trim()} onClick={() => void perform('actor', async () => { await request('/api/actors', { actorId: actor.trim(), allow: true }); setActor(''); }, '已允许这个账号')}>添加</button></div></details></section></>}
    {tab === 'defaults' && <><div className="settings-title"><span className="section-icon"><Code2 size={22} /></span><div><h2>Codex 偏好</h2><p>没有单独指定时，新的任务会使用这些设置。</p></div></div><section className="settings-section"><h3>默认工作空间</h3>{window.feishuCodex?.chooseWorkspace && !isDemo ? <div className="field-label">本机项目目录<div className="workspace-folder-picker"><span className="workspace-folder-path" title={form.defaultWorkspace || '尚未选择文件夹'}>{form.defaultWorkspace || '尚未选择文件夹'}</span><button className="secondary-button" type="button" disabled={workspacePicking} onClick={() => void chooseWorkspace()}><Folder size={14} />{workspacePicking ? '正在选择…' : '选择文件夹'}</button></div>{workspaceError && <p className="field-error" role="alert">{workspaceError}</p>}</div> : <label className="field-label">本机项目目录<input value={form.defaultWorkspace} placeholder="D:\\projectdemo\\my-project" onChange={(event) => setForm({ ...form, defaultWorkspace: event.target.value })} onBlur={(event) => { const defaultWorkspace = event.target.value.trim(); if (defaultWorkspace !== state.config.defaultWorkspace || configSave.draft.defaultWorkspace !== undefined) savePreference({ defaultWorkspace }); }} onKeyDown={(event) => { if (event.key === 'Enter') event.currentTarget.blur(); }} /></label>}<p className="section-description">历史项目会自动发现。默认目录用于尚未选择项目的新对话。</p></section><section className="settings-section"><h3>模型与思考</h3><div className="form-grid"><label className="field-label">默认模型<select value={form.model} onChange={(event) => { const model = models.find((item) => item.id === event.target.value); savePreference({ model: event.target.value, effort: model?.defaultEffort || '' }); }}><option value="">使用 Codex 默认模型</option>{form.model && !models.some((item) => item.id === form.model) && <option value={form.model}>{form.model}</option>}{models.map((model) => <option key={model.id} value={model.id}>{model.name}</option>)}</select></label><label className="field-label">思考深度<select value={form.effort} onChange={(event) => savePreference({ effort: event.target.value })}><option value="">使用默认深度</option>{(models.find((item) => item.id === form.model)?.efforts || ['low', 'medium', 'high', 'xhigh']).map((effort) => <option key={effort} value={effort}>{effortLabel(effort)}</option>)}</select></label></div></section><section className="settings-section"><label className="toggle-row"><span><strong>在飞书显示处理进度</strong><small>让手机端及时知道 Codex 正在处理什么。</small></span><input type="checkbox" checked={form.progress} onChange={(event) => savePreference({ progress: event.target.checked })} /><span className={`toggle ${form.progress ? 'on' : ''}`} /></label><label className="toggle-row desktop-notification-preference"><span><strong>桌面任务完成后通知飞书</strong><small>{form.autoNotifyDesktop ? "仅通知从本应用打开的 Codex；飞书任务不重复通知。" : "需要时可说“做完飞书通知我”，仅通知本轮。"}</small></span><input type="checkbox" aria-label="桌面任务完成后通知飞书" checked={form.autoNotifyDesktop === true} onChange={(event) => savePreference({ autoNotifyDesktop: event.target.checked })} /><span className={`toggle ${form.autoNotifyDesktop ? 'on' : ''}`} /></label>{form.autoNotifyDesktop && <div className="notification-options"><div className="notification-options-row"><label>通知范围<select aria-label="桌面通知范围" value={form.desktopNotificationMode || 'all'} onChange={(event) => savePreference({ desktopNotificationMode: event.target.value as 'all' | 'long' })}><option value="all">每轮都通知</option><option value="long">仅通知长任务</option></select></label>{form.desktopNotificationMode === 'long' && <label className="notification-duration">耗时超过<input type="number" aria-label="长任务通知阈值（分钟）" min="1" max="1440" step="1" value={notificationMinutes} aria-invalid={Boolean(notificationMinutesError)} aria-describedby="notification-duration-hint" onChange={(event) => { setNotificationMinutes(event.target.value); setNotificationMinutesError(''); }} onBlur={saveNotificationMinutes} onKeyDown={(event) => { if (event.key === 'Enter') event.currentTarget.blur(); }} />分钟</label>}</div><p id="notification-duration-hint" className="notification-duration-hint">从本轮开始执行到结束计时；明确要求的通知不受时长限制。</p>{form.desktopNotificationMode === 'long' && notificationMinutesError && <p className="field-error" role="alert">{notificationMinutesError}</p>}</div>}</section></>}
    {tab === 'application' && <>
      <div className="settings-title"><span className="section-icon"><Monitor size={21} /></span><div><h2>应用与运行</h2><p>打开即连接，关闭窗口时按你的偏好处理。</p></div></div>
      <section className="settings-section"><h3>运行状态</h3><StatusRow label="Codex 服务" value={state.codex.available ? '已就绪' : '未连接'} good={state.codex.available} /><StatusRow label="飞书连接" value={connectionLabel[state.connection.status]} good={state.connection.status === 'connected'} /><StatusRow label="当前桌面" value={desktopModeLabel(desktop)} good={desktop?.desktop?.mode === 'shared'} /><div className="row-buttons"><button className="secondary-button" disabled={busy} onClick={() => void desktopAction('retry')}><RefreshCw size={14} />重试连接</button><button className="secondary-button" onClick={openLogs}><Terminal size={14} />查看日志</button></div></section>
      <section className="settings-section"><h3>启动与关闭</h3>{window.feishuCodex?.getPreferences && !isDemo ? <div className="launch-preference">
        <label className="toggle-row"><span><strong>启动应用时同时打开 Codex</strong><small>关闭后仍可在飞书使用 Codex；下次启动生效。</small></span><input type="checkbox" aria-label="启动应用时同时打开 Codex" checked={preferences?.openCodexOnLaunch ?? true} disabled={busy || !preferences} onChange={(event) => void saveDesktopPreferences({ openCodexOnLaunch: event.target.checked }, '启动偏好已保存，下次启动或重新双击应用图标时生效')} /><span className={preferences?.openCodexOnLaunch !== false ? 'toggle on' : 'toggle'} /></label>
        <label className="toggle-row"><span><strong>开机自动启动</strong><small>登录 Windows 后启动 Feishu Codex；是否打开 Codex 由上方设置决定。</small></span><input type="checkbox" aria-label="开机自动启动" checked={preferences?.openAtLogin ?? false} disabled={busy || !preferences} onChange={(event) => void saveDesktopPreferences({ openAtLogin: event.target.checked }, '开机自启设置已保存')} /><span className={preferences?.openAtLogin ? 'toggle on' : 'toggle'} /></label>
        <label className="preference-row close-window-preference"><span><strong>点击窗口关闭按钮</strong><small>{preferences?.closeWindowAction === 'quit' ? '退出前会检查运行中的任务。' : '收起到托盘，任务和飞书连接继续运行。'}</small></span><select aria-label="点击窗口关闭按钮" className="preference-select" value={preferences?.closeWindowAction || 'tray'} disabled={busy || !preferences} onChange={(event) => void saveDesktopPreferences({ closeWindowAction: event.target.value as 'tray' | 'quit' }, '关闭窗口方式已保存')}><option value="tray">收起到托盘</option><option value="quit">退出全部服务</option></select></label>
        {preferencesError && <p className="field-error">无法读取桌面设置：{preferencesError}</p>}
      </div> : <p className="section-description">启动与关闭设置仅在桌面应用中可用。</p>}</section>
      <section className="settings-section about-section"><Brand small /><div><strong>Feishu Codex</strong><p>版本 {desktop?.shellVersion || state.service.version} · 本机运行</p></div><button className="secondary-button" disabled={busy} onClick={() => void desktopAction('quit')}>退出应用</button></section>
    </>}
  </div></main>;
}
