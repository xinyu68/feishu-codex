export function loginStartupEnabled(settings) {
  return settings?.openAtLogin === true;
}

export function changeLoginStartup({ get, set, path, enabled }) {
  const options = { path, args: [] };
  const previous = loginStartupEnabled(get(options));
  if (previous === enabled) return false;
  set({ ...options, openAtLogin: enabled, enabled: true });
  if (loginStartupEnabled(get(options)) !== enabled) {
    set({ ...options, openAtLogin: previous, enabled: true });
    throw new Error('Windows 未确认开机自启设置，已恢复原状态。');
  }
  return true;
}
