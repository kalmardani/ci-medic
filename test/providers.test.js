import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { fetchWithRetry, safeOrigin } from '../src/http.js';
import { resolveProviderConfig, createProvider, createAuth, ConfigError } from '../src/model/provider.js';
import { createClaudeCliAdapter } from '../src/model/claude-cli.js';
import { createCodexCliAdapter } from '../src/model/codex-cli.js';
import { parseRunRef, fetchRunLogs } from '../src/github.js';
import { claudeStatus, codexStatus, loginWithCli } from '../src/auth/subscription.js';
import { authStatus, renderAuthStatus } from '../src/auth/status.js';
import { tmpDir } from './_helpers.js';

const noSleep = async () => {};

function res(status, body, headers = {}) {
  return new Response(typeof body === 'string' ? body : JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });
}

test('fetchWithRetry retries 429 and 5xx, honours Retry-After, not 4xx', async () => {
  const waits = [];
  let n = 0;
  const f = async () => [res(429, {}, { 'retry-after': '2' }), res(503, {}), res(200, { ok: true })][n++];
  const r = await fetchWithRetry('https://x.test/a?key=secret', {}, { fetch: f, sleep: async (ms) => waits.push(ms) });
  assert.equal(r.status, 200);
  assert.equal(waits[0], 2000);
  assert.equal(waits.length, 2);
  let m = 0;
  const bad = await fetchWithRetry('https://x.test', {}, { fetch: async () => (m++, res(400, {})), sleep: noSleep });
  assert.equal(bad.status, 400);
  assert.equal(m, 1);
  const err = await fetchWithRetry('https://x.test/p?token=abc', {}, { fetch: async () => { throw new TypeError('fetch failed'); }, sleep: noSleep, retries: 2 }).catch((e) => e);
  assert.match(err.message, /https:\/\/x\.test\/p failed/);
  assert.doesNotMatch(err.message, /token=abc/);
  assert.equal(safeOrigin('https://a.b/c?d=e'), 'https://a.b/c');
});

test('provider config: auth dimension rules', () => {
  assert.throws(() => resolveProviderConfig({}, {}), /no provider chosen/);
  assert.throws(() => resolveProviderConfig({ provider: 'openai' }, {}), /needs a model id/);
  assert.throws(() => resolveProviderConfig({ provider: 'openai', model: 'm', auth: 'subscription' }, {}), /only through the official CLIs/);
  assert.throws(() => resolveProviderConfig({ provider: 'claude-cli', auth: 'api-key' }, {}), /signs in through its own CLI/);
  assert.throws(() => resolveProviderConfig({ provider: 'fake', auth: 'oauth' }, {}), /takes no auth/);
  assert.throws(() => resolveProviderConfig({ provider: 'openai', model: 'm' }, { CI_MEDIC_OPENAI_BASE_URL: 'http://gateway.example/v1' }), /must use https/);
  assert.throws(() => resolveProviderConfig({ provider: 'x' }, {}), ConfigError);
  const c = resolveProviderConfig({ provider: 'anthropic', model: 'm' }, { CI_MEDIC_MAX_TOKENS: '2000' });
  assert.deepEqual([c.auth, c.maxTokens, c.apiKeyEnv, c.baseUrl], ['api-key', 2000, 'ANTHROPIC_API_KEY', 'https://api.anthropic.com']);
  assert.equal(resolveProviderConfig({ provider: 'codex-cli' }, {}).auth, 'subscription');
  assert.equal(resolveProviderConfig({ provider: 'openai', model: 'm' }, { CI_MEDIC_API_KEY_ENV: 'MY_KEY' }).apiKeyEnv, 'MY_KEY');
  assert.equal(createProvider(resolveProviderConfig({ provider: 'none' }, {})), null);
});

test('api-key auth: missing key is an error except for a local OpenAI compatible server', async () => {
  assert.throws(() => createAuth({ auth: 'api-key', provider: 'anthropic', apiKeyEnv: 'ANTHROPIC_API_KEY' }, { env: {} }), /ANTHROPIC_API_KEY is not set/);
  const local = createAuth({ auth: 'api-key', provider: 'openai', apiKeyEnv: 'OPENAI_API_KEY', baseUrl: 'http://127.0.0.1:11434/v1' }, { env: {} });
  assert.equal(await local.bearer(), null);
});

async function chatServer(handler) {
  const seen = [];
  const server = http.createServer(async (req, resp) => {
    let body = '';
    for await (const c of req) body += c;
    seen.push({ url: req.url, headers: req.headers, body: body ? JSON.parse(body) : null });
    const [status, payload] = handler(seen.length, req);
    resp.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(payload));
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return { base: `http://127.0.0.1:${server.address().port}`, seen, close: () => new Promise((r) => server.close(r)) };
}

test('openai adapter talks chat completions to a local server', async () => {
  const s = await chatServer(() => [200, { model: 'local-7b', choices: [{ message: { content: '{"x":1}' }, finish_reason: 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 3 } }]);
  try {
    const cfg = resolveProviderConfig({ provider: 'openai', model: 'local-7b' }, { CI_MEDIC_OPENAI_BASE_URL: `${s.base}/v1` });
    const p = createProvider(cfg, { env: { OPENAI_API_KEY: 'sk-test' } });
    const out = await p.complete({ system: 'sys', user: 'usr' });
    assert.equal(out.text, '{"x":1}');
    assert.deepEqual([out.usage.inputTokens, out.usage.outputTokens], [10, 3]);
    assert.equal(s.seen[0].url, '/v1/chat/completions');
    assert.equal(s.seen[0].headers.authorization, 'Bearer sk-test');
    assert.equal(s.seen[0].body.max_tokens, 4096);
    assert.deepEqual(s.seen[0].body.messages.map((m) => m.role), ['system', 'user']);
  } finally {
    await s.close();
  }
});

test('anthropic adapter sends x-api-key, or a bearer token with OAuth, and refreshes once on 401', async () => {
  const s = await chatServer((n) =>
    n === 2 ? [401, { type: 'error', error: { type: 'authentication_error' } }] : [200, { model: 'm-1', content: [{ type: 'text', text: 'hi' }], usage: { input_tokens: 5, output_tokens: 1 }, stop_reason: 'end_turn' }],
  );
  try {
    const cfg = resolveProviderConfig({ provider: 'anthropic', model: 'm-1' }, { CI_MEDIC_ANTHROPIC_BASE_URL: s.base });
    const p = createProvider(cfg, { env: { ANTHROPIC_API_KEY: 'key-1' } });
    assert.equal((await p.complete({ system: 's', user: 'u' })).text, 'hi');
    assert.equal(s.seen[0].headers['x-api-key'], 'key-1');
    assert.equal(s.seen[0].headers['anthropic-version'], '2023-06-01');
    assert.equal(s.seen[0].url, '/v1/messages');

    const { createAnthropicAdapter } = await import('../src/model/anthropic.js');
    const tokens = [];
    const oauthAuth = { kind: 'oauth', canRefresh: true, bearer: async ({ forceRefresh }) => (tokens.push(forceRefresh), forceRefresh ? 'tok-2' : 'tok-1') };
    const a = createAnthropicAdapter({ baseUrl: s.base, model: 'm-1', maxTokens: 100, timeoutMs: 5000, auth: oauthAuth });
    assert.equal((await a.complete({ system: 's', user: 'u' })).text, 'hi');
    assert.equal(s.seen[1].headers.authorization, 'Bearer tok-1');
    assert.equal(s.seen[2].headers.authorization, 'Bearer tok-2');
    assert.deepEqual(tokens, [false, true]);
  } finally {
    await s.close();
  }
});

function fakeRunner(script) {
  const calls = [];
  return {
    calls,
    async run(cmd, args, opts) {
      calls.push({ cmd, args, opts });
      return { code: 0, signal: null, stdout: '', stderr: '', timedOut: false, truncated: false, ms: 1, ...script(cmd, args, opts, calls.length) };
    },
    async runInteractive(cmd, args) {
      calls.push({ cmd, args, interactive: true });
      return 0;
    },
  };
}

test('claude-cli adapter: no tools, no MCP, prompt on stdin, parses the JSON result', async () => {
  const runner = fakeRunner(() => ({
    stdout: JSON.stringify({ type: 'result', is_error: false, result: '{"ok":true}', total_cost_usd: 0.01, usage: { input_tokens: 4, cache_read_input_tokens: 6, output_tokens: 2 }, modelUsage: { 'claude-x-1': {} } }),
  }));
  const a = createClaudeCliAdapter({ model: null, timeoutMs: 1000, runner, env: { GITHUB_TOKEN: 'gh-secret', PATH: process.env.PATH } });
  const out = await a.complete({ system: 'SYS', user: 'USER' });
  assert.equal(out.text, '{"ok":true}');
  assert.equal(out.model, 'claude-x-1');
  assert.deepEqual([out.usage.inputTokens, out.usage.outputTokens, out.usage.costUsd], [10, 2, 0.01]);
  const c = runner.calls[0];
  assert.equal(c.cmd, 'claude');
  assert.deepEqual(c.args.slice(0, 8), ['-p', '--output-format', 'json', '--tools', '', '--strict-mcp-config', '--no-session-persistence', '--system-prompt']);
  assert.equal(c.opts.input, 'USER');
  assert.equal(c.opts.env.GITHUB_TOKEN, undefined);
  assert.ok(!c.args.includes('USER'));
});

test('claude-cli adapter retries transient errors and reports missing sign in', async () => {
  const runner = fakeRunner((cmd, args, opts, n) => (n === 1 ? { code: 1, stderr: 'API Error: 529 overloaded' } : { stdout: JSON.stringify({ is_error: false, result: 'x' }) }));
  const a = createClaudeCliAdapter({ timeoutMs: 1000, runner, env: {}, sleep: noSleep });
  assert.equal((await a.complete({ system: 's', user: 'u' })).text, 'x');
  assert.equal(runner.calls.length, 2);
  const notSigned = createClaudeCliAdapter({ timeoutMs: 1000, runner: fakeRunner(() => ({ code: 1, stdout: JSON.stringify({ is_error: true, result: 'Not logged in. Please run /login' }) })), env: {}, sleep: noSleep });
  await assert.rejects(notSigned.complete({ system: 's', user: 'u' }), /ci-medic auth login claude/);
});

test('codex-cli adapter runs exec in a read only sandbox and reads the last message', async () => {
  const fs = await import('node:fs');
  const runner = fakeRunner((cmd, args) => {
    fs.writeFileSync(args[args.indexOf('-o') + 1], '{"from":"codex"}');
    return {};
  });
  const a = createCodexCliAdapter({ model: null, timeoutMs: 1000, runner, env: {} });
  assert.equal((await a.complete({ system: 'S', user: 'U' })).text, '{"from":"codex"}');
  const c = runner.calls[0];
  assert.equal(c.cmd, 'codex');
  for (const flag of ['exec', '--skip-git-repo-check', '--ephemeral', '--ignore-rules']) assert.ok(c.args.includes(flag), flag);
  assert.equal(c.args[c.args.indexOf('--sandbox') + 1], 'read-only');
  assert.equal(c.args.at(-1), '-');
  assert.equal(c.opts.input, 'S\n\nU');
});

test('subscription status and login use only the official CLI commands', async () => {
  const runner = fakeRunner((cmd, args) => {
    if (args[0] === '--version') return { stdout: cmd === 'claude' ? '2.1.0 (Claude Code)\n' : 'codex-cli 0.1.0\n' };
    if (cmd === 'claude' && args[0] === 'auth') return { stdout: JSON.stringify({ loggedIn: true, authMethod: 'claude.ai', email: 'person@example.com', orgName: 'Org' }) };
    if (cmd === 'claude' && args[0] === '-p') return { stdout: JSON.stringify({ is_error: false, result: 'OK' }) };
    if (cmd === 'codex' && args[0] === 'login') return { code: 1, stdout: 'Not logged in' };
    return { code: 1 };
  });
  const cs = await claudeStatus({ runner, env: {} });
  assert.deepEqual(cs, { installed: true, version: '2.1.0 (Claude Code)', signedIn: true, method: 'claude.ai' });
  assert.ok(!JSON.stringify(cs).includes('person@example.com'));
  const xs = await codexStatus({ runner, env: {} });
  assert.equal(xs.signedIn, false);
  const claude = await loginWithCli('claude', { runner, env: {}, print: () => {} });
  assert.equal(claude.ok, true);
  assert.ok(!runner.calls.some((c) => c.interactive), 'already signed in, no interactive login');
  const before = runner.calls.length;
  await loginWithCli('chatgpt', { runner, env: {}, print: () => {} });
  const interactive = runner.calls.slice(before).filter((c) => c.interactive);
  assert.deepEqual(interactive.map((c) => [c.cmd, ...c.args]), [['codex', 'login']]);
});

test('subscription login prints the install hint when the CLI is missing', async () => {
  const runner = { run: async () => { const e = new Error('spawn claude ENOENT'); e.code = 'ENOENT'; throw e; }, runInteractive: async () => 0 };
  const r = await loginWithCli('claude', { runner, env: {}, print: () => {} });
  assert.equal(r.ok, false);
  assert.match(r.message, /claude CLI not found. Install the official/);
});

test('auth status covers every connection type and never prints a secret', async () => {
  const runner = fakeRunner((cmd, args) => (args[0] === '--version' ? { stdout: `${cmd} 1.0\n` } : cmd === 'claude' ? { stdout: '{"loggedIn":false}' } : { code: 0, stdout: 'Logged in using ChatGPT' }));
  const dir = tmpDir();
  const env = { OPENAI_API_KEY: 'sk-very-secret', GITHUB_TOKEN: 'ghp_secret', CI_MEDIC_CONFIG_DIR: dir, CI_MEDIC_OAUTH_TOKEN_URL: 'https://id.example/token', CI_MEDIC_OAUTH_CLIENT_ID: 'cid', CI_MEDIC_OAUTH_AUTH_URL: 'https://id.example/auth' };
  const s = await authStatus({ env, runner });
  const text = renderAuthStatus(s);
  assert.match(text, /OPENAI_API_KEY set, ANTHROPIC_API_KEY not set/);
  assert.match(text, /oauth +grant pkce, no token/);
  assert.match(text, /claude-cli +claude 1\.0, not signed in, run "ci-medic auth login claude"/);
  assert.match(text, /codex-cli +codex 1\.0, signed in \(chatgpt\)/);
  assert.match(text, /GITHUB_TOKEN set/);
  const all = text + JSON.stringify(s);
  assert.doesNotMatch(all, /sk-very-secret|ghp_secret/);
});

test('parseRunRef reads URLs and the short form, nothing else', () => {
  assert.deepEqual(parseRunRef('https://github.com/o/r/actions/runs/123/attempts/2'), { owner: 'o', repo: 'r', runId: '123', attempt: 2, jobId: null });
  assert.deepEqual(parseRunRef('https://github.com/o/r/actions/runs/5/job/77'), { owner: 'o', repo: 'r', runId: '5', attempt: null, jobId: '77' });
  assert.equal(parseRunRef('o/r:9').runId, '9');
  assert.throws(() => parseRunRef('https://github.com/o/r/pull/1'), /cannot read a GitHub Actions run/);
  assert.throws(() => parseRunRef('o$/r:9'), /unexpected characters/);
});

test('fetchRunLogs follows the log redirect without forwarding the token', async () => {
  const seen = [];
  const f = async (url, init) => {
    seen.push({ url, auth: init.headers?.authorization ?? null, redirect: init.redirect });
    if (url.endsWith('/actions/runs/42')) return res(200, { run_attempt: 2, conclusion: 'success', head_sha: 'abc1234def', html_url: 'https://github.com/o/r/actions/runs/42', name: 'CI' });
    if (url.includes('/attempts/1/jobs')) return res(200, { jobs: [{ id: 7, name: 'test (ubuntu)', conclusion: 'failure', steps: [{ name: 'npm test', conclusion: 'failure' }] }, { id: 8, name: 'lint', conclusion: 'success' }] });
    if (url.endsWith('/actions/jobs/7/logs')) return new Response(null, { status: 302, headers: { location: 'https://logs.example.test/signed?sig=1' } });
    if (url.startsWith('https://logs.example.test/')) return new Response('2026-11-27T10:00:00.0000000Z Error: boom\n', { status: 200 });
    return res(404, { message: 'Not Found' });
  };
  const out = await fetchRunLogs({ owner: 'o', repo: 'r', runId: '42', attempt: 1, jobId: null }, { token: 'ghp_x', fetch: f, sleep: noSleep });
  assert.match(out.text, /ci-medic job: test \(ubuntu\) \(failed step: npm test\)/);
  assert.match(out.text, /Error: boom/);
  assert.equal(out.meta.passedOnRerun, true);
  assert.equal(out.meta.headSha, 'abc1234def');
  const logReq = seen.find((s) => s.url.startsWith('https://logs.example.test/'));
  assert.equal(logReq.auth, null);
  assert.equal(seen.find((s) => s.url.endsWith('/jobs/7/logs')).redirect, 'manual');
  assert.ok(seen.filter((s) => s.url.startsWith('https://api.github.com')).every((s) => s.auth === 'Bearer ghp_x'));
});

test('fetchRunLogs explains 404 and refuses non https API bases', async () => {
  const f = async () => res(404, { message: 'Not Found' });
  await assert.rejects(fetchRunLogs({ owner: 'o', repo: 'r', runId: '1' }, { fetch: f, sleep: noSleep }), /HTTP 404: Not Found \(run not found, private repositories need GITHUB_TOKEN\)/);
  await assert.rejects(fetchRunLogs({ owner: 'o', repo: 'r', runId: '1' }, { apiBase: 'http://evil.example', fetch: f }), /must be an https URL/);
  const nofail = async (url) => (url.endsWith('/runs/1') ? res(200, { run_attempt: 1, conclusion: 'success' }) : res(200, { jobs: [{ id: 1, conclusion: 'success' }] }));
  await assert.rejects(fetchRunLogs({ owner: 'o', repo: 'r', runId: '1' }, { fetch: nofail, sleep: noSleep }), /has no failed job/);
});
