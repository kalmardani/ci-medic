// Patch proof. `git apply --check` always; optionally the user's command runs
// on the patched code in a temporary worktree that is removed afterwards. The
// real working tree changes only through `applyToWorkingTree`.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { defaultRunner, scrubbedEnv } from '../proc.js';

function withPatchFile(patch, fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ci-medic-patch-'));
  const file = path.join(dir, 'proposed.patch');
  fs.writeFileSync(file, patch);
  return Promise.resolve()
    .then(() => fn(file, dir))
    .finally(() => fs.rmSync(dir, { recursive: true, force: true }));
}

export function checkApplies(git, patch) {
  return withPatchFile(patch, (file) => git.applyCheck(file));
}

function tail(text, n = 4000) {
  const s = String(text ?? '');
  return s.length > n ? `[...]\n${s.slice(-n)}` : s;
}

/**
 * @param {{git: object, patch: string, argv: string[], timeoutMs: number, runner?: object}} args
 */
export async function verifyInWorktree({ git, patch, argv, timeoutMs, runner = defaultRunner }) {
  return withPatchFile(patch, async (file, dir) => {
    const wt = path.join(dir, 'worktree');
    await git.worktreePrune();
    await git.worktreeAdd(wt);
    try {
      const applied = await git.apply(file, wt);
      if (!applied.ok) return { result: 'error', message: `patch did not apply in the worktree: ${applied.message}`, exitCode: null, ms: 0, output: '' };
      let r;
      try {
        r = await runner.run(argv[0], argv.slice(1), { cwd: wt, env: scrubbedEnv(), timeoutMs, maxBytes: 1024 * 1024 });
      } catch (err) {
        const hint = err.code === 'ENOENT' ? ' (not found on PATH)' : err.code === 'EINVAL' ? ' (on Windows, .cmd and .bat files need a shell; call the .exe or node directly)' : '';
        return { result: 'error', message: `could not start "${argv[0]}"${hint}`, exitCode: null, ms: 0, output: '' };
      }
      const output = tail(`${r.stdout}\n${r.stderr}`.trim());
      if (r.timedOut) return { result: 'fail', message: `timed out after ${Math.round(timeoutMs / 1000)} s`, exitCode: null, ms: r.ms, output };
      return { result: r.code === 0 ? 'pass' : 'fail', message: `exit code ${r.code}`, exitCode: r.code, ms: r.ms, output };
    } finally {
      await git.worktreeRemove(wt);
    }
  });
}

export async function applyToWorkingTree(git, patch) {
  return withPatchFile(patch, async (file) => {
    const check = await git.applyCheck(file);
    if (!check.ok) return { ok: false, message: `patch no longer applies: ${check.message}` };
    return git.apply(file);
  });
}
