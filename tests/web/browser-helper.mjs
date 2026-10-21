import { spawn } from 'node:child_process';
export const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
export async function waitFor(fn, label) {
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline) { const value = await fn(); if (value) return value; await delay(30); }
  throw new Error('Timed out: ' + label);
}
export async function startBrowser(profile) {
  const proc = spawn(process.env.CHROMIUM_BIN || 'chromium', ['--headless=new', '--no-sandbox', '--disable-dev-shm-usage',
    '--no-first-run', '--disable-background-networking', '--disable-component-update', '--disable-sync', '--disable-default-apps',
    '--remote-debugging-address=127.0.0.1', '--remote-debugging-port=0', '--user-data-dir=' + profile, 'about:blank'], { stdio: ['ignore', 'ignore', 'pipe'] });
  let stderr = ''; proc.stderr.on('data', b => stderr += b);
  const wsURL = await waitFor(() => stderr.match(/DevTools listening on (ws:\/\/[^\s]+)/)?.[1], 'Chromium startup').catch(error => { proc.kill(); throw error; });
  const socket = new WebSocket(wsURL); await new Promise((resolve, reject) => { socket.onopen = resolve; socket.onerror = reject; });
  let sequence = 0; const pending = new Map(), listeners = [];
  socket.onmessage = event => {
    const m = JSON.parse(event.data);
    if (m.id) { const item = pending.get(m.id); pending.delete(m.id); if (m.error) item.reject(new Error(JSON.stringify(m.error))); else item.resolve(m.result); }
    else listeners.forEach(listener => listener(m));
  };
  const send = (method, params = {}, sessionId) => new Promise((resolve, reject) => { const id = ++sequence; pending.set(id, { resolve, reject }); socket.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) })); });
  const { targetId } = await send('Target.createTarget', { url: 'about:blank' });
  const { sessionId } = await send('Target.attachToTarget', { targetId, flatten: true });
  await send('Page.enable', {}, sessionId); await send('Runtime.enable', {}, sessionId);
  const call = (method, params = {}) => send(method, params, sessionId);
  const evaluate = async expression => {
    const result = await call('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails)); return result.result.value;
  };
  return { call, evaluate, listeners, async stop() { try { await send('Browser.close'); } finally { socket.close(); if (proc.exitCode === null) proc.kill(); } } };
}
