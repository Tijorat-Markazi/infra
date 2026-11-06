import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { renderRuntime } from '../scripts/runtime.mjs';
import { remoteCommand } from '../scripts/controller.mjs';
test('bootstrap only prepares project files and its own timer', () => {
  const source = readFileSync(new URL('../scripts/bootstrap.sh',import.meta.url),'utf8');
  for (const forbidden of [/apt-get/, /ufw /, /sysctl /, /usermod /, /groupadd /, /network create/, /compose .*up /, /reload.*caddy/, /apply-shared\.sh" "\$bundle"\s*$/m]) assert.doesNotMatch(source,forbidden);
  assert.match(source,/prepare-only/);
  assert.match(source,/preflight\.py/);
  assert.match(source,/tijoratmarkazi-backup\.timer/);
  assert.match(source,/systemctl enable tijoratmarkazi-backup\.timer/);
  assert.doesNotMatch(source,/systemctl (?:start|restart)|enable --now/);
  const command = remoteCommand({mode:'bootstrap',remote:'/tmp/tijoratmarkazi.ABC123',port:22,actor:'fixture'});
  assert.equal(command.includes('docker --config'),false);
  assert.equal(command.includes('Server release changed'),false);
});
test('bootstrap runtime prepares app credentials without PostgreSQL administrator initialization settings', () => {
  const files=renderRuntime({DOMAIN:'example.test',DB_NAME:'tijorat_markazi_db',DB_USER:'tijorat_markazi_user',POSTGRES_PASSWORD:'ci-only-database-passphrase-123',ADMIN_PASSWORD:'ci-only-admin-passphrase',RAIS_PASSWORD:'ci-only-rais-passphrase'});
  assert.ok(files['backend.env'].includes('DB_USER=tijorat_markazi_user'));
  assert.equal(files['postgres.env'],undefined);
  assert.match(files['compose.env'],/DB_NETWORK=infrastructure_database/);
  assert.match(files['edge-site.caddy'],/example\.test \{/);
  assert.match(files['edge-site.caddy'],/disable_tlsalpn_challenge/);
});
test('all deploy/bootstrap workflows gate on validation and forward prod database secrets/variables', () => {
  for (const filename of ['deploy-backend.yml','deploy-frontend.yml','server-bootstrap.yml']) {
    const source=readFileSync(new URL(`../.github/workflows/${filename}`,import.meta.url),'utf8');
    assert.match(source,/needs: validate/);
    for (const key of ['DB_HOST','DB_PORT','DB_NAME','DB_NETWORK','PROXY_NETWORK']) assert.ok(source.includes(key + ': ${{ vars.'));
    assert.ok(source.includes('DB_USER: ${{ secrets.DB_USER }}'));
    assert.ok(source.includes('POSTGRES_PASSWORD: ${{ secrets.POSTGRES_PASSWORD }}'));
    assert.equal(source.includes('vars.POSTGRES_USER'),false);
    assert.equal(source.includes('vars.POSTGRES_DB'),false);
  }
});
