import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { triage } from '../src/triage.js';
import { createFakeAdapter } from '../src/model/fake.js';
import { renderMarkdown } from '../src/report/markdown.js';
import { loadSqlite } from '../src/memory/store.js';
import { sampleRepo, readExample, goodAnswer, tmpDir } from './_helpers.js';

const LOG = readExample('node-regression.log');
const hasSqlite = Boolean(await loadSqlite());

function run(repo, responses, opts = {}, deps = {}) {
  const provider = createFakeAdapter({ responses });
  return triage(
    { logText: LOG, source: { kind: 'file' }, repoDir: repo.dir, memory: { enabled: false }, ...opts },
    { provider, ...deps },
  ).then((r) => ({ r, provider }));
}

test('a valid answer is supported, the patch applies, the tree is untouched', async () => {
  const repo = sampleRepo();
  try {
    const before = fs.readFileSync(path.join(repo.dir, 'src', 'cart.js'), 'utf8');
    const { r, provider } = await run(repo, [goodAnswer()]);
    assert.equal(r.status, 'supported');
    assert.equal(r.diagnosis.category, 'regression');
    assert.equal(r.diagnosis.evidence.length, 2);
    assert.equal(r.patch.applies, true);
    assert.equal(r.patch.verify, undefined);
    assert.equal(r.model.calls.length, 1);
    assert.equal(provider.requests.length, 1);
    assert.equal(fs.readFileSync(path.join(repo.dir, 'src', 'cart.js'), 'utf8'), before);
    assert.ok(r.commands.every((c) => c.cmd === 'git'));
    const md = renderMarkdown(r);
    assert.match(md, /### ci-medic triage/);
    assert.match(md, /```diff\n/);
  } finally {
    repo.cleanup();
  }
});

test('an invalid answer gets one repair round with the validation error', async () => {
  const repo = sampleRepo();
  try {
    const { r, provider } = await run(repo, [{ ...goodAnswer(), extra: 1 }, goodAnswer()]);
    assert.equal(r.status, 'supported');
    assert.equal(r.model.calls.length, 2);
    assert.match(provider.requests[1].user, /unknown key "extra"/);
  } finally {
    repo.cleanup();
  }
});

test('two invalid answers fail closed with the deterministic report', async () => {
  const repo = sampleRepo();
  try {
    const { r } = await run(repo, ['not json', '{"category":"regression"}']);
    assert.equal(r.status, 'model_failed');
    assert.equal(r.diagnosis, null);
    assert.equal(r.patch, null);
    assert.match(renderMarkdown(r), /did not return a valid answer/);
  } finally {
    repo.cleanup();
  }
});

test('a provider error fails closed without a second call', async () => {
  const repo = sampleRepo();
  try {
    const { r } = await run(repo, [{ throw: 'HTTP 500' }, goodAnswer()]);
    assert.equal(r.status, 'model_failed');
    assert.equal(r.model.calls.length, 1);
  } finally {
    repo.cleanup();
  }
});

test('invented quotes are dropped and an unsupported diagnosis is capped', async () => {
  const repo = sampleRepo();
  try {
    const { r } = await run(repo, [goodAnswer({ confidence: 0.99, evidence: [{ quote: 'Segmentation fault in libcart', explains: 'made up' }] })]);
    assert.equal(r.status, 'unsupported');
    assert.equal(r.diagnosis.confidence, 0.2);
    assert.equal(r.diagnosis.modelConfidence, 0.99);
    assert.equal(r.diagnosis.dropped.length, 1);
    assert.doesNotMatch(renderMarkdown(r), /Segmentation fault/);
  } finally {
    repo.cleanup();
  }
});

test('a patch that does not apply gets one repair round', async () => {
  const repo = sampleRepo();
  try {
    const broken = '--- a/src/cart.js\n+++ b/src/cart.js\n@@ -1,1 +1,1 @@\n-this line is not in the file\n+x\n';
    const { r, provider } = await run(repo, [goodAnswer({ patch: broken }), goodAnswer()]);
    assert.equal(r.model.calls.length, 2);
    assert.match(provider.requests[1].user, /the patch was rejected: git apply --check failed/);
    assert.equal(r.patch.applies, true);
  } finally {
    repo.cleanup();
  }
});

test('a patch still failing after repair is reported as rejected, not applied', async () => {
  const repo = sampleRepo();
  try {
    const bad = '--- a/../outside.txt\n+++ b/../outside.txt\n@@ -0,0 +1 @@\n+x\n';
    const { r } = await run(repo, [goodAnswer({ patch: bad }), goodAnswer({ patch: bad })], { apply: true, yes: true });
    assert.equal(r.patch.applies, false);
    assert.match(r.patch.reason, /escapes the repository/);
    assert.equal(r.patch.applied.ok, false);
    assert.equal(fs.existsSync(path.join(repo.base, 'outside.txt')), false);
  } finally {
    repo.cleanup();
  }
});

test('--verify runs the command in a temporary worktree and reports pass', async () => {
  const repo = sampleRepo();
  try {
    const argv = [process.execPath, '--test', 'spec/cart.spec.js'];
    const { r } = await run(repo, [goodAnswer()], { verifyArgv: argv, verifyCommand: 'node --test spec/cart.spec.js', verifyTimeoutMs: 60_000 });
    assert.equal(r.patch.verify.result, 'pass', r.patch.verify.output);
    assert.equal(r.patch.verify.row, 3);
    assert.equal(fs.readFileSync(path.join(repo.dir, 'src', 'cart.js'), 'utf8').includes('Math.floor'), true);
    const list = r.commands.filter((c) => c.cmd === 'git' && c.args[0] === 'worktree').map((c) => c.args[1]);
    assert.deepEqual(list.filter((a) => a === 'add' || a === 'remove'), ['add', 'remove']);
  } finally {
    repo.cleanup();
  }
});

test('--verify reports fail when the patch does not fix the test', async () => {
  const repo = sampleRepo();
  try {
    const noop = '--- a/README.md\n+++ b/README.md\n@@ -1,3 +1,3 @@\n # sample-shop\n \n-A tiny fixture used by the ci-medic tests and examples. Cart totals in integer cents.\n+A tiny fixture used by the tests and examples. Cart totals in integer cents.\n';
    const { r } = await run(repo, [goodAnswer({ patch: noop })], {
      verifyArgv: [process.execPath, '--test', 'spec/cart.spec.js'],
      verifyCommand: 'node --test spec/cart.spec.js',
      verifyTimeoutMs: 60_000,
      apply: true,
      yes: true,
    });
    assert.equal(r.patch.applies, true);
    assert.equal(r.patch.verify.result, 'fail');
    assert.equal(r.patch.applied.ok, false);
    assert.equal(r.patch.applied.row, 9);
    assert.match(fs.readFileSync(path.join(repo.dir, 'README.md'), 'utf8'), /ci-medic tests/);
  } finally {
    repo.cleanup();
  }
});

test('--apply without confirmation leaves the working tree alone', async () => {
  const repo = sampleRepo();
  try {
    const asked = [];
    const { r } = await run(repo, [goodAnswer()], { apply: true, confirm: async (q) => (asked.push(q), false) });
    assert.equal(r.patch.applied.ok, false);
    assert.equal(r.patch.applied.row, 6);
    assert.equal(asked.length, 1);
    assert.match(fs.readFileSync(path.join(repo.dir, 'src', 'cart.js'), 'utf8'), /Math\.floor/);
  } finally {
    repo.cleanup();
  }
});

test('--apply with a yes changes the working tree', async () => {
  const repo = sampleRepo();
  try {
    const { r } = await run(repo, [goodAnswer()], { apply: true, confirm: async () => true });
    assert.equal(r.patch.applied.ok, true);
    assert.equal(r.patch.applied.row, 7);
    assert.match(fs.readFileSync(path.join(repo.dir, 'src', 'cart.js'), 'utf8'), /Math\.round/);
  } finally {
    repo.cleanup();
  }
});

test('a directory outside git is an input error', async () => {
  const dir = tmpDir();
  try {
    await assert.rejects(
      triage({ logText: LOG, source: { kind: 'file' }, repoDir: dir, memory: { enabled: false } }, { provider: null }),
      { name: 'InputError' },
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('an empty log is an input error', async () => {
  const repo = sampleRepo();
  try {
    await assert.rejects(triage({ logText: '\n\n', repoDir: repo.dir, memory: { enabled: false } }, {}), /the log is empty/);
  } finally {
    repo.cleanup();
  }
});

test('flaky memory: identical failures that later passed are labelled likely flaky', { skip: !hasSqlite && 'node:sqlite not available' }, async () => {
  const repo = sampleRepo();
  try {
    const memFile = path.join(repo.base, 'memory.sqlite');
    const gh = (attempt, passedOnRerun) => ({ kind: 'github', github: { owner: 'o', repo: 'r', runId: '1', attempt, latestAttempt: 2, passedOnRerun, headSha: null } });
    const first = await triage({ logText: LOG, source: gh(1, true), repoDir: repo.dir, memory: { enabled: true, file: memFile } }, { provider: null });
    assert.equal(first.memory.label, 'passed_before');
    assert.deepEqual([first.memory.failed, first.memory.passed], [1, 1]);
    const again = await triage({ logText: LOG, source: gh(1, true), repoDir: repo.dir, memory: { enabled: true, file: memFile } }, { provider: null });
    assert.deepEqual([again.memory.failed, again.memory.passed], [1, 1], 'same run twice counts once');
    const other = await triage(
      { logText: LOG.replace('24.934296ms', '19.1ms'), source: { kind: 'file' }, repoDir: repo.dir, memory: { enabled: true, file: memFile } },
      { provider: null },
    );
    assert.equal(other.signature, first.signature);
    assert.equal(other.memory.label, 'likely_flaky');
    assert.match(renderMarkdown(other), /likely flaky/);
  } finally {
    repo.cleanup();
  }
});

test('the default memory file lives inside .git, not in the working tree', { skip: !hasSqlite && 'node:sqlite not available' }, async () => {
  const repo = sampleRepo();
  try {
    const r = await triage({ logText: LOG, source: { kind: 'file' }, repoDir: repo.dir }, { provider: null });
    assert.ok(r.memory.file.startsWith(path.join(fs.realpathSync(repo.dir), '.git')) || r.memory.file.includes(`${path.sep}.git${path.sep}`));
    const { execFileSync } = await import('node:child_process');
    assert.equal(execFileSync('git', ['status', '--porcelain'], { cwd: repo.dir, encoding: 'utf8' }), '');
  } finally {
    repo.cleanup();
  }
});
