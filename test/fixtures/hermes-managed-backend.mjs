import http from 'node:http';
const server = http.createServer((req, res) => {
  if (req.url === '/api/status') {
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ version: 'test', hermes_home: process.env.HERMES_HOME }));
  } else {
    res.end(`<script>window.__HERMES_SESSION_TOKEN__=${JSON.stringify(process.env.HERMES_DASHBOARD_SESSION_TOKEN)};</script>`);
  }
});
if (!process.argv.includes('--never-ready')) server.listen(0, '127.0.0.1', () => {
  console.log(`HERMES_DASHBOARD_READY port=${server.address().port}`);
});
process.stdin.resume();
process.stdin.on('end', () => process.exit(0));
