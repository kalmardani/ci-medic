// The vendor CLIs read CLAUDE.md, AGENTS.md and similar files from their working
// directory and send them with every call. Each adapter call must therefore run
// in its own fresh, empty folder under the OS temp dir, never the current
// directory or the repository under triage, and remove it afterwards, also when
// the call fails.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { run } from '../src/proc.js';
import { createClaudeCliAdapter } from '../src/model/claude-cli.js';
import { createCodexCliAdapter } from '../src/model/codex-cli.js';

// A spawn stand in behind the real runner. It records the cwd and what the
// folder holds while the "CLI" runs.
function fakeSpawn(reply) {
  const seen = [];
  const spawn = (cmd, args, opts) => {
    seen.push({ cwd: opts.cwd, existed: fs.existsSync(opts.cwd), entries: fs.readdirSync(opts.cwd), shell: opts.shell });
    const child = new EventEmitter();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.stdin = new PassThrough();
    child.kill = () => {};
    const r = reply(args);
    setImmediate(() => {
      if (r.file) fs.writeFileSync(args[args.indexOf('-o') + 1], r.file);
      child.stdout.end(r.stdout ?? '');
      child.stderr.end(r.stderr ?? '');
      setImmediate(() => child.emit('close', r.code ?? 0, null));
    });
    return child;
  };
  return { seen, runner: { run: (cmd, args, opts) => run(cmd, args, { ...opts, spawnImpl: spawn }) } };
}

function insideTmp(dir) {
  const rel = path.relative(os.tmpdir(), dir);
  return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel);
}

const cases = [
  ['claude-cli', createClaudeCliAdapter, () => ({ stdout: JSON.stringify({ is_error: false, result: 'pong' }) }),
    () => ({ code: 1, stdout: JSON.stringify({ is_error: true, result: 'bad request' }) })],
  ['codex-cli', createCodexCliAdapter, () => ({ file: 'pong' }), () => ({ code: 1, stderr: 'boom' })],
];

for (const [name, make, ok, fail] of cases) {
  test(`${name} runs in a fresh empty temp dir and removes it, also on error`, async () => {
    const good = fakeSpawn(ok);
    const r = await make({ timeoutMs: 5000, runner: good.runner, env: {}, sleep: async () => {} }).complete({ system: 's', user: 'u' });
    assert.equal(r.text, 'pong');
    const bad = fakeSpawn(fail);
    await assert.rejects(make({ timeoutMs: 5000, runner: bad.runner, env: {}, sleep: async () => {} }).complete({ system: 's', user: 'u' }));
    const seen = [...good.seen, ...bad.seen];
    assert.equal(seen.length, 2);
    for (const s of seen) {
      assert.ok(insideTmp(s.cwd), `cwd ${s.cwd} is inside ${os.tmpdir()}`);
      assert.notEqual(s.cwd, process.cwd());
      assert.equal(s.shell, false);
      assert.ok(s.existed, 'the folder exists while the CLI runs');
      assert.deepEqual(s.entries, [], 'the folder is empty');
      assert.ok(!fs.existsSync(s.cwd), 'the folder is gone after the call');
    }
    assert.notEqual(seen[0].cwd, seen[1].cwd, 'every call gets its own folder');
  });
}
