import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { createBundle } from '../scripts/controller.mjs';
const env = { DOMAIN: 'example.test', ACME_EMAIL: 'ops@example.test', POSTGRES_PASSWORD: `test-$#'"\\`.repeat(4), ADMIN_PASSWORD: 'admin-test-password', RAIS_PASSWORD: 'rais-test-password' };
const image = app => `${app.toUpperCase()}_IMAGE=ghcr.io/tijorat-markazi/${app}:${app}-${'a'.repeat(40)}-r1-123-a1@sha256:${'b'.repeat(64)}\n`;
test('Postgres-only bootstrap and independent app models preserve raw secrets', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'tm-compose-'));
  try {
    createBundle(dir, { mode: 'bootstrap', shared: true, env });
    const model = app => {
      const args = ['compose', '-p', 'tijoratmarkazi', '-f', path.join(dir, 'compose.yaml')];
      if (app) { writeFileSync(path.join(dir, 'apps', app, 'image.env'), image(app)); args.push('-f', path.join(dir, 'apps', app, 'compose.yaml'), '--env-file', path.join(dir, 'apps', app, 'image.env')); }
      const result = spawnSync('docker', [...args, 'config', '--format', 'json'], { encoding: 'utf8', timeout: 30_000 });
      assert.equal(result.status, 0, result.stderr);
      return JSON.parse(result.stdout);
    };
    const base = model();
    assert.deepEqual(Object.keys(base.services), ['postgres']);
    assert.equal(base.services.postgres.volumes[0].target, '/var/lib/postgresql');
    assert.equal(base.services.postgres.ports, undefined);
    assert.equal(base.services.postgres.environment.POSTGRES_PASSWORD.replaceAll('$$', '$'), env.POSTGRES_PASSWORD);
    const backend = model('backend');
    assert.equal(backend.services.frontend, undefined);
    assert.equal(backend.services.backend.user, '10001:10001');
    assert.equal(backend.services.backend.read_only, true);
    assert.equal(backend.services.backend.ports[0].host_ip, '127.0.0.1');
    assert.equal(backend.services.backend.ports[0].target, 4321);
    const frontend = model('frontend');
    assert.equal(frontend.services.backend, undefined);
    assert.deepEqual(Object.keys(frontend.services.frontend.networks), ['frontendnet']);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
