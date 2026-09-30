import net from 'node:net';
import { recordedProcessState } from './lifecycle.mjs';

export function orphanedRuntimeListener(snapshot, identity, port) {
  if (recordedProcessState(identity, snapshot.processes) !== 'dead') return false;
  const listeners = snapshot.connections.filter(item => item.state === 'Listen' && item.localPort === port);
  return listeners.length > 0 && listeners.every(item => item.pid === identity.pid && item.localAddress === '127.0.0.1');
}

export async function recoverRuntimeEndpoint({ snapshot, identity, url, probe, allocate = availableLoopbackPort, reservedPorts = [] }) {
  const current = new URL(url);
  if (!orphanedRuntimeListener(snapshot, identity, Number(current.port))) return null;
  // A responding server must never be replaced just because an inspection missed it.
  if ((await probe(url, { timeout: 1500 }).catch(() => ({ ready: false })))?.ready) return null;
  const port = await allocate();
  if (!Number.isInteger(port) || port < 1024 || port > 65535 || port === Number(current.port) || reservedPorts.includes(port)) throw new Error('无法分配可用的本机连接端口。');
  return `ws://127.0.0.1:${port}`;
}

function availableLoopbackPort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen({ host: '127.0.0.1', port: 0, exclusive: true }, () => {
      const port = server.address().port;
      server.close(error => error ? reject(error) : resolve(port));
    });
  });
}
