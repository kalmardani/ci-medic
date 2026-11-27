// Subscription adapter through the official `codex` CLI (`codex exec`). It runs
// in a read only sandbox inside an empty temp directory, does not persist the
// session, and writes its last message to a file in that directory, which
// ci-medic reads before the directory is removed.
import fs from 'node:fs';
import path from 'node:path';
import { defaultRunner } from '../proc.js';
import { makeWorkDir, removeWorkDir } from './workdir.js';
import { codexBin, INSTALL_HINT } from '../auth/subscription.js';

export function createCodexCliAdapter({ model, timeoutMs, runner = defaultRunner, env = process.env }) {
  return {
    name: 'codex-cli',
    model: model ?? 'cli default',
    async complete({ system, user }) {
      const dir = makeWorkDir();
      const out = path.join(dir, 'last-message.txt');
      const args = ['exec', '--skip-git-repo-check', '--sandbox', 'read-only', '--ephemeral', '--color', 'never', '--ignore-rules', '-C', dir, '-o', out];
      if (model) args.push('-m', model);
      args.push('-');
      const childEnv = { ...env };
      delete childEnv.GITHUB_TOKEN;
      try {
        let r;
        try {
          r = await runner.run(codexBin(env), args, { cwd: dir, input: `${system}\n\n${user}`, timeoutMs, env: childEnv });
        } catch (err) {
          if (err.code === 'ENOENT' || err.code === 'EINVAL') throw new Error(`codex CLI could not be started. ${INSTALL_HINT.codex}`);
          throw err;
        }
        if (r.code !== 0) {
          const detail = r.timedOut ? 'timed out' : r.stderr.trim().split('\n').slice(-3).join(' ').slice(0, 300);
          if (/login|authenticat|sign in/i.test(detail)) throw new Error('codex CLI is not signed in. Run "ci-medic auth login chatgpt"');
          throw new Error(`codex CLI call failed: ${detail || `exit code ${r.code}`}`);
        }
        const text = fs.existsSync(out) ? fs.readFileSync(out, 'utf8') : r.stdout;
        return { text, model: model ?? 'cli default', usage: { inputTokens: null, outputTokens: null, costUsd: null }, truncated: false };
      } finally {
        removeWorkDir(dir);
      }
    },
  };
}
