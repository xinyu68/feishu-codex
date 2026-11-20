import path from 'node:path';

export const browserMcpName = 'feishu_browser';

export function playwrightMcpConfig({ root, nodePath, dataDir }) {
  for (const [name, value] of Object.entries({ root, nodePath, dataDir })) {
    if (!value || !path.isAbsolute(value)) throw new Error(`Playwright MCP requires an absolute ${name}.`);
  }
  return {
    command: nodePath,
    args: [path.join(root, 'scripts', 'playwright-mcp.mjs'), '--data-dir', dataDir],
    enabled: true,
    startup_timeout_sec: 30,
    tool_timeout_sec: 120,
  };
}

export function playwrightMcpOverrides(options) {
  return Object.entries(playwrightMcpConfig(options)).flatMap(([key, value]) =>
    ['-c', `mcp_servers.${browserMcpName}.${key}=${JSON.stringify(value)}`]);
}
