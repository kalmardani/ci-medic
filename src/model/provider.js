// The one place that knows about providers. Two dimensions are resolved here,
// the adapter (wire format) and the auth method. The rest of ci-medic sees only
// `complete({system, user})`.
import { createOpenAIAdapter } from './openai.js';
import { createAnthropicAdapter } from './anthropic.js';
import { createClaudeCliAdapter } from './claude-cli.js';
import { createCodexCliAdapter } from './codex-cli.js';
import { createFakeAdapter, loadFakeResponses } from './fake.js';
import { loadOAuthConfig, validateOAuthConfig } from '../auth/config.js';
import { createTokenCache } from '../auth/token-cache.js';
import { getAccessToken } from '../auth/oauth.js';

export const PROVIDERS = ['openai', 'anthropic', 'claude-cli', 'codex-cli', 'fake', 'none'];
export const AUTHS = ['api-key', 'oauth', 'subscription', 'none'];

const DEFAULT_AUTH = { openai: 'api-key', anthropic: 'api-key', 'claude-cli': 'subscription', 'codex-cli': 'subscription', fake: 'none', none: 'none' };

export class ConfigError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ConfigError';
  }
}

function int(value, fallback, name, min, max) {
  if (value === undefined || value === null || value === '') return fallback;
  const n = Number(value);
  if (!Number.isInteger(n) || n < min || n > max) throw new ConfigError(`${name} must be an integer between ${min} and ${max}`);
  return n;
}

export function isLoopbackUrl(u) {
  try {
    const h = new URL(u).hostname;
    return h === 'localhost' || h === '127.0.0.1' || h === '[::1]' || h === '::1';
  } catch {
    return false;
  }
}

/** Merge flags and env into one provider config. Throws ConfigError with a fix hint. */
export function resolveProviderConfig(flags = {}, env = process.env) {
  const provider = flags.provider ?? env.CI_MEDIC_PROVIDER;
  if (!provider) {
    throw new ConfigError(
      `no provider chosen. Pass --provider (${PROVIDERS.join(', ')}) or set CI_MEDIC_PROVIDER. Use "none" for the offline deterministic report`,
    );
  }
  if (!PROVIDERS.includes(provider)) throw new ConfigError(`unknown provider "${provider}", expected one of ${PROVIDERS.join(', ')}`);
  const auth = flags.auth ?? env.CI_MEDIC_AUTH ?? DEFAULT_AUTH[provider];
  if (!AUTHS.includes(auth)) throw new ConfigError(`unknown auth "${auth}", expected one of ${AUTHS.join(', ')}`);

  const http = provider === 'openai' || provider === 'anthropic';
  const cli = provider === 'claude-cli' || provider === 'codex-cli';
  if (http && auth === 'subscription') {
    throw new ConfigError('subscription access works only through the official CLIs. Use --provider claude-cli or --provider codex-cli');
  }
  if (http && auth === 'none') throw new ConfigError(`provider ${provider} needs --auth api-key or --auth oauth`);
  if (cli && auth !== 'subscription') throw new ConfigError(`provider ${provider} signs in through its own CLI, use --auth subscription`);
  if ((provider === 'fake' || provider === 'none') && auth !== 'none') throw new ConfigError(`provider ${provider} takes no auth`);

  const model = flags.model ?? env.CI_MEDIC_MODEL ?? null;
  if (http && !model) throw new ConfigError(`provider ${provider} needs a model id. Pass --model or set CI_MEDIC_MODEL`);

  const cfg = {
    provider,
    auth,
    model,
    maxTokens: int(flags.maxTokens ?? env.CI_MEDIC_MAX_TOKENS, 4096, 'max tokens', 256, 64_000),
    timeoutMs: int(env.CI_MEDIC_TIMEOUT_MS, cli ? 300_000 : 120_000, 'CI_MEDIC_TIMEOUT_MS', 1000, 3_600_000),
    baseUrl:
      provider === 'openai'
        ? env.CI_MEDIC_OPENAI_BASE_URL || 'https://api.openai.com/v1'
        : provider === 'anthropic'
          ? env.CI_MEDIC_ANTHROPIC_BASE_URL || 'https://api.anthropic.com'
          : null,
    apiKeyEnv: env.CI_MEDIC_API_KEY_ENV || (provider === 'openai' ? 'OPENAI_API_KEY' : provider === 'anthropic' ? 'ANTHROPIC_API_KEY' : null),
    oauthConfigFile: flags.oauthConfig ?? null,
  };
  if (cfg.baseUrl && !/^https:\/\//.test(cfg.baseUrl) && !isLoopbackUrl(cfg.baseUrl)) {
    throw new ConfigError('the provider base URL must use https unless it points at localhost');
  }
  return cfg;
}

/** Build the auth object for HTTP adapters. Never returns the key in a message. */
export function createAuth(cfg, { env = process.env, fetch, cache } = {}) {
  if (cfg.auth === 'api-key') {
    const key = env[cfg.apiKeyEnv];
    if (!key) {
      if (cfg.provider === 'openai' && isLoopbackUrl(cfg.baseUrl)) return { kind: 'api-key', canRefresh: false, bearer: async () => null };
      throw new ConfigError(`${cfg.apiKeyEnv} is not set`);
    }
    return { kind: 'api-key', canRefresh: false, bearer: async () => key };
  }
  if (cfg.auth === 'oauth') {
    const oc = loadOAuthConfig({ file: cfg.oauthConfigFile ?? undefined, env });
    const problems = validateOAuthConfig(oc);
    if (problems.length) throw new ConfigError(`OAuth config incomplete: ${problems.join('; ')}`);
    const store = cache ?? createTokenCache();
    return {
      kind: 'oauth',
      canRefresh: true,
      bearer: ({ forceRefresh = false } = {}) => getAccessToken(oc, store, { fetch, forceRefresh }),
    };
  }
  return { kind: 'none', canRefresh: false, bearer: async () => null };
}

/**
 * @returns {{name: string, model: string, complete: (req:{system:string, user:string}) => Promise<{text:string, model:string, usage:object, truncated:boolean}>} | null}
 */
export function createProvider(cfg, deps = {}) {
  const env = deps.env ?? process.env;
  switch (cfg.provider) {
    case 'none':
      return null;
    case 'fake': {
      if (deps.fakeAdapter) return deps.fakeAdapter;
      const file = env.CI_MEDIC_FAKE_RESPONSES;
      if (!file) throw new ConfigError('provider fake needs CI_MEDIC_FAKE_RESPONSES, a JSON array of scripted responses');
      return createFakeAdapter({ responses: loadFakeResponses(file) });
    }
    case 'openai':
      return createOpenAIAdapter({ ...cfg, auth: createAuth(cfg, deps), fetch: deps.fetch });
    case 'anthropic':
      return createAnthropicAdapter({ ...cfg, auth: createAuth(cfg, deps), fetch: deps.fetch });
    case 'claude-cli':
      return createClaudeCliAdapter({ model: cfg.model, timeoutMs: cfg.timeoutMs, runner: deps.runner, env });
    case 'codex-cli':
      return createCodexCliAdapter({ model: cfg.model, timeoutMs: cfg.timeoutMs, runner: deps.runner, env });
    default:
      throw new ConfigError(`unknown provider "${cfg.provider}"`);
  }
}
