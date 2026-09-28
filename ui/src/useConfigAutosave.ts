import { useEffect, useRef, useState } from 'react';
import { ApiError, errorMessage, request } from './api';
import type { Config } from './types';

export type ConfigPatch = Partial<Pick<Config, 'appId' | 'defaultWorkspace' | 'model' | 'effort' | 'progress' | 'autoNotifyDesktop' | 'desktopNotificationMode' | 'desktopNotificationMinMinutes'> & { appSecret: string }>;
type Key = keyof ConfigPatch;
type Job = { patch: ConfigPatch; revision: number; route: string; method: string; resolve: (saved: boolean) => void };
type Feedback = { phase: 'idle' | 'saving' | 'saved' | 'error'; error?: string };

// Kept in App so saves and failed drafts survive navigation away from Settings.
// Patches are serialized: a slower response must never overwrite a newer choice.
export function useConfigAutosave(onSaved: (config: Config) => void) {
  const commit = useRef(onSaved);
  commit.current = onSaved;
  const queue = useRef<Job[]>([]);
  const running = useRef(false);
  const sequence = useRef(0);
  const revisions = useRef(new Map<Key, number>());
  const failed = useRef(new Map<Key, string>());
  const pendingDraft = useRef<ConfigPatch>({});
  const [draft, setDraft] = useState<ConfigPatch>({});
  const [feedback, setFeedback] = useState<Feedback>({ phase: 'idle' });

  useEffect(() => {
    if (feedback.phase !== 'saved') return;
    const timer = setTimeout(() => setFeedback({ phase: 'idle' }), 2500);
    return () => clearTimeout(timer);
  }, [feedback]);

  const failureMessage = () => failed.current.values().next().value as string | undefined;
  async function drain() {
    if (running.current) return;
    running.current = true;
    while (queue.current.length) {
      const job = queue.current.shift()!;
      const keys = Object.keys(job.patch) as Key[];
      let saved = false;
      try {
        const result = await request<{ config: Config }>(job.route, job.patch, job.method);
        commit.current(result.config);
        for (const key of keys) {
          if (revisions.current.get(key) !== job.revision) continue;
          delete pendingDraft.current[key];
          failed.current.delete(key);
        }
        saved = true;
      } catch (caught) {
        const message = caught instanceof ApiError && caught.status === 0
          ? '保存结果尚未确认，请检查本机连接后重试。'
          : `${job.route === '/api/credentials' ? '验证或连接失败' : '自动保存失败'}：${errorMessage(caught)}`;
        for (const key of keys) {
          if (revisions.current.get(key) === job.revision) failed.current.set(key, message);
        }
      }
      setDraft({ ...pendingDraft.current });
      job.resolve(saved);
    }
    running.current = false;
    const error = failureMessage();
    setFeedback(error ? { phase: 'error', error } : { phase: 'saved' });
  }

  function enqueue(patch: ConfigPatch, route: string, method: string): Promise<boolean> {
    const keys = Object.keys(patch) as Key[];
    if (!keys.length) return Promise.resolve(true);
    const revision = ++sequence.current;
    for (const key of keys) {
      revisions.current.set(key, revision);
      failed.current.delete(key);
    }
    pendingDraft.current = { ...pendingDraft.current, ...patch };
    setDraft({ ...pendingDraft.current });
    setFeedback({ phase: 'saving', error: failureMessage() });
    return new Promise(resolve => {
      queue.current.push({ patch, revision, route, method, resolve });
      void drain();
    });
  }

  const save = (patch: ConfigPatch) => enqueue(patch, '/api/config', 'PUT');
  const saveCredentials = (patch: Pick<ConfigPatch, 'appId' | 'appSecret'>) => enqueue(patch, '/api/credentials', 'POST');

  async function retry() {
    const keys = [...failed.current.keys()];
    const configKeys = keys.filter(key => key !== 'appId' && key !== 'appSecret');
    const credentialKeys = keys.filter(key => key === 'appId' || key === 'appSecret');
    const configPatch = Object.fromEntries(configKeys.map(key => [key, pendingDraft.current[key]])) as ConfigPatch;
    const credentialPatch = Object.fromEntries(credentialKeys.map(key => [key, pendingDraft.current[key]])) as Pick<ConfigPatch, 'appId' | 'appSecret'>;
    const configSaved = configKeys.length ? await save(configPatch) : true;
    const credentialsSaved = credentialKeys.length ? await saveCredentials(credentialPatch) : true;
    return configSaved && credentialsSaved;
  }

  return { draft, feedback, save, saveCredentials, retry };
}

export type ConfigAutosave = ReturnType<typeof useConfigAutosave>;
