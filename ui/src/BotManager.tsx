import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Bot, Check, ExternalLink, LoaderCircle, Plus, ShieldCheck, Trash2, Unplug, Users, Wifi, X } from 'lucide-react';
import { Select } from './Select';
import { errorMessage, request } from './api';
import type { AppState, BotProfile, DesktopNotificationTarget } from './types';
import type { ConfigAutosave } from './useConfigAutosave';
import './bot-workspace.css';

type Perform = (name: string, operation: () => Promise<unknown>, success?: string) => Promise<void>;
type Refresh = () => Promise<void>;
type Model = { id: string; name: string; efforts: string[]; defaultEffort: string };
type Section = 'conversation' | 'access' | 'connection';
type FieldName = 'name' | 'roleInstructions' | 'privateRoleInstructions' | 'model' | 'effort' | 'includeGroupContext';
type SaveStatus = 'idle' | 'draft' | 'saving' | 'saved' | 'error';
type FieldState<T> = { value: T; status: SaveStatus; error: string; change: (value: T) => void; save: (value?: T) => Promise<void> };
const sections: { id: Section; label: string }[] = [{ id: 'conversation', label: '对话设置' }, { id: 'access', label: '访问权限' }, { id: 'connection', label: '连接设置' }];
const labels = { connected: '已连接', connecting: '连接中', stopped: '未连接', error: '连接异常' };
const effortName = (value: string) => ({ none: '不额外思考', minimal: '精简', low: '快速', medium: '标准', high: '深入', xhigh: '更深入', max: '最高' } as Record<string, string>)[value] || value;
const configured = (bot: BotProfile) => Boolean(bot.appId && bot.hasSecret);
const botRoute = (id: string) => `/api/bots/${encodeURIComponent(id)}`;
const notificationTargetKey = (target: DesktopNotificationTarget) => JSON.stringify([target.botAppId, target.chatId, target.actorId]);

export function botsFromState(state: AppState): BotProfile[] {
  if (state.bots?.length) return state.bots;
  return [{ id: 'default', name: 'Codex', appId: state.config.appId, hasSecret: state.config.hasSecret,
    enabled: state.config.enabled, allowedActors: state.config.allowedActors, allowedGroups: [], roleInstructions: '',
    model: '', effort: '', connection: state.connection }];
}

// Field requests are independent; an earlier response cannot clear a later edit.
function useBotField<T extends string | boolean>(bot: BotProfile, field: FieldName, remote: T, refresh: Refresh): FieldState<T> {
  const [value, setValue] = useState(remote);
  const [status, setStatus] = useState<SaveStatus>('idle');
  const [error, setError] = useState('');
  const current = useRef(remote);
  const saved = useRef(remote);
  const dirty = useRef(false);
  const active = useRef(false);
  const queued = useRef(false);
  useEffect(() => {
    if (!dirty.current && !active.current) { current.current = remote; saved.current = remote; setValue(remote); }
  }, [remote]);
  const change = (next: T) => {
    current.current = next; dirty.current = next !== saved.current;
    setValue(next); setError(''); setStatus(active.current ? 'saving' : dirty.current ? 'draft' : 'idle');
  };
  async function save(next?: T) {
    if (next !== undefined) change(next);
    queued.current = true;
    if (active.current) return;
    active.current = true;
    try {
      while (queued.current) {
        queued.current = false;
        const input = current.current;
        const normalized = (typeof input === 'string' ? input.trim() : input) as T;
        if (field === 'name' && !normalized) { setStatus('error'); setError('请填写机器人名称'); break; }
        if (normalized === saved.current) { dirty.current = false; setValue(normalized); current.current = normalized; setStatus('idle'); continue; }
        setStatus('saving'); setError('');
        try {
          const result = await request<{ bot?: BotProfile }>(botRoute(bot.id), { [field]: normalized }, 'PATCH');
          saved.current = (result.bot?.[field] ?? normalized) as T;
          if (current.current === input) { current.current = saved.current; setValue(saved.current); dirty.current = false; }
          setStatus(dirty.current ? 'draft' : 'saved');
          void refresh().catch(() => {});
        } catch (caught) {
          dirty.current = true; queued.current = false; setStatus('error'); setError(errorMessage(caught)); break;
        }
      }
    } finally { active.current = false; }
  }
  return { value, status, error, change, save };
}

// Model changes also choose that model's default effort in the same write.
function useModelPreferences(bot: BotProfile, models: Model[], refresh: Refresh) {
  type Key = 'model' | 'effort';
  const initial = { model: bot.model, effort: bot.effort };
  const [values, setValues] = useState(initial);
  const [statuses, setStatuses] = useState<Record<Key, SaveStatus>>({ model: 'idle', effort: 'idle' });
  const [errors, setErrors] = useState({ model: '', effort: '' });
  const current = useRef(initial);
  const saved = useRef(initial);
  const failed = useRef({ model: false, effort: false });
  const active = useRef(false);
  const queued = useRef(false);
  useEffect(() => {
    for (const key of ['model', 'effort'] as const) {
      if (!active.current && !failed.current[key] && current.current[key] === saved.current[key]) {
        current.current = { ...current.current, [key]: bot[key] };
        saved.current = { ...saved.current, [key]: bot[key] };
      }
    }
    setValues(current.current);
  }, [bot.model, bot.effort]);
  function change(key: Key, value: string) {
    const patch = key === 'model' ? { model: value, effort: models.find(item => item.id === value)?.defaultEffort || '' } : { effort: value };
    current.current = { ...current.current, ...patch }; setValues(current.current);
    const keys: Key[] = key === 'model' ? ['model', 'effort'] : ['effort'];
    for (const item of keys) { failed.current[item] = false; setErrors(previous => ({ ...previous, [item]: '' })); setStatuses(previous => ({ ...previous, [item]: 'draft' })); }
  }
  async function save(key: Key, value?: string) {
    if (value !== undefined) change(key, value);
    queued.current = true;
    if (active.current) return;
    active.current = true;
    try {
      while (queued.current) {
        queued.current = false;
        const input = { ...current.current };
        const modelChanged = input.model !== saved.current.model || failed.current.model;
        const keys: Key[] = modelChanged ? ['model', 'effort'] : input.effort !== saved.current.effort || failed.current.effort ? ['effort'] : [];
        if (!keys.length) { setStatuses({ model: 'idle', effort: 'idle' }); continue; }
        const patch = modelChanged ? input : { effort: input.effort };
        for (const item of keys) { setStatuses(previous => ({ ...previous, [item]: 'saving' })); setErrors(previous => ({ ...previous, [item]: '' })); }
        try {
          const result = await request<{ bot?: BotProfile }>(botRoute(bot.id), patch, 'PATCH');
          for (const item of keys) {
            saved.current[item] = result.bot?.[item] ?? input[item]; failed.current[item] = false;
            if (current.current[item] === input[item]) current.current = { ...current.current, [item]: saved.current[item] };
            setStatuses(previous => ({ ...previous, [item]: current.current[item] === saved.current[item] ? 'saved' : 'draft' }));
          }
          setValues(current.current); void refresh().catch(() => {});
        } catch (caught) {
          queued.current = false;
          for (const item of keys) { failed.current[item] = true; setErrors(previous => ({ ...previous, [item]: errorMessage(caught) })); setStatuses(previous => ({ ...previous, [item]: 'error' })); }
          break;
        }
      }
    } finally { active.current = false; }
  }
  const field = (key: Key): FieldState<string> => ({ value: values[key], status: statuses[key], error: errors[key], change: value => change(key, value), save: value => save(key, value) });
  return { model: field('model'), effort: field('effort') };
}

function FieldStatus({ field }: { field: { status: SaveStatus; error: string; save: () => Promise<void> } }) {
  return <div className={`bot-field-status ${field.status}`} aria-live="polite">
    {field.status === 'saving' && <><LoaderCircle size={11} className="spin" />保存中…</>}
    {field.status === 'saved' && <><Check size={11} />已保存</>}
    {field.status === 'error' && <><span role="alert">{field.error}</span><button type="button" className="text-button" onClick={() => void field.save()}>重试</button></>}
  </div>;
}

function BotField({ name, label, field, children, hint }: { name: FieldName; label: string; field: FieldState<string>; children: ReactNode; hint?: string }) {
  return <div className="bot-field" data-field={name}><label className="field-label"><span>{label}</span>{children}</label>{hint && <p className="bot-field-hint">{hint}</p>}<FieldStatus field={field} /></div>;
}

export function BotManager({ state, action, perform, refresh, configSave, focusBot }: { state: AppState; action: string; perform: Perform; refresh: Refresh; configSave: ConfigAutosave; focusBot?: { id: string } }) {
  const bots = botsFromState(state);
  const targets = state.notificationTargets || [];
  const savedTarget = state.config.desktopNotificationTarget;
  const targetDraft = configSave.draft.desktopNotificationTarget;
  const target = targetDraft !== undefined ? targetDraft : savedTarget;
  const savedDefault = savedTarget && targets.find(item => notificationTargetKey(item) === notificationTargetKey(savedTarget));
  const draftDefault = targetDraft && targets.find(item => notificationTargetKey(item) === notificationTargetKey(targetDraft));
  const defaultUnavailable = Boolean(target && !targets.some(item => notificationTargetKey(item) === notificationTargetKey(target)));
  const pendingCount = (id: string) => state.pendingActors.filter(item => (item.botId || 'default') === id).length + (state.pendingGroups || []).filter(item => item.botId === id).length;
  const firstUse = !state.conversations.some(item => item.chatId !== 'local-preview');
  const explicitSetup = new URLSearchParams(window.location.search).get('setup') === 'feishu';
  const [selected, setSelected] = useState(() => (explicitSetup ? bots.find(item => item.id === 'default') : firstUse ? bots.find(item => pendingCount(item.id)) || bots.find(item => !configured(item)) || bots.find(item => !item.allowedActors.length) : null)?.id || bots[0].id);
  useEffect(() => { if (focusBot) setSelected(focusBot.id); }, [focusBot]);
  const [adding, setAdding] = useState(false);
  const [tabs, setTabs] = useState<Record<string, Section>>(() => Object.fromEntries(bots.map(bot => [bot.id, !configured(bot) || (explicitSetup && bot.id === 'default') ? 'connection' : firstUse && (pendingCount(bot.id) || !bot.allowedActors.length) ? 'access' : 'conversation'])));
  const [onboarding, setOnboarding] = useState<Record<string, boolean>>({});
  const [models, setModels] = useState<Model[]>([]);
  const [modelError, setModelError] = useState('');
  const addButton = useRef<HTMLButtonElement>(null);
  const selectedBot = bots.find(item => item.id === selected) || bots[0];
  const selectTab = (id: string, section: Section) => setTabs(current => ({ ...current, [id]: section }));
  const loadModels = async () => {
    try { const result = await request<{ models: Model[] }>('/api/models'); setModels(result.models); setModelError(''); }
    catch (caught) { setModelError(errorMessage(caught)); }
  };
  useEffect(() => { void loadModels(); }, []);
  function startAccess(id: string) { setSelected(id); selectTab(id, 'access'); setOnboarding(current => ({ ...current, [id]: true })); }
  function closeDialog() { setAdding(false); addButton.current?.focus(); }
  return <main className="bot-workspace" aria-label="机器人管理">
    <aside className="bot-sidebar" aria-label="机器人列表"><div className="bot-sidebar-heading"><span className="eyebrow">FEISHU BOTS</span><h1>机器人</h1><p>连接应用，安排对话与协作</p></div>
      <div className="bot-list">{bots.map(item => <button key={item.id} type="button" className={`bot-list-item ${selectedBot.id === item.id ? 'selected' : ''}`} aria-label={`管理${item.name}`} aria-pressed={selectedBot.id === item.id} onClick={() => setSelected(item.id)}>
        <span className="bot-list-avatar"><Bot size={18} /></span><span className="bot-list-copy"><strong>{item.name}</strong><span className="bot-list-status"><span className={`status-dot ${item.connection.status === 'connected' ? 'good' : item.connection.status === 'connecting' ? 'busy' : ''}`} />{configured(item) ? labels[item.connection.status] : '待配置'}{savedDefault?.botId === item.id && <span className="bot-default-badge">默认通知</span>}</span>{draftDefault?.botId === item.id && <span className="bot-default-pending">{configSave.feedback.phase === 'saving' ? '保存中…' : '尚未保存'}</span>}{pendingCount(item.id) > 0 && <span className="bot-pending-badge">{pendingCount(item.id)} 项待授权</span>}</span>
      </button>)}</div>
      <button ref={addButton} type="button" className="secondary-button bot-add-button" aria-label="添加机器人" title="添加机器人" disabled={Boolean(action)} onClick={() => setAdding(true)}><Plus size={14} />添加机器人</button>
      <p className="bot-sidebar-note">每个机器人使用独立的飞书应用和访问权限。</p>
      {defaultUnavailable && <div className="bot-default-warning" role="status"><p>默认通知已失效，请重新设置。</p><button type="button" className="text-button" disabled={configSave.feedback.phase === 'saving'} onClick={() => void configSave.save({ desktopNotificationTarget: null })}>清除失效默认</button></div>}
    </aside>
    <div className="bot-detail-stack">{bots.map(bot => <BotDetail key={bot.id} state={state} bot={bot} hidden={bot.id !== selectedBot.id} section={tabs[bot.id] || (configured(bot) ? 'conversation' : 'connection')} changeSection={section => selectTab(bot.id, section)} pending={pendingCount(bot.id)} models={models} modelError={modelError} retryModels={loadModels} busy={Boolean(action)} perform={perform} refresh={refresh} configSave={configSave} onboarding={Boolean(onboarding[bot.id])} startAccess={() => startAccess(bot.id)} removed={() => setSelected('default')} />)}</div>
    {adding && <AddBotDialog close={closeDialog} created={id => { closeDialog(); startAccess(id); }} perform={perform} />}
  </main>;
}

function BotDetail({ state, bot, hidden, section, changeSection, pending, models, modelError, retryModels, busy, perform, refresh, configSave, onboarding, startAccess, removed }: {
  state: AppState; bot: BotProfile; hidden: boolean; section: Section; changeSection: (section: Section) => void; pending: number; models: Model[]; modelError: string; retryModels: () => Promise<void>;
  busy: boolean; perform: Perform; refresh: Refresh; configSave: ConfigAutosave; onboarding: boolean; startAccess: () => void; removed: () => void;
}) {
  const tabsRef = useRef<HTMLDivElement>(null);
  const tabId = (id: Section) => `bot-${bot.id}-tab-${id}`;
  const panelId = (id: Section) => `bot-${bot.id}-panel-${id}`;
  return <section className="bot-detail" hidden={hidden} aria-label={`${bot.name}设置`}>
    <header className="bot-detail-heading"><div><h2>{bot.name}</h2><p>管理这个机器人的对话方式与使用范围</p></div><span className={`bot-connection-status ${bot.connection.status}`}><span className={`status-dot ${bot.connection.status === 'connected' ? 'good' : bot.connection.status === 'connecting' ? 'busy' : ''}`} />{configured(bot) ? labels[bot.connection.status] : '等待连接飞书'}</span></header>
    <div className="bot-tabs" role="tablist" aria-label="机器人设置" ref={tabsRef} onKeyDown={event => {
      if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
      event.preventDefault(); const index = sections.findIndex(item => item.id === section);
      const next = event.key === 'Home' ? 0 : event.key === 'End' ? sections.length - 1 : (index + (event.key === 'ArrowRight' ? 1 : -1) + sections.length) % sections.length;
      changeSection(sections[next].id); tabsRef.current?.querySelectorAll<HTMLButtonElement>('[role="tab"]')[next]?.focus();
    }}>{sections.map(item => <button key={item.id} type="button" role="tab" id={tabId(item.id)} aria-controls={panelId(item.id)} aria-selected={section === item.id} tabIndex={section === item.id ? 0 : -1} onClick={() => changeSection(item.id)}>{item.label}{item.id === 'access' && pending > 0 && <span className="count-badge">{pending}</span>}</button>)}</div>
    <div className="bot-panel-scroll">
      <DefaultNotificationBot state={state} bot={bot} configSave={configSave} startAccess={() => changeSection('access')} />
      <div className="bot-tab-panel" role="tabpanel" id={panelId('conversation')} aria-labelledby={tabId('conversation')} hidden={section !== 'conversation'}><ConversationSettings bot={bot} models={models} modelError={modelError} retryModels={retryModels} refresh={refresh} /></div>
      <div className="bot-tab-panel" role="tabpanel" id={panelId('access')} aria-labelledby={tabId('access')} hidden={section !== 'access'}><BotAccess state={state} bot={bot} busy={busy} perform={perform} onboarding={onboarding} /></div>
      <div className="bot-tab-panel" role="tabpanel" id={panelId('connection')} aria-labelledby={tabId('connection')} hidden={section !== 'connection'}><BotCredentials bot={bot} refresh={refresh} startAccess={startAccess} /><BotRemoval bot={bot} busy={busy} perform={perform} removed={removed} /></div>
    </div>
  </section>;
}

function ConversationSettings({ bot, models, modelError, retryModels, refresh }: { bot: BotProfile; models: Model[]; modelError: string; retryModels: () => Promise<void>; refresh: Refresh }) {
  const privateRole = useBotField(bot, 'privateRoleInstructions', bot.privateRoleInstructions || '', refresh);
  const groupRole = useBotField(bot, 'roleInstructions', bot.roleInstructions || '', refresh);
  const { model, effort } = useModelPreferences(bot, models, refresh);
  const context = useBotField(bot, 'includeGroupContext', bot.includeGroupContext !== false, refresh);
  const efforts = models.find(item => item.id === model.value)?.efforts || ['low', 'medium', 'high', 'xhigh'];
  return <div className="bot-conversation-settings">
    <div className="bot-role-grid">
      <BotField name="privateRoleInstructions" label="私聊角色说明" field={privateRole} hint="可选；留空使用普通 Codex"><textarea aria-label="私聊角色说明" rows={5} maxLength={12000} value={privateRole.value} placeholder="例如：协助我处理日常开发，先确认需求，再实施修改" onChange={event => privateRole.change(event.target.value)} onBlur={() => void privateRole.save()} /></BotField>
      <BotField name="roleInstructions" label="群聊角色说明" field={groupRole} hint="可选；只用于群聊中的角色分工"><textarea aria-label="群聊角色说明" rows={5} maxLength={12000} value={groupRole.value} placeholder="例如：负责开发实现，与产品和测试协作，说明变更和验证结果" onChange={event => groupRole.change(event.target.value)} onBlur={() => void groupRole.save()} /></BotField>
    </div>
    <div className="bot-model-grid">
      <BotField name="model" label="机器人模型" field={model}><Select aria-label="机器人模型" value={model.value} onChange={event => void model.save(event.target.value)}><option value="">沿用本机 Codex 配置</option>{model.value && !models.some(item => item.id === model.value) && <option value={model.value}>{model.value}</option>}{models.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}</Select></BotField>
      <BotField name="effort" label="机器人思考深度" field={effort}><Select aria-label="机器人思考深度" value={effort.value} onChange={event => void effort.save(event.target.value)}><option value="">沿用本机 Codex 配置</option>{effort.value && !efforts.includes(effort.value) && <option value={effort.value}>{effortName(effort.value)}</option>}{efforts.map(value => <option key={value} value={value}>{effortName(value)}</option>)}</Select></BotField>
    </div>
    {modelError && <p className="bot-model-error">模型列表暂不可用，仍可保留当前配置。<button className="text-button" onClick={() => void retryModels()}>重新加载</button></p>}
    <div className="bot-field bot-context-field" data-field="includeGroupContext"><div className="toggle-row group-context-preference"><span><strong>补充群聊背景</strong><small>{context.value ? '后续消息带入本群新增讨论，不清除已有历史。' : '仅处理 @我的消息，保留历史、引用和交接。'}</small></span><label className="toggle-control"><input type="checkbox" aria-label="补充群聊背景" checked={context.value} onChange={event => void context.save(event.target.checked)} /><span aria-hidden="true" className={`toggle ${context.value ? 'on' : ''}`} /></label></div><FieldStatus field={context} /></div>
    <div className="bot-save-note"><span><Check size={13} />离开输入框自动保存；每个设置独立保存</span><p>角色修改在新会话生效，可用 /new 新建。会话内单独指定的模型和思考深度优先。</p></div>
  </div>;
}

function BotCredentials({ bot, refresh, startAccess }: { bot: BotProfile; refresh: Refresh; startAccess: () => void }) {
  const name = useBotField(bot, 'name', bot.name, refresh);
  const [editing, setEditing] = useState(!configured(bot));
  const [appId, setAppId] = useState(bot.appId);
  const [secret, setSecret] = useState('');
  const [hint, setHint] = useState('');
  const [saving, setSaving] = useState(false);
  const [connectionSaving, setConnectionSaving] = useState(false);
  const [verified, setVerified] = useState<{ appId: string; hasSecret: boolean } | null>(null);
  const inFlight = useRef(false);
  const firstConnection = useRef(!configured(bot));
  const savedId = verified?.appId || bot.appId;
  const hasSecret = verified?.hasSecret || bot.hasSecret;
  const edited = appId.trim() !== savedId || Boolean(secret.trim()) || !hasSecret;
  const connected = bot.connection.status === 'connected' || bot.connection.status === 'connecting';
  useEffect(() => { if (!editing) setAppId(bot.appId); }, [bot.appId, editing]);
  useEffect(() => { if (verified && bot.appId === verified.appId && bot.hasSecret) setVerified(null); }, [bot.appId, bot.hasSecret, verified]);
  async function save(explicit = false) {
    if (inFlight.current || (!explicit && !edited)) return;
    const nextId = appId.trim(); const nextSecret = secret.trim();
    if (!explicit && (!nextId || (!nextSecret && (!hasSecret || nextId !== savedId)))) return;
    if (!/^cli_[a-zA-Z0-9]+$/.test(nextId)) { setHint('App ID 应为 cli_ 开头的字母和数字'); return; }
    if ((nextId !== savedId || !hasSecret) && !nextSecret) { setHint('请填写这个 App ID 对应的 App Secret'); return; }
    setHint(''); setSaving(true); inFlight.current = true;
    try {
      await request(`${botRoute(bot.id)}/credentials`, { appId: nextId, ...(nextSecret ? { appSecret: nextSecret } : {}) });
      setVerified({ appId: nextId, hasSecret: true }); setSecret(''); setEditing(false);
      await refresh().catch(() => {});
      if (firstConnection.current) { firstConnection.current = false; startAccess(); }
    } catch (caught) { setHint(errorMessage(caught)); }
    finally { inFlight.current = false; setSaving(false); }
  }
  async function connect() {
    if (connectionSaving) return;
    setConnectionSaving(true); setHint('');
    try { await request(`${botRoute(bot.id)}/connection`, { enabled: !connected }); await refresh().catch(() => {}); }
    catch (caught) { setHint(errorMessage(caught)); }
    finally { setConnectionSaving(false); }
  }
  const maskedId = savedId.length > 10 ? `${savedId.slice(0, 7)}••••${savedId.slice(-4)}` : `${savedId.slice(0, 4)}••••`;
  return <div className="bot-connection-settings">
    <section className="settings-section"><BotField name="name" label="机器人名称" field={name} hint="仅用于本机显示，不修改飞书应用名称"><input aria-label="机器人名称" maxLength={60} value={name.value} placeholder="例如：开发人员" onChange={event => name.change(event.target.value)} onBlur={() => void name.save()} /></BotField></section>
    <section className="settings-section"><div className="section-heading"><h3>应用凭据</h3>{!editing && <button className="text-button" onClick={() => { setAppId(savedId); setEditing(true); setHint(''); }}>修改凭据</button>}</div>
      {editing ? <>
        <div className="form-grid credential-fields" onBlur={event => { if (!event.currentTarget.contains(event.relatedTarget) && !(event.relatedTarget instanceof HTMLElement && event.relatedTarget.closest('[data-cancel-credentials]'))) void save(); }}><label className="field-label">App ID<input aria-label="App ID" disabled={saving} value={appId} placeholder="cli_…" autoComplete="off" spellCheck={false} onChange={event => { setAppId(event.target.value); setHint(''); }} /></label><label className="field-label">App Secret<input aria-label="App Secret" type="password" disabled={saving} value={secret} autoComplete="new-password" placeholder={hasSecret ? '留空保留现有密钥' : '填写应用密钥'} onChange={event => { setSecret(event.target.value); setHint(''); }} /></label></div>
        <p className="section-description">{saving ? '正在验证凭据并连接飞书…' : '两项填写完成后，离开凭据区域自动验证并连接。密钥仅保存在本机。'}</p>
        <div className="settings-action-row"><button className="secondary-button" disabled={saving || !appId.trim() || (!secret.trim() && !hasSecret)} onClick={() => void save(true)}>{saving ? <LoaderCircle size={14} className="spin" /> : <Wifi size={14} />}{saving ? '正在连接…' : '验证并连接'}</button>{hasSecret && <button className="text-button" data-cancel-credentials disabled={saving} onClick={() => { setEditing(false); setSecret(''); setAppId(savedId); setHint(''); }}>取消修改</button>}</div>
      </> : <div className="bot-credential-summary"><div><span>App ID</span><code>{maskedId}</code></div><div><span>App Secret</span><strong><ShieldCheck size={13} />已保存</strong></div></div>}
      <a className="settings-external-link" href="https://open.feishu.cn/app" target="_blank" rel="noopener noreferrer">飞书开发者后台<ExternalLink size={12} /></a>
      {hint && <div className="bot-connection-error" role="alert"><span>{hint}</span><button className="text-button" disabled={saving || connectionSaving} onClick={() => editing ? void save(true) : void connect()}>重试</button></div>}
    </section>
    {hasSecret && <section className="settings-section bot-connection-control"><div><h3>飞书连接</h3><p>{bot.connection.detail || (connected ? '机器人已启用，可在飞书中发消息。' : '连接后即可在飞书中使用这个机器人。')}</p></div><button className="secondary-button" disabled={saving || connectionSaving || (editing && edited)} onClick={() => void connect()}>{connectionSaving ? <LoaderCircle className="spin" size={14} /> : connected ? <Unplug size={14} /> : <Wifi size={14} />}{connected ? '断开连接' : '连接飞书'}</button></section>}
    {!hasSecret && <div className="bot-setup-note"><strong>先连接，再授权</strong><p>在飞书开发者后台创建应用并启用机器人，将 App ID 和 App Secret 填在这里。连接成功后，给机器人发一条消息，再到访问权限允许自己的账号。</p></div>}
  </div>;
}

function BotRemoval({ bot, busy, perform, removed }: { bot: BotProfile; busy: boolean; perform: Perform; removed: () => void }) {
  const [deleting, setDeleting] = useState(false);
  if (bot.id === 'default') return null;
  return <div className="bot-removal">{deleting ? <><p>移除后会断开这个机器人的飞书连接。Codex 会话历史会保留。</p><div className="row-buttons"><button className="danger-button" disabled={busy} onClick={() => void perform('remove-bot', async () => { await request(botRoute(bot.id), {}, 'DELETE'); removed(); }, '已移除机器人')}>确认移除</button><button className="text-button" disabled={busy} onClick={() => setDeleting(false)}>取消</button></div></> : <button className="text-button" disabled={busy} onClick={() => setDeleting(true)}><Trash2 size={13} />移除这个机器人</button>}</div>;
}

function IdentityDetails({ kind, id }: { kind: '账号' | '群聊'; id: string }) {
  return <details className="bot-identity-details"><summary>查看{kind} ID</summary><code>{id}</code></details>;
}

function BotAccess({ state, bot, busy, perform, onboarding }: { state: AppState; bot: BotProfile; busy: boolean; perform: Perform; onboarding: boolean }) {
  const [actor, setActor] = useState('');
  const [group, setGroup] = useState('');
  const pendingActors = state.pendingActors.filter(item => (item.botId || 'default') === bot.id);
  const pendingGroups = (state.pendingGroups || []).filter(item => item.botId === bot.id);
  const actorRequest = (actorId: string, allow: boolean) => request('/api/actors', { botId: bot.id, actorId, allow });
  const groupRequest = (chatId: string, allow: boolean) => request('/api/groups', { botId: bot.id, chatId, allow });
  const groupName = (chatId: string) => pendingGroups.find(item => item.chatId === chatId)?.title || state.conversations.find(item => (item.botId || 'default') === bot.id && (item.rawChatId || item.chatId) === chatId && item.chatTitle)?.chatTitle;
  return <div className="bot-access-settings">
    {(onboarding || !bot.allowedActors.length) && <div className="bot-onboarding"><strong>开始使用</strong><ol><li>在飞书中找到机器人，私聊发送一条消息。</li><li>在下方的待授权账号中，允许自己的账号。</li><li>需要群聊时，再把机器人加入群并 @它，授权群聊和发消息的账号。</li></ol><p>只使用私聊时，无需授权群聊；角色说明可随时补充。</p></div>}
    <section className="settings-section"><div className="section-heading"><h3>谁能使用</h3><ShieldCheck size={17} /></div><p className="section-description">只有已授权账号可以发起对话。账号授权仅对这个机器人生效。</p>
      {pendingActors.length > 0 && <h4 className="bot-request-heading">待授权账号 <span>{pendingActors.length}</span></h4>}
      {pendingActors.map(item => <div className="actor-row pending" key={item.actorId}><span className="actor-avatar"><ShieldCheck size={16} /></span><div><strong>待授权账号</strong><span className="bot-identity-hint">身份待确认 · {item.actorId.slice(-6)}</span><IdentityDetails kind="账号" id={item.actorId} /></div><button className="primary-button compact" disabled={busy} onClick={() => void perform('actor', () => actorRequest(item.actorId, true), '已允许这个账号')}>允许访问</button></div>)}
      {bot.allowedActors.map(actorId => <div className="actor-row" key={actorId}><span className="actor-avatar"><ShieldCheck size={16} /></span><div><strong>已授权账号</strong><span className="bot-identity-hint">账号 · {actorId.slice(-6)}</span><IdentityDetails kind="账号" id={actorId} /></div><button className="text-button" disabled={busy} onClick={() => void perform('actor', () => actorRequest(actorId, false), '已撤销账号授权')}>移除账号</button></div>)}
      {!bot.allowedActors.length && !pendingActors.length && <div className="small-empty">还没有账号请求。先在飞书中给机器人发一条消息。</div>}
      <details className="manual-authorize"><summary>手动添加账号</summary><div className="inline-form"><input aria-label="飞书账号 open_id" value={actor} placeholder="ou_ 开头的账号 ID" onChange={event => setActor(event.target.value)} /><button className="secondary-button" disabled={busy || !actor.trim()} onClick={() => void perform('actor', async () => { await actorRequest(actor.trim(), true); setActor(''); }, '已允许这个账号')}>添加账号</button></div></details>
    </section>
    <section className="settings-section bot-groups"><div className="section-heading"><h3>哪些群可用</h3><Users size={17} /></div><p className="section-description bot-access-rule">群聊和发消息的账号必须同时获得授权。允许群聊不会自动允许所有群成员；未 @机器人的消息不会触发回复。</p>
      {pendingGroups.length > 0 && <h4 className="bot-request-heading">待授权群聊 <span>{pendingGroups.length}</span></h4>}
      {pendingGroups.map(item => <div className="actor-row pending" key={item.chatId}><span className="actor-avatar"><Users size={16} /></span><div><strong>{groupName(item.chatId) || '待授权群聊'}</strong><IdentityDetails kind="群聊" id={item.chatId} /></div><button className="primary-button compact" disabled={busy} onClick={() => void perform('group', () => groupRequest(item.chatId, true), '已允许这个群聊；群成员仍需账号授权')}>允许群聊</button></div>)}
      {bot.allowedGroups.map(chatId => <div className="actor-row" key={chatId}><span className="actor-avatar"><Users size={16} /></span><div><strong>{groupName(chatId) || '已授权群聊'}</strong><IdentityDetails kind="群聊" id={chatId} /></div><button className="text-button" disabled={busy} onClick={() => void perform('group', () => groupRequest(chatId, false), '已撤销群聊授权')}>移除群聊</button></div>)}
      {!bot.allowedGroups.length && !pendingGroups.length && <p className="group-empty">还没有群聊请求。只使用私聊时无需配置。</p>}
      <details className="manual-authorize"><summary>手动添加群聊</summary><div className="inline-form"><input aria-label="飞书群聊 ID" value={group} placeholder="oc_ 开头的群聊 ID" onChange={event => setGroup(event.target.value)} /><button className="secondary-button" disabled={busy || !group.trim()} onClick={() => void perform('group', async () => { await groupRequest(group.trim(), true); setGroup(''); }, '已允许这个群聊')}>添加群聊</button></div></details>
    </section>
  </div>;
}

function AddBotDialog({ close, created, perform }: { close: () => void; created: (id: string) => void; perform: Perform }) {
  const [name, setName] = useState('');
  const [appId, setAppId] = useState('');
  const [secret, setSecret] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const nameInput = useRef<HTMLInputElement>(null);
  const dialog = useRef<HTMLDivElement>(null);
  const creating = useRef(false);
  useEffect(() => { nameInput.current?.focus(); }, []);
  async function create() {
    if (creating.current) return;
    if (!name.trim() || !/^cli_[a-zA-Z0-9]+$/.test(appId.trim()) || !secret.trim()) { setError('请填写名称、正确的 App ID 和 App Secret'); return; }
    creating.current = true; setSaving(true); setError('');
    try {
      let newId = '';
      await perform('add-bot', async () => {
        try {
          const result = await request<{ id?: string; bot?: { id: string } }>('/api/bots', { name: name.trim(), appId: appId.trim(), appSecret: secret.trim() });
          newId = result.bot?.id || result.id || '';
          if (!newId) throw new Error('未收到机器人编号，请刷新机器人列表后确认');
        } catch (caught) { setError(errorMessage(caught)); }
      });
      if (newId) created(newId);
    } finally { creating.current = false; setSaving(false); }
  }
  return <div className="overlay modal-overlay" onMouseDown={event => { if (event.target === event.currentTarget && !saving) close(); }}><div className="bot-dialog" role="dialog" aria-modal="true" aria-labelledby="add-bot-title" ref={dialog} onKeyDown={event => {
    if (event.key === 'Escape' && !saving) { event.stopPropagation(); close(); }
    if (event.key !== 'Tab') return;
    const items = [...(dialog.current?.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled), a[href]') || [])];
    const first = items[0]; const last = items.at(-1);
    if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
    else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
  }}><div className="drawer-title"><div><span className="eyebrow">FEISHU BOT</span><h2 id="add-bot-title">添加机器人</h2></div><button className="icon-button" aria-label="关闭添加机器人" disabled={saving} onClick={close}><X size={19} /></button></div><p className="section-description">每个机器人使用独立的飞书应用。连接成功后，给它发消息并授权自己的账号，即可开始使用。</p><form onSubmit={event => { event.preventDefault(); void create(); }}><div className="bot-dialog-fields"><label className="field-label">机器人名称<input ref={nameInput} aria-label="机器人名称" disabled={saving} value={name} maxLength={60} placeholder="例如：开发人员" onChange={event => setName(event.target.value)} /></label><div className="form-grid"><label className="field-label">App ID<input aria-label="App ID" disabled={saving} value={appId} autoComplete="off" spellCheck={false} placeholder="cli_…" onChange={event => setAppId(event.target.value)} /></label><label className="field-label">App Secret<input aria-label="App Secret" disabled={saving} type="password" value={secret} autoComplete="new-password" placeholder="填写应用密钥" onChange={event => setSecret(event.target.value)} /></label></div></div><a className="settings-external-link" href="https://open.feishu.cn/app" target="_blank" rel="noopener noreferrer">飞书开发者后台<ExternalLink size={12} /></a>{error && <p className="field-error" role="alert">{error}</p>}<div className="bot-dialog-footer"><span>{saving ? '正在验证应用凭据…' : '角色说明可稍后设置'}</span><button type="button" className="secondary-button" disabled={saving} onClick={close}>取消</button><button type="submit" className="primary-button" disabled={saving || !name.trim() || !appId.trim() || !secret.trim()}>{saving ? <LoaderCircle className="spin" size={14} /> : <Check size={14} />}{saving ? '正在连接…' : '验证并添加'}</button></div></form></div></div>;
}

function DefaultNotificationBot({ state, bot, configSave, startAccess }: { state: AppState; bot: BotProfile; configSave: ConfigAutosave; startAccess: () => void }) {
  const targets = (state.notificationTargets || []).filter(item => item.botId === bot.id);
  const hasDraft = configSave.draft.desktopNotificationTarget !== undefined;
  const target = hasDraft ? configSave.draft.desktopNotificationTarget : state.config.desktopNotificationTarget;
  const selectedTarget = target && targets.find(item => notificationTargetKey(item) === notificationTargetKey(target));
  const savedTarget = state.config.desktopNotificationTarget;
  const savedHere = savedTarget && targets.some(item => notificationTargetKey(item) === notificationTargetKey(savedTarget));
  const [choice, setChoice] = useState<string>();
  const chosen = choice ?? (selectedTarget ? notificationTargetKey(selectedTarget) : '');
  const candidate = targets.length === 1 ? targets[0] : targets.find(item => notificationTargetKey(item) === chosen);
  const unchanged = Boolean(candidate && selectedTarget && notificationTargetKey(candidate) === notificationTargetKey(selectedTarget));
  const saving = hasDraft && configSave.feedback.phase === 'saving';
  const failed = hasDraft && configSave.feedback.phase === 'error';
  const invalidHere = Boolean(target && target.botAppId === bot.appId && !selectedTarget);
  const isCurrent = Boolean(selectedTarget && !hasDraft);
  async function chooseDefault() {
    if (!candidate || saving) return;
    const { chatId, actorId, botAppId } = candidate;
    if (await configSave.save({ desktopNotificationTarget: { chatId, actorId, botAppId } })) setChoice(undefined);
  }
  return <section className={`bot-default-notification${isCurrent ? ' is-default' : ''}`} aria-label="默认通知机器人">
    <div className="bot-default-row"><div className="bot-default-copy"><strong>默认通知机器人</strong><p>已有会话绑定优先；未绑定的完成通知由默认机器人发送。</p></div>
      <div className="bot-default-actions">{isCurrent && unchanged ? <><span className="bot-default-current"><Check size={12} />已设为默认</span><button type="button" className="text-button" onClick={() => void configSave.save({ desktopNotificationTarget: null })}>取消默认</button></> : <button type="button" className="secondary-button" disabled={saving || !candidate} onClick={() => void chooseDefault()}>{saving ? '保存中…' : isCurrent ? '更新接收人' : '设为默认通知机器人'}</button>}
      </div>
    </div>
    {targets.length > 1 && <label className="bot-default-recipient"><span>通知接收人</span><Select aria-label="通知接收人" value={targets.some(item => notificationTargetKey(item) === chosen) ? chosen : ''} disabled={saving} onChange={event => setChoice(event.target.value)}><option value="">请选择一个私聊账号</option>{targets.map(item => <option key={notificationTargetKey(item)} value={notificationTargetKey(item)}>私聊账号 · {item.actorId.slice(-6)}</option>)}</Select></label>}
    {!targets.length && <p className="bot-default-hint">请先私聊这个机器人，再到访问权限允许该账号。<button type="button" className="text-button" onClick={startAccess}>去授权</button></p>}
    {invalidHere && <p className="bot-default-error">原接收位置已失效，请重新设置。<button type="button" className="text-button" onClick={() => void configSave.save({ desktopNotificationTarget: null })}>取消默认</button></p>}
    {hasDraft && (selectedTarget || savedHere || !target) && <p className={`bot-default-feedback ${failed ? 'error' : ''}`} role="status">{failed ? '默认通知设置尚未保存。' : '正在保存默认通知设置…'}{failed && <button type="button" className="text-button" onClick={() => void configSave.retry()}>重试</button>}</p>}
  </section>;
}
