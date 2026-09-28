import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../build/ui');
const contentTypes = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml' };
const server = http.createServer((request, response) => {
  const url = new URL(request.url, 'http://127.0.0.1:8795');
  if (url.pathname.startsWith('/api/')) { response.writeHead(503); response.end('Isolated UI fixture: no API or bot is available.'); return; }
  const file = path.resolve(root, url.pathname === '/' ? 'index.html' : `.${decodeURIComponent(url.pathname)}`);
  if (!file.startsWith(root + path.sep) || !fs.existsSync(file) || !fs.statSync(file).isFile()) { response.writeHead(404); response.end(); return; }
  response.setHeader('Content-Type', contentTypes[path.extname(file)] || 'application/octet-stream');
  response.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'self'; base-uri 'none'; form-action 'self'");
  response.end(fs.readFileSync(file));
});
server.listen(8795, '127.0.0.1', () => console.log('Isolated UI fixture: http://127.0.0.1:8795/?demo=1'));
for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => { server.close(); server.closeAllConnections(); });
