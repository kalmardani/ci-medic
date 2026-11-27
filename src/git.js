// Git access. Always spawned with an argument array, user paths only after `--`,
// hooks pointed at a directory that does not exist, no pager, no external diff,
// no terminal prompts.
import path from 'node:path';
import os from 'node:os';
import { randomBytes } from 'node:crypto';
import { defaultRunner } from './proc.js';

const NO_HOOKS = path.join(os.tmpdir(), `ci-medic-no-hooks-${randomBytes(6).toString('hex')}`);

export class GitError extends Error {
  constructor(message, result) {
    super(message);
    this.name = 'GitError';
    this.code = result?.code ?? null;
    this.stderr = result?.stderr ?? '';
  }
}

function gitEnv() {
  return {
    ...process.env,
    GIT_TERMINAL_PROMPT: '0',
    GIT_PAGER: 'cat',
    GIT_OPTIONAL_LOCKS: '0',
    GIT_CONFIG_NOSYSTEM: process.env.GIT_CONFIG_NOSYSTEM ?? '',
  };
}

/**
 * @param {string} repoDir directory inside a git checkout
 * @param {{runner?: {run: Function}, timeoutMs?: number}} [opts]
 */
export function createGit(repoDir, opts = {}) {
  const runner = opts.runner ?? defaultRunner;
  const timeoutMs = opts.timeoutMs ?? 60_000;
  const base = ['-c', `core.hooksPath=${NO_HOOKS}`, '-c', 'core.fsmonitor=false', '-c', 'core.quotepath=off', '--no-pager'];

  async function git(args, { cwd = repoDir, allowFail = false, input, maxBytes, timeout } = {}) {
    let result;
    try {
      result = await runner.run('git', [...base, ...args], {
        cwd,
        env: gitEnv(),
        input,
        maxBytes,
        timeoutMs: timeout ?? timeoutMs,
      });
    } catch (err) {
      if (err.code === 'ENOENT') throw new GitError('git was not found on PATH', null);
      throw err;
    }
    if (result.timedOut) throw new GitError(`git ${args[0]} timed out`, result);
    if (result.code !== 0 && !allowFail) {
      throw new GitError(`git ${args[0]} failed: ${firstLine(result.stderr)}`, result);
    }
    return result;
  }

  return {
    dir: repoDir,
    raw: git,

    async root() {
      const r = await git(['rev-parse', '--show-toplevel']);
      return path.resolve(r.stdout.trim());
    },

    async commonDir() {
      const r = await git(['rev-parse', '--git-common-dir']);
      return path.resolve(repoDir, r.stdout.trim());
    },

    async head() {
      const r = await git(['rev-parse', 'HEAD'], { allowFail: true });
      return r.code === 0 ? r.stdout.trim() : null;
    },

    async hasCommit(sha) {
      if (!/^[0-9a-f]{7,64}$/i.test(sha)) return false;
      const r = await git(['cat-file', '-e', `${sha}^{commit}`], { allowFail: true });
      return r.code === 0;
    },

    /** Tracked files, repo relative, forward slashes. */
    async lsFiles() {
      const r = await git(['ls-files', '-z'], { maxBytes: 64 * 1024 * 1024 });
      return r.stdout.split('\0').filter(Boolean);
    },

    /** Recent commits with diffs touching the given files. No author names or emails. */
    async logPatch(files, { n = 5, maxChars = 8000 } = {}) {
      if (files.length === 0) return '';
      const r = await git(
        ['log', `-n${n}`, '-p', '--no-color', '--no-ext-diff', '--no-textconv', '--date=short', '--format=commit %h %ad %s', '--', ...files],
        { allowFail: true, maxBytes: 2 * 1024 * 1024 },
      );
      if (r.code !== 0) return '';
      return r.stdout.length > maxChars ? `${r.stdout.slice(0, maxChars)}\n[git log truncated]\n` : r.stdout;
    },

    /** Files among `files` with uncommitted changes. */
    async dirty(files) {
      if (files.length === 0) return [];
      const r = await git(['status', '--porcelain', '-z', '--', ...files], { allowFail: true });
      if (r.code !== 0) return [];
      return r.stdout
        .split('\0')
        .filter(Boolean)
        .map((entry) => entry.slice(3));
    },

    async applyCheck(patchFile, cwd = repoDir) {
      const r = await git(['apply', '--check', '--recount', '--whitespace=nowarn', patchFile], { cwd, allowFail: true });
      return { ok: r.code === 0, message: r.code === 0 ? '' : clip(r.stderr, 2000) };
    },

    async apply(patchFile, cwd = repoDir) {
      const r = await git(['apply', '--recount', '--whitespace=nowarn', patchFile], { cwd, allowFail: true });
      return { ok: r.code === 0, message: r.code === 0 ? '' : clip(r.stderr, 2000) };
    },

    async worktreeAdd(dir) {
      await git(['worktree', 'add', '--detach', dir, 'HEAD'], { timeout: Math.max(timeoutMs, 300_000) });
    },

    async worktreeRemove(dir) {
      await git(['worktree', 'remove', '--force', dir], { allowFail: true });
      await git(['worktree', 'prune'], { allowFail: true });
    },

    async worktreePrune() {
      await git(['worktree', 'prune'], { allowFail: true });
    },
  };
}

function firstLine(text) {
  return String(text ?? '').trim().split('\n')[0]?.slice(0, 300) ?? '';
}

function clip(text, n) {
  const s = String(text ?? '').trim();
  return s.length > n ? `${s.slice(0, n)} [truncated]` : s;
}
