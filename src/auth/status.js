// `ci-medic auth status`. One line per connection type, never a secret: only
// whether a key is present, until when a token is valid, and whether the vendor
// CLIs report themselves as signed in.
import { loadOAuthConfig, validateOAuthConfig } from './config.js';
import { createTokenCache, cacheKey } from './token-cache.js';
import { claudeStatus, codexStatus } from './subscription.js';

export async function authStatus({ env = process.env, runner, oauthConfigFile, now = Date.now, cache } = {}) {
  const customEnv = env.CI_MEDIC_API_KEY_ENV || null;
  const apiKey = {
    openai: { env: 'OPENAI_API_KEY', present: Boolean(env.OPENAI_API_KEY) },
    anthropic: { env: 'ANTHROPIC_API_KEY', present: Boolean(env.ANTHROPIC_API_KEY) },
    custom: customEnv ? { env: customEnv, present: Boolean(env[customEnv]) } : null,
  };

  let oauth;
  try {
    const cfg = loadOAuthConfig({ file: oauthConfigFile, env });
    const problems = validateOAuthConfig(cfg);
    if (!cfg.tokenUrl && !cfg.clientId) oauth = { configured: false };
    else {
      const store = cache ?? createTokenCache();
      const entry = cfg.tokenUrl && cfg.clientId ? store.get(cacheKey(cfg)) : null;
      const t = now();
      oauth = {
        configured: problems.length === 0,
        problems,
        source: cfg.source,
        grant: cfg.grant,
        token: entry
          ? {
              valid: entry.expires_at === null || entry.expires_at > t,
              expiresAt: entry.expires_at ? new Date(entry.expires_at).toISOString() : null,
              refreshable: Boolean(entry.refresh_token),
            }
          : null,
        cacheFile: store.file,
        cacheMode: store.mode(),
      };
    }
  } catch (err) {
    oauth = { configured: false, problems: [err.message] };
  }

  const [claude, codex] = await Promise.all([claudeStatus({ runner, env }), codexStatus({ runner, env })]);
  return { apiKey, oauth, claude, codex, github: { env: 'GITHUB_TOKEN', present: Boolean(env.GITHUB_TOKEN) } };
}

const yesNo = (b) => (b ? 'set' : 'not set');

export function renderAuthStatus(s) {
  const out = [];
  out.push(`api-key       ${s.apiKey.openai.env} ${yesNo(s.apiKey.openai.present)}, ${s.apiKey.anthropic.env} ${yesNo(s.apiKey.anthropic.present)}`);
  if (s.apiKey.custom) out.push(`              ${s.apiKey.custom.env} ${yesNo(s.apiKey.custom.present)}`);
  const o = s.oauth;
  if (!o.configured && !o.grant) out.push(`oauth         not configured${o.problems?.length ? ` (${o.problems.join('; ')})` : ''}`);
  else {
    let tok = 'no token, run "ci-medic auth login"';
    if (o.token) {
      tok = o.token.valid ? `token valid${o.token.expiresAt ? ` until ${o.token.expiresAt}` : ''}` : `token expired at ${o.token.expiresAt}`;
      if (o.token.refreshable) tok += ', refreshable';
    }
    out.push(`oauth         grant ${o.grant}, ${o.configured ? tok : `incomplete (${o.problems.join('; ')})`}`);
    if (o.cacheMode) out.push(`              cache mode ${o.cacheMode}`);
  }
  const cli = (name, st, login) => {
    if (!st.installed) return `${name.padEnd(14)}not installed`;
    const state = st.signedIn === true ? `signed in${st.method ? ` (${st.method})` : ''}` : st.signedIn === false ? `not signed in, run "ci-medic auth login ${login}"` : 'sign in state unknown';
    return `${name.padEnd(14)}${st.version}, ${state}`;
  };
  out.push(cli('claude-cli', s.claude, 'claude'));
  out.push(cli('codex-cli', s.codex, 'chatgpt'));
  out.push(`github        GITHUB_TOKEN ${yesNo(s.github.present)}`);
  return `${out.join('\n')}\n`;
}
