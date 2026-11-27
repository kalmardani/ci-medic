// OAuth client against a fake token server started inside the test. No network.
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import {
  createPkce,
  pkceChallenge,
  authorizeWithPkce,
  deviceAuthorization,
  clientCredentials,
  getAccessToken,
  parseTokenResponse,
  OAuthError,
} from '../src/auth/oauth.js';
import { createTokenCache, cacheKey, configDir } from '../src/auth/token-cache.js';
import { loadOAuthConfig, validateOAuthConfig } from '../src/auth/config.js';
import { tmpDir } from './_helpers.js';

function b64url(buf) {
  return Buffer.from(buf).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

async function fakeServer() {
  const state = { requests: [], pending: { challenge: null, code: null }, deviceScript: [], refreshCount: 0 };
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    let body = '';
    for await (const c of req) body += c;
    const form = Object.fromEntries(new URLSearchParams(body));
    state.requests.push({ path: url.pathname, form });
    const json = (status, obj) => res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(obj));
    if (url.pathname === '/authorize') {
      state.pending = { challenge: url.searchParams.get('code_challenge'), method: url.searchParams.get('code_challenge_method'), code: 'code-123' };
      const back = new URL(url.searchParams.get('redirect_uri'));
      back.searchParams.set('code', 'code-123');
      back.searchParams.set('state', url.searchParams.get('state'));
      res.writeHead(302, { location: back.toString() }).end();
      return;
    }
    if (url.pathname === '/device') return json(200, { device_code: 'dev-1', user_code: 'ABCD-EFGH', verification_uri: 'https://example.test/activate', interval: 2, expires_in: 600 });
    if (url.pathname !== '/token') return json(404, {});
    switch (form.grant_type) {
      case 'client_credentials':
        if (form.client_id !== 'cid' || form.client_secret !== 's3cret') return json(401, { error: 'invalid_client' });
        return json(200, { access_token: 'cc-token', token_type: 'Bearer', expires_in: 3600, scope: form.scope });
      case 'authorization_code': {
        const expected = b64url(createHash('sha256').update(form.code_verifier ?? '').digest());
        if (form.code !== state.pending.code || expected !== state.pending.challenge) return json(400, { error: 'invalid_grant' });
        return json(200, { access_token: 'ac-token', refresh_token: 'rt-1', expires_in: 120 });
      }
      case 'refresh_token':
        state.refreshCount++;
        if (form.refresh_token !== 'rt-1') return json(400, { error: 'invalid_grant' });
        return json(200, { access_token: `refreshed-${state.refreshCount}`, expires_in: 3600 });
      case 'urn:ietf:params:oauth:grant-type:device_code': {
        const next = state.deviceScript.shift() ?? 'ok';
        if (next === 'ok') return json(200, { access_token: 'device-token', refresh_token: 'rt-1', expires_in: 3600 });
        return json(400, { error: next });
      }
      default:
        return json(400, { error: 'unsupported_grant_type' });
    }
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  return { server, base, state, close: () => new Promise((r) => server.close(r)) };
}

test('PKCE verifier and S256 challenge follow RFC 7636', () => {
  const p = createPkce();
  assert.match(p.verifier, /^[A-Za-z0-9_-]{43}$/);
  assert.equal(p.challenge, b64url(createHash('sha256').update(p.verifier).digest()));
  assert.equal(p.method, 'S256');
  // RFC 7636 appendix B test vector.
  assert.equal(pkceChallenge('dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk'), 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM');
  assert.notEqual(createPkce().verifier, p.verifier);
});

test('authorization code with PKCE over a loopback redirect, state checked', async () => {
  const s = await fakeServer();
  try {
    const cfg = { authUrl: `${s.base}/authorize`, tokenUrl: `${s.base}/token`, clientId: 'cid', scope: 'read', grant: 'pkce' };
    let seen;
    const entry = await authorizeWithPkce(cfg, {
      print: () => {},
      onListening: (info) => (seen = info),
      openBrowser: async (url) => {
        await fetch(url); // follows the 302 to the loopback callback, like a browser
      },
    });
    assert.equal(entry.access_token, 'ac-token');
    assert.equal(entry.refresh_token, 'rt-1');
    assert.match(seen.redirectUri, /^http:\/\/127\.0\.0\.1:\d+\/callback$/);
    assert.equal(s.state.pending.method, 'S256');
    const tokenReq = s.state.requests.find((r) => r.form.grant_type === 'authorization_code');
    assert.equal(tokenReq.form.redirect_uri, seen.redirectUri);
    assert.ok(tokenReq.form.code_verifier.length >= 43);
  } finally {
    await s.close();
  }
});

test('a redirect with the wrong state aborts the sign in', async () => {
  const s = await fakeServer();
  try {
    const cfg = { authUrl: `${s.base}/authorize`, tokenUrl: `${s.base}/token`, clientId: 'cid', grant: 'pkce' };
    await assert.rejects(
      authorizeWithPkce(cfg, {
        print: () => {},
        onListening: async ({ redirectUri }) => {
          await fetch(`${redirectUri}?code=stolen&state=forged`).catch(() => {});
        },
      }),
      (err) => err instanceof OAuthError && err.code === 'state_mismatch',
    );
    assert.ok(!s.state.requests.some((r) => r.form.grant_type === 'authorization_code'), 'no code exchange happened');
  } finally {
    await s.close();
  }
});

test('the loopback flow times out when nobody signs in', async () => {
  const s = await fakeServer();
  try {
    const cfg = { authUrl: `${s.base}/authorize`, tokenUrl: `${s.base}/token`, clientId: 'cid', grant: 'pkce' };
    await assert.rejects(authorizeWithPkce(cfg, { print: () => {}, timeoutMs: 200 }), (err) => err.code === 'timeout');
  } finally {
    await s.close();
  }
});

test('device grant polls with authorization_pending and slows down on slow_down', async () => {
  const s = await fakeServer();
  try {
    s.state.deviceScript = ['authorization_pending', 'slow_down', 'authorization_pending', 'ok'];
    const waits = [];
    let clock = 1_000_000;
    const printed = [];
    const entry = await deviceAuthorization(
      { deviceUrl: `${s.base}/device`, tokenUrl: `${s.base}/token`, clientId: 'cid', scope: 'read', grant: 'device' },
      { sleep: async (ms) => (waits.push(ms), (clock += ms)), now: () => clock, print: (m) => printed.push(m) },
    );
    assert.equal(entry.access_token, 'device-token');
    assert.deepEqual(waits, [2000, 2000, 7000, 7000]);
    assert.equal(entry.polls.slowDowns, 1);
    assert.match(printed.join('\n'), /ABCD-EFGH/);
  } finally {
    await s.close();
  }
});

test('device grant stops on access_denied and on expiry', async () => {
  const s = await fakeServer();
  try {
    s.state.deviceScript = ['access_denied'];
    const cfg = { deviceUrl: `${s.base}/device`, tokenUrl: `${s.base}/token`, clientId: 'cid', grant: 'device' };
    await assert.rejects(deviceAuthorization(cfg, { sleep: async () => {}, print: () => {} }), /access_denied/);
    s.state.deviceScript = Array(1000).fill('authorization_pending');
    let clock = 0;
    await assert.rejects(
      deviceAuthorization(cfg, { sleep: async (ms) => (clock += ms), now: () => clock, print: () => {} }),
      (err) => err.code === 'expired_token',
    );
  } finally {
    await s.close();
  }
});

test('client credentials, and the error message never carries the secret', async () => {
  const s = await fakeServer();
  try {
    const ok = await clientCredentials({ tokenUrl: `${s.base}/token`, clientId: 'cid', clientSecret: 's3cret', scope: 'api://x/.default' });
    assert.equal(ok.access_token, 'cc-token');
    const err = await clientCredentials({ tokenUrl: `${s.base}/token`, clientId: 'cid', clientSecret: 'wrong-secret' }).catch((e) => e);
    assert.match(err.message, /HTTP 401 \(invalid_client\)/);
    assert.doesNotMatch(err.message, /wrong-secret/);
  } finally {
    await s.close();
  }
});

test('getAccessToken uses the cache, refreshes before expiry and fails closed without login', async () => {
  const s = await fakeServer();
  const dir = tmpDir();
  try {
    const cache = createTokenCache(dir);
    const cfg = { tokenUrl: `${s.base}/token`, clientId: 'cid', scope: 'read', grant: 'pkce' };
    await assert.rejects(getAccessToken(cfg, cache), (e) => e.code === 'login_required');
    const now = 5_000_000;
    cache.set(cacheKey(cfg), { access_token: 'still-good', refresh_token: 'rt-1', expires_at: now + 10 * 60_000 });
    assert.equal(await getAccessToken(cfg, cache, { now: () => now }), 'still-good');
    assert.equal(s.state.refreshCount, 0);
    // Inside the 60 s skew: refresh, keep the refresh token.
    cache.set(cacheKey(cfg), { access_token: 'almost-expired', refresh_token: 'rt-1', expires_at: now + 30_000 });
    assert.equal(await getAccessToken(cfg, cache, { now: () => now }), 'refreshed-1');
    assert.equal(cache.get(cacheKey(cfg)).refresh_token, 'rt-1');
    // Expired with a bad refresh token: login needed again.
    cache.set(cacheKey(cfg), { access_token: 'old', refresh_token: 'revoked', expires_at: now - 1 });
    await assert.rejects(getAccessToken(cfg, cache, { now: () => now }), /invalid_grant/);
    // forceRefresh after a 401. The server counted the rejected refresh too.
    cache.set(cacheKey(cfg), { access_token: 'valid', refresh_token: 'rt-1', expires_at: now + 3_600_000 });
    assert.equal(await getAccessToken(cfg, cache, { now: () => now, forceRefresh: true }), 'refreshed-3');
    // Client credentials fetch silently.
    const cc = { tokenUrl: `${s.base}/token`, clientId: 'cid', clientSecret: 's3cret', grant: 'client_credentials' };
    assert.equal(await getAccessToken(cc, cache), 'cc-token');
  } finally {
    await s.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('token cache writes mode 0600 and logout removes the entry', { skip: process.platform === 'win32' && 'no POSIX modes on Windows' }, () => {
  const dir = tmpDir();
  try {
    const cache = createTokenCache(path.join(dir, 'cfg'));
    cache.set('k1', { access_token: 'a', expires_at: null });
    assert.equal(cache.mode(), '600');
    assert.equal((fs.statSync(path.join(dir, 'cfg')).mode & 0o777).toString(8), '700');
    assert.equal(cache.get('k1').access_token, 'a');
    assert.equal(cache.remove('k1'), true);
    assert.equal(cache.get('k1'), null);
    assert.equal(cache.remove('k1'), false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('config dir follows each platform convention', () => {
  assert.match(configDir({ APPDATA: 'C:\\Users\\u\\AppData\\Roaming' }, 'win32'), /Roaming[\\/]ci-medic$/);
  assert.match(configDir({}, 'darwin'), /Library[\\/]Application Support[\\/]ci-medic$/);
  assert.equal(configDir({ XDG_CONFIG_HOME: '/x/cfg' }, 'linux'), path.join('/x/cfg', 'ci-medic'));
  assert.match(configDir({}, 'linux'), /\.config[\\/]ci-medic$/);
});

test('OAuth config from file and env, secret only from env', () => {
  const dir = tmpDir();
  try {
    const file = path.join(dir, 'oauth.json');
    fs.writeFileSync(file, JSON.stringify({ token_url: 'https://id.example/token', client_id: 'cid', scope: 's', client_secret_env: 'MY_SECRET' }));
    const cfg = loadOAuthConfig({ file, env: { MY_SECRET: 'x' } });
    assert.equal(cfg.grant, 'client_credentials');
    assert.equal(cfg.clientSecret, 'x');
    assert.deepEqual(validateOAuthConfig(cfg), []);
    const envWins = loadOAuthConfig({ file, env: { CI_MEDIC_OAUTH_CLIENT_ID: 'other', CI_MEDIC_OAUTH_GRANT: 'device' } });
    assert.equal(envWins.clientId, 'other');
    assert.match(validateOAuthConfig(envWins).join(), /device URL is missing/);
    fs.writeFileSync(file, JSON.stringify({ token_url: 'https://x', client_id: 'c', client_secret: 'inline' }));
    assert.throws(() => loadOAuthConfig({ file, env: {} }), /contains client_secret/);
    fs.writeFileSync(file, JSON.stringify({ token_url: 'https://x', bogus: 1 }));
    assert.throws(() => loadOAuthConfig({ file, env: {} }), /unknown key "bogus"/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('token URLs must be https unless they are loopback', async () => {
  await assert.rejects(clientCredentials({ tokenUrl: 'http://id.example/token', clientId: 'c', clientSecret: 's' }), /must use https/);
  assert.throws(() => parseTokenResponse({ token_type: 'Bearer' }), /no access_token/);
});
