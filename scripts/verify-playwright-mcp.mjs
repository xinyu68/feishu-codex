import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { playwrightMcpConfig } from '../desktop/playwright-mcp.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const textContent = result => (result.content || []).filter(item => item.type === 'text').map(item => item.text).join('\n');

export async function verifyBrowser({ call, tools, outputDir }) {
  await fs.mkdir(outputDir, { recursive: true });
  const server = http.createServer((request, response) => {
    response.setHeader('Content-Type', 'text/html; charset=utf-8');
    if (request.url === '/next') return response.end('<title>MCP next page</title><h1>Navigation verified</h1>');
    response.end(`<!doctype html><html lang="en"><title>Feishu browser verification</title>
      <h1>Local MCP verification</h1><label>Message <input aria-label="Message"></label>
      <button onclick="document.querySelector('output').textContent='Received: '+document.querySelector('input').value">Send test</button>
      <output></output><p><a href="/next">Next page</a></p></html>`);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const invoke = async (name, args = {}) => {
    const result = await call(name, args);
    assert.ok(!result.isError, `${name}: ${textContent(result)}`);
    return textContent(result);
  };
  const ref = (snapshot, pattern) => {
    const match = snapshot.match(pattern);
    assert.ok(match, `Missing element in snapshot: ${pattern}\n${snapshot}`);
    return match[1];
  };
  try {
    const names = tools.map(tool => tool.name).sort();
    for (const tool of ['browser_navigate', 'browser_snapshot', 'browser_click', 'browser_fill_form', 'browser_take_screenshot', 'browser_close']) assert.ok(names.includes(tool), `Missing tool: ${tool}`);
    await invoke('browser_navigate', { url: `http://127.0.0.1:${server.address().port}` });
    const snapshot = await invoke('browser_snapshot');
    assert.match(snapshot, /Local MCP verification/);
    await invoke('browser_fill_form', { fields: [{ name: 'Message', type: 'textbox', target: ref(snapshot, /textbox "Message" \[ref=([^\]]+)\]/), value: 'Shared and standalone MCP OK' }] });
    await invoke('browser_click', { element: 'Send test', target: ref(snapshot, /button "Send test" \[ref=([^\]]+)\]/) });
    const filled = await invoke('browser_snapshot');
    assert.match(filled, /Received: Shared and standalone MCP OK/);
    const screenshot = path.join(outputDir, 'browser.png');
    await invoke('browser_take_screenshot', { type: 'png', filename: screenshot, scale: 'css' });
    const png = await fs.readFile(screenshot);
    assert.equal(png.subarray(0, 8).toString('hex'), '89504e470d0a1a0a');
    assert.ok(png.length > 1000);
    await invoke('browser_click', { element: 'Next page', target: ref(filled, /link "Next page" \[ref=([^\]]+)\]/) });
    assert.match(await invoke('browser_snapshot'), /Navigation verified/);
    return { passed: true, checks: ['handshake', 'tools', 'navigate', 'snapshot', 'fill', 'click', 'screenshot', 'follow-link'], tools: names, screenshot, screenshotBytes: png.length };
  } finally {
    try { await invoke('browser_close'); } finally {
      await new Promise(resolve => { server.close(resolve); server.closeAllConnections(); });
    }
  }
}

export async function verifyStdio(outputDir = path.join(root, 'artifacts', 'playwright-mcp', 'stdio'), { productRoot = root, nodePath = process.execPath } = {}) {
  const [{ Client }, { StdioClientTransport }] = await Promise.all([
    import('@modelcontextprotocol/sdk/client/index.js'), import('@modelcontextprotocol/sdk/client/stdio.js'),
  ]);
  await fs.mkdir(outputDir, { recursive: true });
  const config = playwrightMcpConfig({ root: productRoot, nodePath, dataDir: outputDir });
  const env = Object.fromEntries(['PROGRAMFILES', 'PROGRAMFILES(X86)', 'LOCALAPPDATA', 'TEMP', 'TMP'].filter(key => process.env[key]).map(key => [key, process.env[key]]));
  const transport = new StdioClientTransport({ command: config.command, args: config.args, cwd: outputDir, env, stderr: 'pipe' });
  let stderr = '';
  transport.stderr.on('data', data => { stderr = (stderr + data).slice(-4000); });
  const client = new Client({ name: 'feishu-browser-verification', version: '1.0.0' });
  try {
    await client.connect(transport);
    const { tools } = await client.listTools();
    const result = await verifyBrowser({ tools, outputDir, call: (name, args) => client.callTool({ name, arguments: args }, undefined, { timeout: 60_000 }) });
    result.server = client.getServerVersion();
    await fs.writeFile(path.join(outputDir, 'report.json'), JSON.stringify(result, null, 2));
    return result;
  } catch (error) {
    throw new Error(`${error.message}${stderr ? `\nMCP stderr: ${stderr}` : ''}`, { cause: error });
  } finally {
    await client.close();
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const report = await verifyStdio();
  console.log(JSON.stringify(report, null, 2));
}
