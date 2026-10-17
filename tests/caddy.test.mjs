import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';

const source = readFileSync(new URL('../Caddyfile', import.meta.url), 'utf8');
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));

async function upstream(app) {
  const server = http.createServer((req, res) => {
    if (req.url.startsWith('/api/force-error')) { req.socket.destroy(); return; }
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ app, path: req.url, headers: req.headers }));
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return server;
}

async function edge() {
  const directory = mkdtempSync(path.join(tmpdir(), 'tm-caddy-'));
  const servers = [];
  let child, exited, logs = '';
  async function close() {
    if (child && child.exitCode === null && !child.signalCode) child.kill();
    if (exited) await exited;
    for (const server of servers) {
      server.closeAllConnections();
      await new Promise(resolve => server.close(resolve));
    }
    rmSync(directory, { recursive: true, force: true });
  }
  try {
    const backend = await upstream('backend'), frontend = await upstream('frontend');
    servers.push(backend, frontend);
    const reservation = http.createServer();
    reservation.listen(0, '127.0.0.1');
    await once(reservation, 'listening');
    const port = reservation.address().port;
    await new Promise(resolve => reservation.close(resolve));
    // Only this disposable fixture trusts 127.0.0.2; production keeps Cloudflare's ranges.
    const config = source.replace('{', '{\n\tadmin off\n\tpersist_config off')
      .replace(/trusted_proxies static[^\n]+/, 'trusted_proxies static 127.0.0.2/32')
      .replace('127.0.0.1:4321', `127.0.0.1:${backend.address().port}`)
      .replace('127.0.0.1:8080', `127.0.0.1:${frontend.address().port}`);
    const filename = path.join(directory, 'Caddyfile');
    writeFileSync(filename, config);
    child = spawn(process.env.CADDY_BIN || 'caddy', ['run', '--config', filename, '--adapter', 'caddyfile'], {
      env: { ...process.env, DOMAIN: `http://127.0.0.1:${port}`, ACME_EMAIL: 'ops@example.test' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let startError;
    child.on('error', error => { startError = error; });
    exited = new Promise(resolve => { child.once('exit', resolve); child.once('error', resolve); });
    for (const stream of [child.stdout, child.stderr]) stream.on('data', data => { logs = (logs + data.toString()).slice(-1024 * 1024); });
    function request(target, { peer = '127.0.0.1', headers = {} } = {}) {
      return new Promise((resolve, reject) => {
        const req = http.get({ hostname: '127.0.0.1', port, path: target, localAddress: peer, headers,
          signal: AbortSignal.timeout(2000) }, res => {
          let body = '';
          res.setEncoding('utf8');
          res.on('data', chunk => { body += chunk; });
          res.on('end', () => resolve({ status: res.statusCode, body }));
          res.on('error', reject);
        });
        req.on('error', reject);
      });
    }
    for (let attempt = 0; attempt < 80; attempt++) {
      assert.ifError(startError);
      assert.equal(child.exitCode, null, `Caddy exited during startup\n${logs}`);
      try { await request('/healthz'); return { request, close, logs: () => logs }; }
      catch { await pause(100); }
    }
    throw new Error(`Caddy did not start\n${logs}`);
  } catch (error) { await close(); throw error; }
}

test('Cloudflare trust replaces both backend IP headers and rejects direct spoofing', { timeout: 20_000 }, async () => {
  assert.ok(source.includes('client_ip_headers CF-Connecting-IP'));
  assert.ok(source.includes('173.245.48.0/20'));
  assert.ok(source.includes('2c0f:f248::/32'));
  assert.equal(source.includes('trusted_proxies static private_ranges'), false);
  const server = await edge();
  try {
    const forged = { 'CF-Connecting-IP': '203.0.113.23', 'X-Forwarded-For': '1.1.1.1', 'X-Real-IP': '1.1.1.1', 'X-Forwarded-Proto': 'https' };
    for (const [peer, target, headers, expected] of [
      ['127.0.0.2', '/api/probe', forged, '203.0.113.23'],
      ['127.0.0.2', '/index.html', { ...forged, 'CF-Connecting-IP': '2001:db8::23' }, '2001:db8::23'],
      ['127.0.0.1', '/api/probe', forged, '127.0.0.1'],
      ['127.0.0.1', '/index.html', forged, '127.0.0.1'],
      ['127.0.0.2', '/api/probe', {}, '127.0.0.2'],
      ['127.0.0.2', '/api/probe', { ...forged, 'CF-Connecting-IP': 'invalid' }, '127.0.0.2'],
    ]) {
      const response = await server.request(target, { peer, headers });
      assert.equal(response.status, 200, response.body);
      const actual = JSON.parse(response.body).headers;
      assert.equal(actual['x-forwarded-for'], expected);
      assert.equal(actual['x-real-ip'], expected);
      assert.equal(actual['x-forwarded-proto'], 'http');
      assert.equal(actual['cf-connecting-ip'], undefined);
    }
  } finally { await server.close(); }
});

test('same-origin API, WebSocket and upload paths reach backend without stripping prefixes', { timeout: 20_000 }, async () => {
  const server = await edge();
  try {
    for (const [app, targets] of [
      ['backend', ['/api', '/api/orders?x=1', '/ws', '/ws/chat?room=1', '/uploads/private.txt']],
      ['frontend', ['/', '/kirish.html', '/apiary', '/ws-other', '/uploads-old']],
    ]) for (const target of targets) {
      const response = await server.request(target);
      assert.equal(response.status, 200);
      assert.deepEqual({ ...JSON.parse(response.body), headers: undefined }, { app, path: target, headers: undefined });
    }
  } finally { await server.close(); }
});

test('Caddy access and upstream-error logs redact tokens and Referer', { timeout: 20_000 }, async () => {
  const server = await edge();
  try {
    const response = await server.request('/api/force-error?t=private-download-token&token=private-reset-token&keep=route', {
      headers: { Referer: 'https://example.test/private?t=private-referer-token' },
    });
    assert.equal(response.status, 502, response.body);
    for (let attempt = 0; attempt < 30; attempt++) {
      if (server.logs().includes('http.log.access.') && server.logs().includes('http.log.error.')) break;
      await pause(50);
    }
    const logs = server.logs();
    assert.ok(logs.includes('http.log.access.'), logs);
    assert.ok(logs.includes('http.log.error.'), logs);
    assert.ok(logs.includes('/api/force-error'), logs);
    assert.ok(logs.includes('keep=route'), logs);
    for (const secret of ['private-download-token', 'private-reset-token', 'private-referer-token']) assert.equal(logs.includes(secret), false, logs);
  } finally { await server.close(); }
});
