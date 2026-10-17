import test from 'node:test';
import assert from 'node:assert/strict';
import { GitHub } from '../scripts/deployments.mjs';
const config = 'c'.repeat(40);
test('attempt is created before in_progress with exact task/payload and prior healthy image', async () => {
  const calls = [];
  const api = new GitHub({ repo: 'Tijorat-Markazi/infra', token: 'test', fetchImpl: async (url, options) => {
    const pathname = new URL(url).pathname;
    const body = options.body ? JSON.parse(options.body) : undefined;
    calls.push({ pathname, method: options.method, body });
    const data = options.method === 'POST' ? { id: 8 } : pathname.endsWith('/statuses') ? [{ state: 'success' }] : [{ id: 7, payload: { app: 'backend', image: 'healthy-image' } }];
    return new Response(JSON.stringify(data), { status: 200 });
  } });
  assert.equal(await api.start('backend', { image: 'candidate', sourceSha: 'a'.repeat(40) }, config), 8);
  const writes = calls.filter(call => call.method === 'POST');
  assert.deepEqual(writes[0].body.payload, { app: 'backend', image: 'candidate', previous_image: 'healthy-image', source_sha: 'a'.repeat(40), config_sha: config });
  assert.equal(writes[0].body.task, 'deploy-backend');
  assert.equal(writes[0].body.environment, 'prod');
  assert.equal(writes[0].body.auto_merge, false);
  assert.deepEqual(writes[0].body.required_contexts, []);
  assert.equal(writes[1].body.state, 'in_progress');
  assert.equal(writes[1].body.auto_inactive, false);
  await api.status(8, 'failure');
  assert.equal(calls.at(-1).body.state, 'failure');
});
test('unhealthy/latest attempts are not mistaken for healthy history', async () => {
  const api = new GitHub({ repo: 'Tijorat-Markazi/infra', token: 'test', fetchImpl: async url => {
    const path = new URL(url).pathname;
    const data = path.endsWith('/statuses') ? [{ state: path.includes('/9/') ? 'failure' : 'success' }] : [
      { id: 9, payload: { app: 'frontend', image: 'failed' } }, { id: 8, payload: { app: 'frontend', image: 'healthy' } }];
    return new Response(JSON.stringify(data));
  } });
  assert.equal(await api.latestHealthy('frontend'), 'healthy');
});
test('ambiguous deployment POST is never retried or converted to success', async () => {
  let calls = 0;
  const api = new GitHub({ repo: 'Tijorat-Markazi/infra', token: 'test', fetchImpl: async () => { calls++; throw new TypeError('lost response'); } });
  await assert.rejects(api.request('/deployments', { method: 'POST', body: {} }), /unknown/);
  assert.equal(calls, 1);
});
