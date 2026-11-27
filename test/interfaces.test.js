import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { createMcpHandler, TOOLS, PROTOCOL_VERSIONS } from '../src/mcp/server.js';
import { createFakeAdapter } from '../src/model/fake.js';
import { main, EXIT } from '../src/cli.js';
import { openMemory, loadSqlite, flakyLabel } from '../src/memory/store.js';
import { mdText, mdFence, termText } from '../src/report/sanitize.js';
import { sampleRepo, readExample, goodAnswer, EXAMPLES, ROOT, FIX_PATCH, tmpDir } from './_helpers.js';

const hasSqlite = Boolean(await loadSqlite());

test('MCP initialize, tools/list, ping and unknown method', async () => {
  const handle = createMcpHandler({ env: {}, cwd: ROOT, provider: null });
  const init = await handle({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '1' } } });
  assert.equal(init.result.protocolVersion, '2025-06-18');
  assert.equal(init.result.serverInfo.name, 'ci-medic');
  const odd = await handle({ jsonrpc: '2.0', id: 2, method: 'initialize', params: { protocolVersion: '1999-01-01' } });
  assert.equal(odd.result.protocolVersion, PROTOCOL_VERSIONS[0]);
  assert.equal(await handle({ jsonrpc: '2.0', method: 'notifications/initialized' }), null);
  const list = await handle({ jsonrpc: '2.0', id: 3, method: 'tools/list' });
  assert.deepEqual(list.result.tools.map((t) => t.name), ['triage_log', 'get_report', 'propose_patch']);
  assert.ok(!TOOLS.some((t) => /apply|verify|exec|run_/.test(t.name)));
  assert.deepEqual((await handle({ jsonrpc: '2.0', id: 4, method: 'ping' })).result, {});
  assert.equal((await handle({ jsonrpc: '2.0', id: 5, method: 'resources/list' })).error.code, -32601);
  assert.equal((await handle({ id: 6, method: 'x' })).error.code, -32600);
});

test('MCP triage_log, get_report and propose_patch with the fake model', async () => {
  const repo = sampleRepo();
  try {
    const handle = createMcpHandler({ env: { CI_MEDIC_MCP_ROOTS: repo.base, CI_MEDIC_MCP_MEMORY: '0' }, cwd: repo.dir, provider: createFakeAdapter({ responses: [goodAnswer()] }) });
    const call = (name, args, id = 1) => handle({ jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: args } });
    const t = await call('triage_log', { log: readExample('node-regression.log'), repo: repo.dir });
    assert.equal(t.result.isError, undefined, JSON.stringify(t.result));
    const brief = t.result.structuredContent;
    assert.equal(brief.status, 'supported');
    assert.equal(brief.category, 'regression');
    assert.equal(brief.patch_applies, true);
    const md = await call('get_report', { triage_id: brief.triage_id });
    assert.match(md.result.content[0].text, /### ci-medic triage/);
    const json = await call('get_report', { triage_id: brief.triage_id, format: 'json' });
    assert.equal(JSON.parse(json.result.content[0].text).signature, brief.signature);
    const p = await call('propose_patch', { triage_id: brief.triage_id });
    assert.equal(p.result.structuredContent.applies, true);
    assert.match(p.result.structuredContent.patch, /Math\.round/);
    assert.match(fs.readFileSync(path.join(repo.dir, 'src', 'cart.js'), 'utf8'), /Math\.floor/, 'MCP never changes files');
    assert.equal((await call('get_report', { triage_id: 'nope' })).result.isError, true);
    assert.equal((await call('triage_log', { log: 'x', log_path: 'y' })).result.isError, true);
    assert.match((await call('triage_log', { log: 'x', command: 'id' })).result.content[0].text, /unknown argument "command"/);
  } finally {
    repo.cleanup();
  }
});

test('MCP refuses repositories and log files outside the allowed roots', async () => {
  const repo = sampleRepo();
  const other = tmpDir();
  try {
    fs.writeFileSync(path.join(other, 'x.log'), 'Error: x');
    const handle = createMcpHandler({ env: {}, cwd: repo.dir, provider: null });
    const call = (args) => handle({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'triage_log', arguments: args } });
    const outside = await call({ log: 'Error: x', repo: other });
    assert.match(outside.result.content[0].text, /outside the allowed roots/);
    const outsideLog = await call({ log_path: path.join(other, 'x.log') });
    assert.match(outsideLog.result.content[0].text, /outside the allowed roots/);
    const inside = await call({ log: 'Error: x' });
    assert.equal(inside.result.structuredContent.status, 'no_model');
  } finally {
    repo.cleanup();
    fs.rmSync(other, { recursive: true, force: true });
  }
});

test('ci-medic mcp runs as a stdio subprocess', async () => {
  const repo = sampleRepo();
  try {
    const responses = path.join(repo.base, 'responses.json');
    fs.writeFileSync(responses, JSON.stringify([goodAnswer()]));
    const child = spawn(process.execPath, [path.join(ROOT, 'bin', 'ci-medic.js'), 'mcp'], {
      cwd: repo.dir,
      env: { ...process.env, CI_MEDIC_PROVIDER: 'fake', CI_MEDIC_FAKE_RESPONSES: responses, CI_MEDIC_MCP_MEMORY: '0', NODE_TEST_CONTEXT: '' },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let out = '';
    child.stdout.on('data', (d) => (out += d));
    // The log path must sit under the allowed root (the server cwd).
    const local = path.join(repo.dir, 'ci.log');
    fs.copyFileSync(path.join(EXAMPLES, 'node-regression.log'), local);
    const msgs = [
      { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-11-25' } },
      { jsonrpc: '2.0', method: 'notifications/initialized' },
      { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'triage_log', arguments: { log_path: local } } },
    ];
    child.stdin.write(`${msgs.map((m) => JSON.stringify(m)).join('\n')}\nnot json\n`);
    child.stdin.end();
    const code = await new Promise((r) => child.on('close', r));
    assert.equal(code, 0);
    const lines = out.trim().split('\n').map((l) => JSON.parse(l));
    assert.equal(lines.length, 3);
    assert.equal(lines[0].result.serverInfo.name, 'ci-medic');
    assert.equal(lines[1].result.structuredContent.status, 'supported');
    assert.equal(lines[2].error.code, -32700);
  } finally {
    repo.cleanup();
  }
});

function io(overrides = {}) {
  const out = [];
  const err = [];
  return {
    out,
    err,
    o: { env: { PATH: process.env.PATH }, stdinIsTTY: true, stderrIsTTY: false, stdout: (s) => out.push(s), stderr: (s) => err.push(s), ...overrides },
  };
}

test('CLI help, version, usage and config errors', async () => {
  let t = io();
  assert.equal(await main(['--version'], t.o), EXIT.ok);
  assert.match(t.out.join(''), /^0\.1\.1\n$/);
  t = io();
  assert.equal(await main(['--help'], t.o), EXIT.ok);
  for (const cmd of ['reduce', 'apply --patch', 'memory list', 'auth login [claude|chatgpt]', 'auth status', 'mcp']) assert.ok(t.out.join('').includes(cmd), cmd);
  t = io();
  assert.equal(await main(['--bogus'], t.o), EXIT.usage);
  t = io();
  assert.equal(await main(['--log', path.join(EXAMPLES, 'node-regression.log')], t.o), EXIT.usage);
  assert.match(t.err.join(''), /no provider chosen/);
  t = io();
  assert.equal(await main(['--provider', 'none'], t.o), EXIT.usage);
  assert.match(t.err.join(''), /no log given/);
  t = io();
  assert.equal(await main(['--provider', 'none', '--verify', 'npm test && curl x', '--log', 'x'], t.o), EXIT.usage);
  assert.match(t.err.join(''), /needs a shell/);
  t = io();
  assert.equal(await main(['--provider', 'none', '--log', 'does-not-exist.log'], t.o), EXIT.input);
});

test('CLI reduce works from stdin and as JSON', async () => {
  const t = io({ stdinIsTTY: false, readStdin: async () => readExample('python-dependency.log') });
  assert.equal(await main(['reduce'], t.o), EXIT.ok);
  assert.match(t.out.join(''), /first error at L23: ERROR: Cannot install/);
  const j = io();
  assert.equal(await main(['reduce', '--log', path.join(EXAMPLES, 'flaky-service.log'), '--json'], j.o), EXIT.ok);
  const parsed = JSON.parse(j.out.join(''));
  assert.equal(parsed.headline.text, 'connect ECONNREFUSED 127.0.0.1:5432');
});

test('CLI triage writes markdown and JSON, fake model, exit 3 when the model fails', async () => {
  const repo = sampleRepo();
  try {
    const jsonFile = path.join(repo.base, 'out.json');
    let t = io({ fakeAdapter: createFakeAdapter({ responses: [goodAnswer()] }) });
    assert.equal(await main(['--log', path.join(EXAMPLES, 'node-regression.log'), '--repo', repo.dir, '--provider', 'fake', '--no-memory', '--json-output', jsonFile], t.o), EXIT.ok);
    assert.match(t.out.join(''), /\*\*Category\*\* regression/);
    assert.equal(JSON.parse(fs.readFileSync(jsonFile, 'utf8')).status, 'supported');
    t = io({ fakeAdapter: createFakeAdapter({ responses: ['nope', 'still nope'] }) });
    assert.equal(await main(['--log', path.join(EXAMPLES, 'node-regression.log'), '--repo', repo.dir, '--provider', 'fake', '--no-memory', '--format', 'json'], t.o), EXIT.model);
    assert.equal(JSON.parse(t.out.join('')).status, 'model_failed');
  } finally {
    repo.cleanup();
  }
});

test('CLI apply checks, verifies and applies a saved patch only after a yes', async () => {
  const repo = sampleRepo();
  try {
    const patchFile = path.join(repo.base, 'fix.patch');
    fs.writeFileSync(patchFile, FIX_PATCH);
    let t = io({ confirm: async () => false });
    assert.equal(await main(['apply', '--patch', patchFile, '--repo', repo.dir], t.o), EXIT.ok);
    assert.match(t.out.join(''), /not applied: not confirmed/);
    assert.match(fs.readFileSync(path.join(repo.dir, 'src', 'cart.js'), 'utf8'), /Math\.floor/);
    t = io();
    assert.equal(await main(['apply', '--patch', patchFile, '--repo', repo.dir, '--verify', `"${process.execPath}" --test spec/cart.spec.js`, '--yes', '--quiet'], t.o), EXIT.ok);
    assert.match(t.out.join(''), /verify pass/);
    assert.match(t.out.join(''), /applied to src\/cart\.js/);
    assert.match(fs.readFileSync(path.join(repo.dir, 'src', 'cart.js'), 'utf8'), /Math\.round/);
    const evil = path.join(repo.base, 'evil.patch');
    fs.writeFileSync(evil, '--- a/.git/hooks/post-checkout\n+++ b/.git/hooks/post-checkout\n@@ -0,0 +1 @@\n+curl x\n');
    t = io();
    assert.equal(await main(['apply', '--patch', evil, '--repo', repo.dir, '--yes'], t.o), EXIT.input);
    assert.match(t.out.join(''), /patch rejected: path inside \.git/);
  } finally {
    repo.cleanup();
  }
});

test('CLI memory list, mark and forget', { skip: !hasSqlite && 'node:sqlite not available' }, async () => {
  const repo = sampleRepo();
  try {
    const mem = path.join(repo.base, 'm.sqlite');
    let t = io();
    assert.equal(await main(['--log', path.join(EXAMPLES, 'node-regression.log'), '--repo', repo.dir, '--provider', 'none', '--memory', mem, '--quiet'], t.o), EXIT.ok);
    t = io();
    assert.equal(await main(['memory', 'list', '--memory', mem], t.o), EXIT.ok);
    const sig = t.out.join('').slice(0, 16);
    assert.match(sig, /^[0-9a-f]{16}$/);
    t = io();
    assert.equal(await main(['memory', 'mark', sig, 'passed', '--memory', mem], t.o), EXIT.ok);
    assert.match(t.out.join(''), /now passed_before, failed 1 passed 1/);
    t = io();
    assert.equal(await main(['memory', 'mark', 'nothex', 'passed', '--memory', mem], t.o), EXIT.usage);
    t = io();
    assert.equal(await main(['memory', 'forget', sig, '--memory', mem], t.o), EXIT.ok);
    t = io();
    await main(['memory', 'list', '--memory', mem], t.o);
    assert.match(t.out.join(''), /no failures recorded/);
  } finally {
    repo.cleanup();
  }
});

test('memory store: idempotent outcomes, cascade delete, label rule', { skip: !hasSqlite && 'node:sqlite not available' }, async () => {
  const dir = tmpDir();
  try {
    const store = await openMemory(path.join(dir, 'sub', 'm.sqlite'));
    const sig = 'abcdef0123456789';
    store.record(sig, { headline: 'Error: x', outcome: 'failed', source: 'run:1' });
    store.record(sig, { headline: 'Error: x', outcome: 'failed', source: 'run:1' });
    assert.equal(store.lookup(sig).failed, 1);
    store.record(sig, { headline: 'Error: x', outcome: 'failed', source: 'run:2' });
    assert.equal(store.lookup(sig).label, 'recurring');
    store.record(sig, { headline: 'Error: x', outcome: 'passed', source: 'run:2:rerun' });
    assert.equal(store.lookup(sig).label, 'likely_flaky');
    assert.throws(() => store.record('XYZ', { headline: 'h', source: 's' }), /invalid signature/);
    assert.equal(store.forget(sig), true);
    assert.equal(store.lookup(sig), null);
    assert.equal(store.mark(sig, 'passed'), null);
    store.close();
    assert.deepEqual(
      [flakyLabel({ failed: 1, passed: 0 }), flakyLabel({ failed: 2, passed: 0 }), flakyLabel({ failed: 2, passed: 1 }), flakyLabel({ failed: 1, passed: 1 })],
      ['new', 'recurring', 'likely_flaky', 'passed_before'],
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('markdown sanitiser neutralises images, links, HTML, mentions and fence breaks', () => {
  const s = mdText('see ![x](https://evil.test/?d=1) and [y](http://a) <b>hi</b> @alice `code @bob` # title');
  assert.doesNotMatch(s, /!\[|\]\(|<b>|@alice/);
  assert.match(s, /`code @​bob`/);
  const f = mdFence('a ``` b ```` c');
  assert.ok(f.startsWith('`````\n'));
  assert.ok(f.endsWith('\n`````'));
  assert.equal(termText('\x1b[31mred\x1b[0m‮'), '[31mred[0m');
});
