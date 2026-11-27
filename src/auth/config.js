// OAuth configuration from a small JSON file and env vars (env wins). The
// client secret is only ever read from an env var.
import fs from 'node:fs';
import path from 'node:path';
import { configDir } from './token-cache.js';

const GRANTS = ['client_credentials', 'pkce', 'device'];
const FILE_KEYS = ['token_url', 'auth_url', 'device_url', 'client_id', 'client_secret_env', 'scope', 'audience', 'grant'];

export function loadOAuthConfig({ file, env = process.env } = {}) {
  const candidate = file ?? env.CI_MEDIC_OAUTH_CONFIG ?? path.join(configDir(env), 'oauth.json');
  let data = {};
  let source = 'env';
  if (fs.existsSync(candidate)) {
    try {
      data = JSON.parse(fs.readFileSync(candidate, 'utf8'));
    } catch (err) {
      throw new Error(`cannot parse OAuth config ${candidate}: ${err.message}`);
    }
    if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error(`OAuth config ${candidate} must be a JSON object`);
    if ('client_secret' in data) throw new Error(`OAuth config ${candidate} contains client_secret. Put the secret in an env var and name it in client_secret_env`);
    for (const k of Object.keys(data)) if (!FILE_KEYS.includes(k)) throw new Error(`OAuth config ${candidate} has an unknown key "${k}"`);
    source = candidate;
  } else if (file) {
    throw new Error(`OAuth config file ${file} does not exist`);
  }
  const secretEnv = env.CI_MEDIC_OAUTH_CLIENT_SECRET_ENV ?? data.client_secret_env ?? 'CI_MEDIC_OAUTH_CLIENT_SECRET';
  const cfg = {
    tokenUrl: env.CI_MEDIC_OAUTH_TOKEN_URL ?? data.token_url ?? null,
    authUrl: env.CI_MEDIC_OAUTH_AUTH_URL ?? data.auth_url ?? null,
    deviceUrl: env.CI_MEDIC_OAUTH_DEVICE_URL ?? data.device_url ?? null,
    clientId: env.CI_MEDIC_OAUTH_CLIENT_ID ?? data.client_id ?? null,
    clientSecret: env[secretEnv] || null,
    scope: env.CI_MEDIC_OAUTH_SCOPE ?? data.scope ?? null,
    audience: env.CI_MEDIC_OAUTH_AUDIENCE ?? data.audience ?? null,
    grant: env.CI_MEDIC_OAUTH_GRANT ?? data.grant ?? null,
    source,
  };
  if (!cfg.grant) cfg.grant = cfg.deviceUrl ? 'device' : cfg.authUrl ? 'pkce' : 'client_credentials';
  return cfg;
}

export function validateOAuthConfig(cfg) {
  const problems = [];
  if (!GRANTS.includes(cfg.grant)) problems.push(`grant must be one of ${GRANTS.join(', ')}`);
  if (!cfg.tokenUrl) problems.push('token URL is missing (CI_MEDIC_OAUTH_TOKEN_URL or token_url)');
  if (!cfg.clientId) problems.push('client id is missing (CI_MEDIC_OAUTH_CLIENT_ID or client_id)');
  if (cfg.grant === 'pkce' && !cfg.authUrl) problems.push('authorization URL is missing (CI_MEDIC_OAUTH_AUTH_URL or auth_url)');
  if (cfg.grant === 'device' && !cfg.deviceUrl) problems.push('device URL is missing (CI_MEDIC_OAUTH_DEVICE_URL or device_url)');
  if (cfg.grant === 'client_credentials' && !cfg.clientSecret) problems.push('client secret env var is empty (CI_MEDIC_OAUTH_CLIENT_SECRET)');
  return problems;
}
