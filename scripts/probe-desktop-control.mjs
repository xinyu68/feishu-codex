import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

// Read-only compatibility probe. Never launches the app, connects to a thread,
// edits the archive, or changes desktop/bridge settings.
const executable = process.argv[2];
if (!executable || !path.isAbsolute(executable) || path.basename(executable).toLowerCase() !== 'chatgpt.exe') {
  throw new Error('Usage: node scripts/probe-desktop-control.mjs <absolute installed ChatGPT.exe path>');
}
const appDirectory = path.dirname(executable);
const archive = path.join(appDirectory, 'resources', 'app.asar');
const fd = fs.openSync(archive, 'r');
const symbols = [
  'debug-run-app-action-request', 'debug-run-app-action-response',
  'threads.send_message', 'threads.read', 'sendMessageFromView',
  'turn/steer', 'turn/interrupt', 'requestSingleInstanceLock',
  'remote-debugging-port', 'user-data-dir', 'CODEX_APP_SERVER_WS_URL',
];
const matches = Object.fromEntries(symbols.map(symbol => [symbol, []]));
let javascriptFiles = 0;
let bytesRead = 0;
try {
  const prefix = Buffer.alloc(16);
  if (fs.readSync(fd, prefix, 0, prefix.length, 0) !== prefix.length) throw new Error('Incomplete ASAR header');
  const headerSize = prefix.readUInt32LE(12);
  const contentOffset = 8 + prefix.readUInt32LE(4);
  if (headerSize < 2 || headerSize > 32 * 1024 * 1024 || contentOffset < 16 + headerSize) {
    throw new Error('Unexpected ASAR header; nothing was modified');
  }
  const header = Buffer.alloc(headerSize);
  fs.readSync(fd, header, 0, headerSize, 16);
  const metadata = JSON.parse(header.toString('utf8'));
  function visit(directory, parent = '') {
    for (const [name, entry] of Object.entries(directory.files ?? {})) {
      const relative = parent ? `${parent}/${name}` : name;
      if (entry.files) { visit(entry, relative); continue; }
      if (!relative.endsWith('.js') || entry.unpacked || entry.link) continue;
      if (!relative.startsWith('.vite/build/') && !relative.startsWith('webview/')) continue;
      const offset = Number(entry.offset);
      if (!Number.isSafeInteger(offset) || !Number.isSafeInteger(entry.size) || entry.size < 0 || entry.size > 64 * 1024 * 1024) {
        throw new Error(`Unexpected archive entry: ${relative}`);
      }
      const buffer = Buffer.alloc(entry.size);
      if (fs.readSync(fd, buffer, 0, buffer.length, contentOffset + offset) !== buffer.length) {
        throw new Error(`Incomplete archive entry: ${relative}`);
      }
      const source = buffer.toString('utf8');
      javascriptFiles++;
      bytesRead += buffer.length;
      for (const symbol of symbols) if (source.includes(symbol)) matches[symbol].push(relative);
    }
  }
  visit(metadata);
} finally {
  fs.closeSync(fd);
}
const report = {
  checkedAt: new Date().toISOString(),
  executable,
  archive,
  archiveSha256: crypto.createHash('sha256').update(fs.readFileSync(archive)).digest('hex'),
  javascriptFiles,
  bytesRead,
  symbols: Object.fromEntries(Object.entries(matches).map(([symbol, files]) => [symbol, {
    fileCount: files.length, files: files.slice(0, 10), truncated: files.length > 10,
  }])),
  legacyAppControlRequestPresent: matches['debug-run-app-action-request'].length > 0,
  notes: [
    'Symbol presence does not prove an externally callable endpoint or runtime support.',
    'Missing legacy request means the audited GitHub app-control script cannot be assumed compatible.',
    'No desktop launch, restart, thread write, UI interaction, or configuration change was performed.',
  ],
};
console.log(JSON.stringify(report, null, 2));
