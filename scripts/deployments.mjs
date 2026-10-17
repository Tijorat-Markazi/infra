// The app cleanup protocol consumes these records. Contents is not deployment state.
export class GitHub {
  constructor({ repo, token, fetchImpl = fetch }) { this.repo = repo; this.token = token; this.fetch = fetchImpl; this.deadline = Date.now() + 10 * 60_000; }
  async request(path, { method = 'GET', body } = {}) {
    if (!this.token) throw new Error('GITHUB_TOKEN is required');
    let response;
    for (let attempt = 0; attempt < 3; attempt++) {
      if (Date.now() >= this.deadline) throw new Error('Deployment API deadline exceeded');
      try {
        response = await this.fetch(`https://api.github.com/repos/${this.repo}${path}`, { method,
          headers: { Authorization: `Bearer ${this.token}`, Accept: 'application/vnd.github+json', 'Content-Type': 'application/json', 'X-GitHub-Api-Version': '2026-03-10' },
          body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(Math.min(30_000, this.deadline - Date.now())) });
      } catch (error) {
        if (method !== 'GET' || attempt === 2) throw new Error(`GitHub ${method} failed; mutation outcome may be unknown`);
        continue;
      }
      if (response.ok) return response.status === 204 ? null : response.json();
      if (method === 'GET' && response.status >= 500 && attempt < 2) continue;
      throw new Error(`GitHub ${method} ${path.split('?')[0]} returned ${response.status}`);
    }
  }
  async latestHealthy(app) {
    for (let page = 1; ; page++) {
      const records = await this.request(`/deployments?environment=prod&task=deploy-${app}&per_page=100&page=${page}`);
      for (const record of records) {
        const statuses = await this.request(`/deployments/${record.id}/statuses?per_page=1`);
        if (statuses[0]?.state === 'success' && record.payload?.app === app && record.payload?.image) return record.payload.image;
      }
      if (records.length < 100) return null;
    }
  }
  async start(app, release, configSha) {
    const previous = await this.latestHealthy(app);
    const record = await this.request('/deployments', { method: 'POST', body: { ref: configSha, task: `deploy-${app}`,
      environment: 'prod', production_environment: true, auto_merge: false, required_contexts: [],
      payload: { app, image: release.image, previous_image: previous, source_sha: release.sourceSha, config_sha: configSha } } });
    if (!record?.id) throw new Error('GitHub did not return a deployment ID');
    await this.status(record.id, 'in_progress');
    return record.id;
  }
  async status(id, state) {
    return this.request(`/deployments/${id}/statuses`, { method: 'POST', body: { state, auto_inactive: false,
      log_url: `https://github.com/${this.repo}/actions/runs/${process.env.GITHUB_RUN_ID || ''}`,
      description: state === 'success' ? 'Application readiness checks passed' : `Infra deployment ${state}` } });
  }
}
