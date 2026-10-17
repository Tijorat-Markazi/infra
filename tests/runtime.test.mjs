import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { renderRuntime, parseImage, verifyRelease } from '../scripts/runtime.mjs';
import { createBundle, remoteCommand, sshSettings, verifyConfigRevision } from '../scripts/controller.mjs';

export const fixture = { DOMAIN: 'example.test', ACME_EMAIL: 'ops@example.test',
  POSTGRES_PASSWORD: `password-$#'"\\`.repeat(3), ADMIN_PASSWORD: 'admin-test-only-123456', RAIS_PASSWORD: 'rais-test-only-123456' };
export const image = app => `ghcr.io/tijorat-markazi/${app}:${app}-${'a'.repeat(40)}-r2-123-a1@sha256:${'b'.repeat(64)}`;
const manifest = app => `${app.toUpperCase()}_IMAGE=${image(app)}\n`;

test('server access requires the exact validated infra revision', () => {
  const sha = 'c'.repeat(40);
  assert.doesNotThrow(() => verifyConfigRevision(sha, sha));
  for (const validated of [undefined, '', 'main', 'a'.repeat(40)]) {
    assert.throws(() => verifyConfigRevision(sha, validated), /did not pass validation/);
  }
});

test('raw runtime files preserve punctuation and percent-encode DB credentials', () => {
  const files = renderRuntime(fixture);
  assert.ok(files['postgres.env'].includes(`POSTGRES_PASSWORD=${fixture.POSTGRES_PASSWORD}\n`));
  const url = files['backend.env'].match(/^DATABASE_URL=(.+)$/m)[1];
  assert.equal(decodeURIComponent(new URL(url).password), fixture.POSTGRES_PASSWORD);
  assert.ok(files['backend.env'].includes('WEB_CONCURRENCY=1\n'));
  assert.ok(files['backend.env'].includes('NEWS_FETCH=off\n'));
  assert.ok(files['backend.env'].includes('APP_ORIGIN=https://example.test\n'));
});
test('runtime rejects missing/weak secrets, line injection and unsafe worker count', () => {
  for (const changes of [{ ADMIN_PASSWORD: '' }, { POSTGRES_PASSWORD: 'weak' }, { RAIS_PASSWORD: 'x\nBAD=yes' }, { DOMAIN: 'example.test;id' }, { WEB_CONCURRENCY: '2' }, { ANTHROPIC_API_KEY: 'test-key', ANTHROPIC_MODEL: '' }]) {
    assert.throws(() => renderRuntime({ ...fixture, ...changes }));
  }
});
test('release parser rejects mutable/cross-app/injected images and stale commits', () => {
  assert.equal(parseImage('backend', manifest('backend')).image, image('backend'));
  assert.equal(parseImage('backend', 'BACKEND_IMAGE=\n', { empty: true }), null);
  for (const text of ['BACKEND_IMAGE=latest\n', 'BACKEND_IMAGE=$(id)\n', manifest('frontend'), manifest('backend') + 'OTHER=x\n']) assert.throws(() => parseImage('backend', text));
  assert.throws(() => verifyRelease('backend', manifest('backend'), '', manifest('backend').replace('-r2-', '-r3-')), /superseded/);
  assert.throws(() => verifyRelease('backend', manifest('backend'), image('frontend'), manifest('backend')), /snapshot/);
});
test('normal bundle contains only targeted image; shared bundle contains no image pointers', () => {
  for (const shared of [false, true]) {
    const directory = mkdtempSync(path.join(tmpdir(), 'tm-bundle-'));
    try {
      createBundle(directory, { mode: shared ? 'bootstrap' : 'deploy', app: 'backend', shared, env: fixture });
      assert.equal(existsSync(path.join(directory, 'apps/backend/image.env')), !shared);
      assert.equal(existsSync(path.join(directory, 'apps/frontend/image.env')), false);
      assert.equal(existsSync(path.join(directory, 'runtime/backend.env')), shared);
      assert.equal(existsSync(path.join(directory, 'compose.yaml')), shared);
    } finally { rmSync(directory, { recursive: true, force: true }); }
  }
});
test('SSH pins host keys, brackets IPv6 SCP and rejects option/root injection', () => {
  const directory = mkdtempSync(path.join(tmpdir(), 'tm-ssh-'));
  const env = { VPS_HOST: '2001:db8::1', VPS_USERNAME: 'deploy', VPS_SSH_KEY: 'test\r\nkey', VPS_KNOWN_HOSTS: 'test-host' };
  try {
    const settings = sshSettings(env, directory);
    assert.equal(settings.destination, 'deploy@[2001:db8::1]');
    assert.ok(settings.ssh.includes('StrictHostKeyChecking=yes'));
    assert.equal(readFileSync(path.join(directory, 'ssh-key'), 'utf8'), 'test\nkey\n');
    assert.throws(() => sshSettings({ ...env, VPS_HOST: '-oProxyCommand=bad' }, directory));
    assert.throws(() => sshSettings({ ...env, VPS_USERNAME: 'root' }, directory));
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
test('remote operation bounds hangs and holds one lock over shared plus target deploy', () => {
  const command = remoteCommand({ mode: 'deploy', app: 'backend', shared: true, remote: '/tmp/tijoratmarkazi.ABC123', port: 22, actor: 'test-app[bot]' });
  for (const fragment of ['--password-stdin', 'unset registry_token', 'flock -w 60', 'TM_LOCK_HELD=1', '11m', 'apply-shared.sh', 'deploy.sh']) assert.ok(command.includes(fragment));
  assert.ok(command.indexOf('flock -w 60') < command.indexOf('apply-shared.sh'));
  assert.ok(command.includes('Server release changed while waiting for lock'));
  assert.ok(command.indexOf('Server release changed while waiting for lock') < command.indexOf('apply-shared.sh'));
  assert.throws(() => remoteCommand({ mode: 'deploy', app: 'backend', remote: '/tmp/a;id', port: 22, actor: 'test' }));
});
