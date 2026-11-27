// Generic OAuth 2.0 client, zero dependencies. Three grants: client
// credentials, authorization code with PKCE (S256) over a loopback redirect on
// 127.0.0.1, and the device authorization grant. Tokens never appear in error
// messages; errors carry the HTTP status and the OAuth `error` code only.
import http from 'node:http';
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { fetchWithRetry } from '../http.js';
import { cacheKey } from './token-cache.js';

export class OAuthError extends Error {
  constructor(message, code) {
    super(message);
    this.name = 'OAuthError';
    this.code = code ?? null;
  }
}

const b64url = (buf) => Buffer.from(buf).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

export function createPkce() {
  const verifier = b64url(randomBytes(32));
  const challenge = b64url(createHash('sha256').update(verifier).digest());
  return { verifier, challenge, method: 'S256' };
}

export function pkceChallenge(verifier) {
  return b64url(createHash('sha256').update(verifier).digest());
}

function sameString(a, b) {
  const x = Buffer.from(String(a));
  const y = Buffer.from(String(b));
  return x.length === y.length && timingSafeEqual(x, y);
}

/** Validate a token endpoint response and turn it into a cache entry. */
export function parseTokenResponse(body, now = Date.now()) {
  if (!body || typeof body !== 'object') throw new OAuthError('token endpoint returned no JSON object');
  if (typeof body.access_token !== 'string' || body.access_token.length === 0) {
    throw new OAuthError('token endpoint response has no access_token');
  }
  const expiresIn = Number(body.expires_in);
  return {
    access_token: body.access_token,
    token_type: typeof body.token_type === 'string' ? body.token_type : 'Bearer',
    refresh_token: typeof body.refresh_token === 'string' ? body.refresh_token : null,
    scope: typeof body.scope === 'string' ? body.scope : null,
    expires_at: Number.isFinite(expiresIn) && expiresIn > 0 ? now + expiresIn * 1000 : null,
    obtained_at: now,
  };
}

async function postForm(url, params, opts) {
  const res = await fetchWithRetry(
    url,
    {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json', 'user-agent': 'ci-medic' },
      body: new URLSearchParams(Object.entries(params).filter(([, v]) => v !== undefined && v !== null && v !== '')).toString(),
    },
    { fetch: opts.fetch, timeoutMs: opts.timeoutMs ?? 30_000, retries: opts.retries ?? 2, sleep: opts.sleep },
  );
  let body = null;
  try {
    body = await res.json();
  } catch {}
  return { status: res.status, ok: res.ok, body };
}

function endpointError(what, r) {
  const code = r.body && typeof r.body.error === 'string' ? r.body.error.slice(0, 60) : null;
  return new OAuthError(`${what} failed with HTTP ${r.status}${code ? ` (${code})` : ''}`, code);
}

function checkUrl(u, name) {
  let parsed;
  try {
    parsed = new URL(u);
  } catch {
    throw new OAuthError(`${name} is not a valid URL`);
  }
  const loopback = parsed.hostname === '127.0.0.1' || parsed.hostname === 'localhost' || parsed.hostname === '[::1]';
  if (parsed.protocol !== 'https:' && !(parsed.protocol === 'http:' && loopback)) {
    throw new OAuthError(`${name} must use https`);
  }
  return parsed;
}

export async function clientCredentials(cfg, opts = {}) {
  checkUrl(cfg.tokenUrl, 'token URL');
  const r = await postForm(
    cfg.tokenUrl,
    { grant_type: 'client_credentials', client_id: cfg.clientId, client_secret: cfg.clientSecret, scope: cfg.scope, audience: cfg.audience },
    opts,
  );
  if (!r.ok) throw endpointError('client credentials grant', r);
  return parseTokenResponse(r.body, (opts.now ?? Date.now)());
}

export async function refresh(cfg, refreshToken, opts = {}) {
  checkUrl(cfg.tokenUrl, 'token URL');
  const r = await postForm(
    cfg.tokenUrl,
    { grant_type: 'refresh_token', refresh_token: refreshToken, client_id: cfg.clientId, client_secret: cfg.clientSecret, scope: cfg.scope },
    opts,
  );
  if (!r.ok) throw endpointError('token refresh', r);
  const entry = parseTokenResponse(r.body, (opts.now ?? Date.now)());
  if (!entry.refresh_token) entry.refresh_token = refreshToken;
  return entry;
}

/**
 * Authorization code grant with PKCE. Listens on 127.0.0.1 with a random port,
 * accepts one callback, checks `state`, then exchanges the code.
 * @param {object} cfg
 * @param {{openBrowser?: (url:string)=>Promise<void>, print?: (s:string)=>void, timeoutMs?: number, fetch?: typeof fetch, now?: ()=>number, onListening?: (info:{authUrl:string, redirectUri:string, state:string})=>void}} opts
 */
export async function authorizeWithPkce(cfg, opts = {}) {
  checkUrl(cfg.authUrl, 'authorization URL');
  checkUrl(cfg.tokenUrl, 'token URL');
  const pkce = createPkce();
  const state = b64url(randomBytes(16));
  const timeoutMs = opts.timeoutMs ?? 300_000;
  const print = opts.print ?? ((s) => process.stderr.write(`${s}\n`));

  const { code, redirectUri } = await new Promise((resolve, reject) => {
    let settled = false;
    const server = http.createServer((req, res) => {
      const url = new URL(req.url ?? '/', 'http://127.0.0.1');
      if (url.pathname !== '/callback') {
        res.writeHead(404, { 'content-type': 'text/plain' }).end('not found');
        return;
      }
      const finish = (status, text, err, value) => {
        res.writeHead(status, { 'content-type': 'text/plain; charset=utf-8', connection: 'close' }).end(text);
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        server.close();
        if (err) reject(err);
        else resolve(value);
      };
      const gotState = url.searchParams.get('state') ?? '';
      if (!sameString(gotState, state)) {
        finish(400, 'State mismatch. Sign in was aborted.', new OAuthError('state mismatch on the redirect, sign in aborted', 'state_mismatch'));
        return;
      }
      const error = url.searchParams.get('error');
      if (error) {
        finish(400, 'Sign in was not completed.', new OAuthError(`authorization server returned ${error.slice(0, 60)}`, error.slice(0, 60)));
        return;
      }
      const c = url.searchParams.get('code');
      if (!c) {
        finish(400, 'No code in the redirect.', new OAuthError('redirect carried no code', 'no_code'));
        return;
      }
      finish(200, 'Signed in. You can close this window and return to the terminal.', null, { code: c, redirectUri: server.redirectUri });
    });
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      server.close();
      reject(new OAuthError('timed out waiting for the browser sign in', 'timeout'));
    }, timeoutMs);
    server.on('error', (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(err);
    });
    server.listen(0, '127.0.0.1', async () => {
      const { port } = server.address();
      server.redirectUri = `http://127.0.0.1:${port}/callback`;
      const auth = new URL(cfg.authUrl);
      auth.searchParams.set('response_type', 'code');
      auth.searchParams.set('client_id', cfg.clientId);
      auth.searchParams.set('redirect_uri', server.redirectUri);
      if (cfg.scope) auth.searchParams.set('scope', cfg.scope);
      if (cfg.audience) auth.searchParams.set('audience', cfg.audience);
      auth.searchParams.set('state', state);
      auth.searchParams.set('code_challenge', pkce.challenge);
      auth.searchParams.set('code_challenge_method', 'S256');
      const authUrl = auth.toString();
      opts.onListening?.({ authUrl, redirectUri: server.redirectUri, state });
      print(`Open this URL in a browser to sign in:\n${authUrl}`);
      if (opts.openBrowser) await opts.openBrowser(authUrl).catch(() => {});
    });
  });

  const r = await postForm(
    cfg.tokenUrl,
    {
      grant_type: 'authorization_code',
      code,
      redirect_uri: redirectUri,
      client_id: cfg.clientId,
      client_secret: cfg.clientSecret,
      code_verifier: pkce.verifier,
    },
    opts,
  );
  if (!r.ok) throw endpointError('authorization code exchange', r);
  return parseTokenResponse(r.body, (opts.now ?? Date.now)());
}

/**
 * Device authorization grant (RFC 8628). Prints the code and URL, then polls
 * at the server interval, slowing down by 5 s on `slow_down`.
 */
export async function deviceAuthorization(cfg, opts = {}) {
  checkUrl(cfg.deviceUrl, 'device authorization URL');
  checkUrl(cfg.tokenUrl, 'token URL');
  const print = opts.print ?? ((s) => process.stderr.write(`${s}\n`));
  const sleep = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  const now = opts.now ?? Date.now;
  const start = await postForm(cfg.deviceUrl, { client_id: cfg.clientId, scope: cfg.scope, audience: cfg.audience }, opts);
  if (!start.ok) throw endpointError('device authorization request', start);
  const d = start.body ?? {};
  if (typeof d.device_code !== 'string' || typeof d.user_code !== 'string' || typeof (d.verification_uri ?? d.verification_url) !== 'string') {
    throw new OAuthError('device authorization response is missing device_code, user_code or verification_uri');
  }
  const verification = d.verification_uri ?? d.verification_url;
  print(`To sign in, open ${verification} and enter the code ${d.user_code}`);
  if (typeof d.verification_uri_complete === 'string') print(`Or open ${d.verification_uri_complete}`);
  let interval = Math.max(1, Number(d.interval) || 5) * 1000;
  const deadline = now() + Math.max(30, Number(d.expires_in) || 600) * 1000;
  const polls = { count: 0, slowDowns: 0 };

  for (;;) {
    if (now() >= deadline) throw new OAuthError('the device code expired before sign in finished', 'expired_token');
    await sleep(interval);
    polls.count++;
    const r = await postForm(
      cfg.tokenUrl,
      { grant_type: 'urn:ietf:params:oauth:grant-type:device_code', device_code: d.device_code, client_id: cfg.clientId, client_secret: cfg.clientSecret },
      opts,
    );
    if (r.ok) {
      const entry = parseTokenResponse(r.body, now());
      return Object.defineProperty(entry, 'polls', { value: { ...polls, finalIntervalMs: interval }, enumerable: false });
    }
    const code = r.body?.error;
    if (code === 'authorization_pending') continue;
    if (code === 'slow_down') {
      interval += 5000;
      polls.slowDowns++;
      continue;
    }
    throw endpointError('device token polling', r);
  }
}

/**
 * Return a valid access token, refreshing before expiry. Client credentials
 * fetch a new token silently; the interactive grants need `auth login`.
 */
export async function getAccessToken(cfg, cache, opts = {}) {
  const now = (opts.now ?? Date.now)();
  const key = cacheKey(cfg);
  const entry = cache.get(key);
  const skew = 60_000;
  if (entry && !opts.forceRefresh && (entry.expires_at === null || entry.expires_at - skew > now)) return entry.access_token;
  if (entry?.refresh_token) {
    try {
      const next = await refresh(cfg, entry.refresh_token, opts);
      cache.set(key, next);
      return next.access_token;
    } catch (err) {
      if (cfg.grant !== 'client_credentials') throw new OAuthError(`${err.message}. Run "ci-medic auth login" again`, err.code);
    }
  }
  if (cfg.grant === 'client_credentials') {
    const next = await clientCredentials(cfg, opts);
    cache.set(key, next);
    return next.access_token;
  }
  throw new OAuthError(entry ? 'the OAuth token expired. Run "ci-medic auth login"' : 'no OAuth token yet. Run "ci-medic auth login"', 'login_required');
}

/** Interactive or silent login for the configured grant, result stored in the cache. */
export async function login(cfg, cache, opts = {}) {
  let entry;
  if (cfg.grant === 'client_credentials') entry = await clientCredentials(cfg, opts);
  else if (cfg.grant === 'pkce') entry = await authorizeWithPkce(cfg, opts);
  else if (cfg.grant === 'device') entry = await deviceAuthorization(cfg, opts);
  else throw new OAuthError(`unknown grant "${cfg.grant}"`);
  cache.set(cacheKey(cfg), entry);
  return entry;
}
