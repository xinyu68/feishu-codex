import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Bot, Check, ChevronDown, ExternalLink, LoaderCircle, Plus, ShieldCheck, Trash2, Unplug, Users, Wifi, X } from 'lucide-react';
import { errorMessage, request } from './api';
import type { AppState, BotProfile } from './types';

type Perform = (name: string, operation: () => Promise<unknown>, success?: string) => Promise<void>;
type Model = { id: string; name: string; efforts: string[]; defaultEffort: string };
const labels = { connected: '飞书已连接', connecting: '飞书连接中', stopped: '飞书未连接', error: '飞书连接异常' };
const effortName = (value: string) => ({ none: '不额外思考', minimal: '精简', low: '快速', medium: '标准', high: '深入', xhigh: '更深入', max: '最高' } as Record<string, string>)[value] || value;

export function botsFromState(state: AppState): BotProfile[] {
  if (state.bots?.length) return state.bots;
  return [{ id: 'default', name: 'Codex', appId: state.config.appId, hasSecret: state.config.hasSecret,
    enabled: state.config.enabled, allowedActors: state.config.allowedActors, allowedGroups: [], roleInstructions: '',
    model: '', effort: '', connection: state.connection }];
}

export function BotManager({ state, action, perform, defaultCredentials }: { state: AppState; action: string; perform: Perform; defaultCredentials: ReactNode }) {
  const bots = botsFromState(state);
  const [selected, setSelected] = useState('default');
  const [adding, setAdding] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [section, setSection] = useState<'connection' | 'access'>('connection');
  const bot = bots.find(item => item.id === selected) || bots[0];
  const busy = Boolean(action);
  const pendingCount = (id: string) => state.pendingActors.filter(item => (item.botId || 'default') === id).length + (state.pendingGroups || []).filter(item => item.botId === id).length;
  return <>
    <div className="bot-toolbar"><label className="bot-picker"><Bot size={17} /><select aria-label="管理机器人" value={bot.id} disabled={busy} onChange={event => { setSelected(event.target.value); setDeleting(false); }}>{bots.map(item => <option key={item.id} value={item.id}>{item.name}{pendingCount(item.id) ? ` · ${pendingCount(item.id)} 项待授权` : ''}</option>)}</select><ChevronDown size={13} /></label><button className="secondary-button" disabled={busy} onClick={() => setAdding(true)}><Plus size={14} />添加机器人</button></div>
    <div className="bot-section-tabs" role="tablist" aria-label="机器人设置"><button role="tab" aria-selected={section === 'connection'} className={section === 'connection' ? 'active' : ''} onClick={() => setSection('connection')}>连接与角色</button><button role="tab" aria-selected={section === 'access'} className={section === 'access' ? 'active' : ''} onClick={() => setSection('access')}>账号与群聊{pendingCount(bot.id) > 0 && <span className="count-badge">{pendingCount(bot.id)}</span>}</button></div>
    {section === 'connection' ? <>{bot.id === 'default' ? defaultCredentials : <BotCredentials key={bot.id} bot={bot} busy={busy} perform={perform} />}<RoleSettings key={`role-${bot.id}`} bot={bot} busy={busy} perform={perform} /></> : <BotAccess key={`access-${bot.id}`} state={state} bot={bot} busy={busy} perform={perform} />}
    {section === 'connection' && bot.id !== 'default' && <div className="bot-removal">{deleting ? <><p>移除「{bot.name}」会断开它的飞书连接。Codex 会话历史会保留。</p><div className="row-buttons"><button className="danger-button" disabled={busy} onClick={() => void perform('remove-bot', async () => { await request(`/api/bots/${encodeURIComponent(bot.id)}`, {}, 'DELETE'); setSelected('default'); setDeleting(false); }, '已移除机器人')}>确认移除</button><button className="text-button" disabled={busy} onClick={() => setDeleting(false)}>取消</button></div></> : <button className="text-button" disabled={busy} onClick={() => setDeleting(true)}><Trash2 size={13} />移除这个机器人</button>}</div>}
    {adding && <AddBotDialog close={() => setAdding(false)} created={id => { setAdding(false); setSelected(id); setSection('connection'); }} perform={perform} />}
  </>;
}

function BotCredentials({ bot, busy, perform }: { bot: BotProfile; busy: boolean; perform: Perform }) {
  const [appId, setAppId] = useState(bot.appId);
  const [secret, setSecret] = useState('');
  const [hint, setHint] = useState('');
  const [saving, setSaving] = useState(false);
  const inFlight = useRef(false);
  const edited = appId.trim() !== bot.appId || Boolean(secret.trim()) || !bot.hasSecret;
  const connected = bot.connection.status === 'connected' || bot.connection.status === 'connecting';
  async function save() {
    if (inFlight.current || !edited) return;
    const nextId = appId.trim(); const nextSecret = secret.trim();
    if (!/^cli_[a-zA-Z0-9]+$/.test(nextId)) { setHint('App ID 应为 cli_ 开头的字母和数字。'); return; }
    if ((nextId !== bot.appId || !bot.hasSecret) && !nextSecret) { setHint('请填写这个 App ID 对应的 App Secret。'); return; }
    setHint(''); setSaving(true); inFlight.current = true;
    try {
      await perform('bot-credentials', async () => {
        await request(`/api/bots/${encodeURIComponent(bot.id)}/credentials`, { appId: nextId, appSecret: nextSecret });
        setSecret('');
      }, '凭据已验证，正在连接');
    } finally { inFlight.current = false; setSaving(false); }
  }
  return <section className="settings-section"><div className="section-heading"><h3>应用凭据</h3><span className="inline-status"><span className={`status-dot ${bot.connection.status === 'connected' ? 'good' : ''}`} />{labels[bot.connection.status]}</span></div>
    <div className="form-grid credential-fields" onBlur={event => { if (!event.currentTarget.contains(event.relatedTarget)) void save(); }}><label className="field-label">App ID<input disabled={saving || busy} value={appId} placeholder="cli_…" autoComplete="off" spellCheck={false} onChange={event => { setAppId(event.target.value); setHint(''); }} /></label><label className="field-label">App Secret<span className="field-hint">{bot.hasSecret ? '已保存，留空保留现有密钥' : '只保存在本机'}</span><input disabled={saving || busy} type="password" value={secret} autoComplete="new-password" placeholder={bot.hasSecret ? '••••••••••••••••' : '填写应用密钥'} onChange={event => { setSecret(event.target.value); setHint(''); }} /></label></div>
    <p className="section-description">{saving ? '正在验证并连接…' : '离开输入框后自动验证并连接。'}</p><a className="settings-external-link" href="https://open.feishu.cn/app" target="_blank" rel="noopener noreferrer">飞书开发者后台：open.feishu.cn/app<ExternalLink size={12} /></a>
    {hint && <p className="field-error" role="alert">{hint}</p>}<div className="settings-action-row"><button className="secondary-button" disabled={busy || saving || !appId.trim() || (!secret.trim() && !bot.hasSecret)} onClick={() => { if (edited) void save(); else void perform('bot-connection', () => request(`/api/bots/${encodeURIComponent(bot.id)}/connection`, { enabled: !connected })); }}>{!edited && connected ? <Unplug size={14} /> : <Wifi size={14} />}{edited ? '验证并连接' : connected ? '断开连接' : '连接飞书'}</button></div>{bot.connection.detail && <p className="field-error">{bot.connection.detail}</p>}
  </section>;
}

function RoleSettings({ bot, busy, perform }: { bot: BotProfile; busy: boolean; perform: Perform }) {
  const [name, setName] = useState(bot.name);
  const [role, setRole] = useState(bot.roleInstructions);
  const [models, setModels] = useState<Model[]>([]);
  const [open, setOpen] = useState(false);
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    void request<{ models: Model[] }>('/api/models').then(result => { if (!cancelled) setModels(result.models); }).catch(() => {});
    return () => { cancelled = true; };
  }, [open]);
  const save = (patch: Record<string, unknown>) => perform('bot-role', () => request(`/api/bots/${encodeURIComponent(bot.id)}`, patch, 'PATCH'), '机器人设置已保存');
  return <details className="bot-role-settings" onToggle={event => setOpen(event.currentTarget.open)}><summary><span><Bot size={15} />名称与角色</span><small>{bot.roleInstructions ? '已设置角色' : '可选'}</small><ChevronDown size={13} /></summary><div className="bot-role-fields"><label className="field-label">机器人名称<input value={name} maxLength={60} disabled={busy} placeholder="例如：产品经理、开发、测试" onChange={event => setName(event.target.value)} onBlur={() => { const value = name.trim(); if (!value) setName(bot.name); else if (value !== bot.name) void save({ name: value }); }} /></label><label className="field-label">角色说明<textarea rows={4} maxLength={12000} disabled={busy} value={role} placeholder="描述这个机器人的职责、工作方式和输出要求。" onChange={event => setRole(event.target.value)} onBlur={() => { if (role.trim() !== bot.roleInstructions) void save({ roleInstructions: role.trim() }); }} /></label><div className="form-grid"><label className="field-label">机器人模型<select value={bot.model} disabled={busy} onChange={event => { const model = models.find(item => item.id === event.target.value); void save({ model: event.target.value, effort: model?.defaultEffort || '' }); }}><option value="">沿用本机 Codex 配置</option>{bot.model && !models.some(item => item.id === bot.model) && <option value={bot.model}>{bot.model}</option>}{models.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label><label className="field-label">机器人思考深度<select value={bot.effort} disabled={busy} onChange={event => void save({ effort: event.target.value })}><option value="">沿用本机 Codex 配置</option>{(models.find(item => item.id === bot.model)?.efforts || ['low', 'medium', 'high', 'xhigh']).map(value => <option key={value} value={value}>{effortName(value)}</option>)}</select></label></div><p className="section-description">角色修改在新会话生效，已有会话保持原角色。</p></div></details>;
}

function BotAccess({ state, bot, busy, perform }: { state: AppState; bot: BotProfile; busy: boolean; perform: Perform }) {
  const [actor, setActor] = useState('');
  const [group, setGroup] = useState('');
  const pendingActors = state.pendingActors.filter(item => (item.botId || 'default') === bot.id);
  const pendingGroups = (state.pendingGroups || []).filter(item => item.botId === bot.id);
  const actorRequest = (actorId: string, allow: boolean) => request('/api/actors', { botId: bot.id, actorId, allow });
  const groupRequest = (chatId: string, allow: boolean) => request('/api/groups', { botId: bot.id, chatId, allow });
  return <>
    <section className="settings-section"><div className="section-heading"><h3>可以使用机器人的账号</h3><ShieldCheck size={17} /></div><p className="section-description">私聊机器人或在群里 @ 它后，在这里允许自己的账号。授权仅对当前机器人生效。</p>
      {pendingActors.map(item => <div className="actor-row pending" key={item.actorId}><div><strong>新账号请求</strong><small title={item.actorId}>{item.actorId}</small></div><button className="primary-button compact" disabled={busy} onClick={() => void perform('actor', () => actorRequest(item.actorId, true), '已允许这个账号')}>允许访问</button></div>)}
      {bot.allowedActors.map(actorId => <div className="actor-row" key={actorId}><span className="actor-avatar"><ShieldCheck size={16} /></span><div><strong>已授权账号</strong><small title={actorId}>{actorId}</small></div><button className="text-button" disabled={busy} onClick={() => void perform('actor', () => actorRequest(actorId, false), '已撤销账号授权')}>移除</button></div>)}
      {!bot.allowedActors.length && !pendingActors.length && <div className="small-empty">还没有授权账号。先在飞书中给机器人发一条消息。</div>}
      <details className="manual-authorize"><summary>手动添加账号</summary><div className="inline-form"><input aria-label="飞书账号 open_id" value={actor} placeholder="ou_ 开头的账号 ID" onChange={event => setActor(event.target.value)} /><button className="secondary-button" disabled={busy || !actor.trim()} onClick={() => void perform('actor', async () => { await actorRequest(actor.trim(), true); setActor(''); }, '已允许这个账号')}>添加</button></div></details>
    </section>
    <section className="settings-section bot-groups"><div className="section-heading"><h3>允许使用的群聊</h3><Users size={17} /></div><p className="section-description">将机器人加入群聊并 @ 它，再允许群和发起操作的账号。未 @ 的消息不会触发回复。</p>
      {pendingGroups.map(item => <div className="actor-row pending" key={item.chatId}><span className="actor-avatar"><Users size={16} /></span><div><strong>{item.title || '新群聊请求'}</strong><small title={item.chatId}>{item.chatId}</small></div><button className="primary-button compact" disabled={busy} onClick={() => void perform('group', () => groupRequest(item.chatId, true), '已允许这个群聊；群成员仍需账号授权')}>允许群聊</button></div>)}
      {bot.allowedGroups.map(chatId => <div className="actor-row" key={chatId}><span className="actor-avatar"><Users size={16} /></span><div><strong>已授权群聊</strong><small title={chatId}>{chatId}</small></div><button className="text-button" disabled={busy} onClick={() => void perform('group', () => groupRequest(chatId, false), '已撤销群聊授权')}>移除群聊</button></div>)}
      {!bot.allowedGroups.length && !pendingGroups.length && <p className="group-empty">还没有群聊请求。只使用私聊时无需配置。</p>}
      <details className="manual-authorize"><summary>手动添加群聊</summary><div className="inline-form"><input aria-label="飞书群聊 ID" value={group} placeholder="oc_ 开头的群聊 ID" onChange={event => setGroup(event.target.value)} /><button className="secondary-button" disabled={busy || !group.trim()} onClick={() => void perform('group', async () => { await groupRequest(group.trim(), true); setGroup(''); }, '已允许这个群聊')}>添加群聊</button></div></details>
    </section>
  </>;
}

function AddBotDialog({ close, created, perform }: { close: () => void; created: (id: string) => void; perform: Perform }) {
  const [name, setName] = useState('');
  const [appId, setAppId] = useState('');
  const [secret, setSecret] = useState('');
  const [role, setRole] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const nameInput = useRef<HTMLInputElement>(null);
  const dialog = useRef<HTMLDivElement>(null);
  useEffect(() => { nameInput.current?.focus(); }, []);
  async function create() {
    if (saving) return;
    if (!name.trim() || !/^cli_[a-zA-Z0-9]+$/.test(appId.trim()) || !secret.trim()) { setError('请填写名称、正确的 App ID 和 App Secret。'); return; }
    setSaving(true); setError('');
    try {
      let newId = '';
      await perform('add-bot', async () => {
        try {
          const result = await request<{ id?: string; bot?: { id: string } }>('/api/bots', { name: name.trim(), appId: appId.trim(), appSecret: secret.trim(), roleInstructions: role.trim() });
          newId = result.bot?.id || result.id || '';
          if (!newId) throw new Error('未收到机器人编号，请刷新连接列表后确认。');
        } catch (caught) { setError(errorMessage(caught)); throw caught; }
      });
      if (newId) created(newId);
    } finally { setSaving(false); }
  }
  return <div className="overlay modal-overlay" onMouseDown={event => { if (event.target === event.currentTarget && !saving) close(); }}><div className="bot-dialog" role="dialog" aria-modal="true" aria-labelledby="add-bot-title" ref={dialog} onKeyDown={event => {
    if (event.key === 'Escape' && !saving) { event.stopPropagation(); close(); }
    if (event.key !== 'Tab') return;
    const items = [...(dialog.current?.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled), textarea:not(:disabled), a[href]') || [])];
    const first = items[0]; const last = items.at(-1);
    if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
    else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
  }}><div className="drawer-title"><div><span className="eyebrow">FEISHU BOT</span><h2 id="add-bot-title">添加机器人</h2></div><button className="icon-button" aria-label="关闭添加机器人" disabled={saving} onClick={close}><X size={19} /></button></div><p className="section-description">每个机器人使用独立的飞书应用。添加后可拉进同一群，手动 @ 分配工作。</p><div className="bot-dialog-fields"><label className="field-label">机器人名称<input ref={nameInput} disabled={saving} value={name} maxLength={60} placeholder="例如：产品经理" onChange={event => setName(event.target.value)} /></label><div className="form-grid"><label className="field-label">App ID<input disabled={saving} value={appId} autoComplete="off" spellCheck={false} placeholder="cli_…" onChange={event => setAppId(event.target.value)} /></label><label className="field-label">App Secret<input disabled={saving} type="password" value={secret} autoComplete="new-password" placeholder="填写应用密钥" onChange={event => setSecret(event.target.value)} /></label></div><label className="field-label">角色说明<span className="field-hint">可稍后设置</span><textarea disabled={saving} rows={4} maxLength={12000} value={role} placeholder="例如：负责需求分析、产品流程和验收标准；先讨论方案。" onChange={event => setRole(event.target.value)} /></label></div><a className="settings-external-link" href="https://open.feishu.cn/app" target="_blank" rel="noopener noreferrer">创建飞书应用<ExternalLink size={12} /></a>{error && <p className="field-error" role="alert">{error}</p>}<div className="bot-dialog-footer"><span>{saving ? '正在验证应用凭据…' : '凭据仅保存在本机'}</span><button className="secondary-button" disabled={saving} onClick={close}>取消</button><button className="primary-button" disabled={saving || !name.trim() || !appId.trim() || !secret.trim()} onClick={() => void create()}>{saving ? <LoaderCircle className="spin" size={14} /> : <Check size={14} />}{saving ? '正在连接…' : '验证并添加'}</button></div></div></div>;
}
