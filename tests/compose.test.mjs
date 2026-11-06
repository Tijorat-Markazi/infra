import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { createBundle } from '../scripts/controller.mjs';
const env = { DOMAIN: 'example.test', DB_NAME: 'tijorat_markazi_db', DB_USER: 'tijorat_markazi_user', POSTGRES_PASSWORD: `test-$#'"\\`.repeat(4), ADMIN_PASSWORD: 'admin-test-password', RAIS_PASSWORD: 'rais-test-password' };
const image = app => `${app.toUpperCase()}_IMAGE=ghcr.io/tijorat-markazi/${app}:${app}-${'a'.repeat(40)}-r1-123-a1@sha256:${'b'.repeat(64)}\n`;
test('shared database is external; independent apps and unique frontend service never manage PostgreSQL', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'tm-compose-'));
  try {
    createBundle(dir, { mode: 'deploy', app: 'backend', shared: true, env });
    const model = app => {
      const args = ['compose', '-p', 'tijoratmarkazi', '--env-file', path.join(dir, 'runtime/compose.env'), '-f', path.join(dir, 'compose.yaml')];
      if (app) { writeFileSync(path.join(dir, 'apps', app, 'image.env'), image(app)); args.push('-f', path.join(dir, 'apps', app, 'compose.yaml'), '--env-file', path.join(dir, 'apps', app, 'image.env')); }
      const result = spawnSync('docker', [...args, 'config', '--format', 'json'], { encoding: 'utf8', timeout: 30_000 });
      assert.equal(result.status, 0, result.stderr);
      return JSON.parse(result.stdout);
    };
    const base = model();
    assert.deepEqual(base.services, {});
    assert.equal(base.volumes, undefined);
    const backend = model('backend');
    assert.equal(backend.networks.database.external, true);
    assert.equal(backend.networks.database.name, 'infrastructure_database');
    assert.equal(backend.services.postgres, undefined);
    assert.equal(backend.services.frontend, undefined);
    assert.equal(backend.services.backend.environment.POSTGRES_PASSWORD.replaceAll('$$', '$'), env.POSTGRES_PASSWORD);
    assert.equal(backend.services.backend.environment.DB_USER, env.DB_USER);
    assert.equal(backend.services.backend.environment.DATABASE_URL, undefined);
    assert.equal(backend.services.backend.depends_on, undefined);
    assert.equal(backend.services.backend.user, '10001:10001');
    assert.equal(backend.services.backend.read_only, true);
    assert.equal(backend.services.backend.ports[0].host_ip, '127.0.0.1');
    assert.deepEqual(Object.keys(backend.services.backend.networks).sort(), ['backendnet','database']);
    const frontend = model('frontend');
    const web = frontend.services['tijoratmarkazi-frontend'];
    assert.equal(frontend.networks.edge.external, true);
    assert.equal(frontend.networks.edge.name, 'agrozanjir_web');
    assert.equal(web.ports[0].host_ip, '127.0.0.1');
    assert.equal(String(web.ports[0].published), '8081');
    assert.equal(web.ports[0].target, 8080);
    assert.equal(frontend.services.backend, undefined);
    assert.deepEqual(Object.keys(web.networks).sort(), ['backendnet','edge']);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
