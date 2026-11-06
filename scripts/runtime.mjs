import { mkdirSync, writeFileSync, readFileSync } from 'node:fs';

export const OWNER = 'tijorat-markazi';
export const APPS = ['backend', 'frontend'];
export function scalar(name, value) {
  const text = String(value ?? '');
  if (/[\r\n\0]/.test(text)) throw new Error(`${name} must be a single-line value`);
  return text;
}
function required(env, key, minimum = 1) {
  const value = scalar(key, env[key]);
  if (value.length < minimum) throw new Error(`${key} requires at least ${minimum} characters`);
  return value;
}
function integer(env, key, fallback, min, max) {
  const value = scalar(key, env[key] || fallback);
  if (!/^\d+$/.test(value) || Number(value) < min || Number(value) > max) throw new Error(`Invalid ${key}`);
  return value;
}
export function envFile(values) {
  return Object.entries(values).map(([key, value]) => `${key}=${scalar(key, value)}\n`).join('');
}
export function renderRuntime(env) {
  const domain = required(env, 'DOMAIN');
  if (!/^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/.test(domain)) throw new Error('DOMAIN must be a lowercase hostname');
  const resource = (key, fallback) => {
    const value = scalar(key, env[key] || fallback);
    if (!/^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/.test(value)) throw new Error(`Invalid ${key}`);
    return value;
  };
  const infrastructure = {
    DOMAIN: domain,
    DB_NETWORK: resource('DB_NETWORK', 'infrastructure_database'),
    PROXY_NETWORK: resource('PROXY_NETWORK', 'agrozanjir_web'),
    DB_CONTAINER: resource('DB_CONTAINER', 'infrastructure-postgres-postgres-1'),
    EDGE_PROXY_CONTAINER: resource('EDGE_PROXY_CONTAINER', 'agrozanjir-caddy-1'),
  };
  const files = {
    'compose.env': envFile(infrastructure),
    'caddy.env': envFile({ DOMAIN: domain }),
    'edge-log-filter.caddy': readFileSync(new URL('../edge-log-filter.caddy', import.meta.url), 'utf8'),
    'edge-site.caddy': readFileSync(new URL('../Caddyfile', import.meta.url), 'utf8').replaceAll('{$DOMAIN}', domain),
  };
  const db = required(env, 'DB_NAME');
  const user = required(env, 'DB_USER');
  if (![db, user].every(value => /^[a-z_][a-z0-9_]{0,62}$/.test(value)) || user === 'postgres' || db === 'postgres') throw new Error('Use a dedicated application database and role');
  const host = resource('DB_HOST', 'postgres');
  const port = integer(env, 'DB_PORT', '5432', 1, 65535);
  const password = required(env, 'POSTGRES_PASSWORD', 24);
  if (String(env.WEB_CONCURRENCY || '1') !== '1') throw new Error('This backend requires WEB_CONCURRENCY=1');
  if (env.ANTHROPIC_API_KEY && !env.ANTHROPIC_MODEL) throw new Error('ANTHROPIC_MODEL is required when ANTHROPIC_API_KEY is configured');
  return {
    ...files,
    'backend.env': envFile({ NODE_ENV: 'production', PORT: '4321', APP_ORIGIN: `https://${domain}`,
      DB_HOST: host, DB_PORT: port, DB_NAME: db, DB_USER: user, POSTGRES_PASSWORD: password,
      ADMIN_PASSWORD: required(env, 'ADMIN_PASSWORD', 16), RAIS_PASSWORD: required(env, 'RAIS_PASSWORD', 16),
      WEB_CONCURRENCY: '1', STARTUP_TIMEOUT: integer(env, 'STARTUP_TIMEOUT', '120', 30, 300),
      DOC_TTL_DAYS: integer(env, 'DOC_TTL_DAYS', '14', 1, 365), NEWS_FETCH: 'off', TZ: 'Asia/Tashkent',
      ANTHROPIC_API_KEY: env.ANTHROPIC_API_KEY || '', ANTHROPIC_MODEL: env.ANTHROPIC_MODEL || '',
      TELEGRAM_BOT_TOKEN: env.TELEGRAM_BOT_TOKEN || '', RAIS_TG_CHAT: env.RAIS_TG_CHAT || '' }),
  };
}
export function writeRuntime(directory, env) {
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  for (const [name, content] of Object.entries(renderRuntime(env))) writeFileSync(`${directory}/${name}`, content, { mode: 0o600 });
}
export function parseImage(app, contents, { empty = false } = {}) {
  if (!APPS.includes(app)) throw new Error('Unknown application');
  const lines = contents.split(/\r?\n/).filter(line => line.trim() && !line.trimStart().startsWith('#'));
  const key = `${app.toUpperCase()}_IMAGE=`;
  if (lines.length !== 1 || !lines[0].startsWith(key)) throw new Error(`Invalid ${app} image.env`);
  const image = lines[0].slice(key.length);
  if (empty && !image) return null;
  const pattern = new RegExp(`^ghcr\\.io/${OWNER}/${app}:${app}-([a-f0-9]{40})-r[1-9][0-9]*-[1-9][0-9]*-a[1-9][0-9]*@sha256:[a-f0-9]{64}$`);
  const match = pattern.exec(image);
  if (!match) throw new Error(`${app} requires its canonical release tag and digest`);
  return { image, sourceSha: match[1] };
}
export function verifyRelease(app, contents, expected, latest) {
  const release = parseImage(app, contents);
  if (expected && release.image !== expected) throw new Error('Requested image differs from this workflow snapshot');
  if (parseImage(app, latest).image !== release.image) throw new Error('Release superseded on main; refusing stale deployment');
  return release;
}
