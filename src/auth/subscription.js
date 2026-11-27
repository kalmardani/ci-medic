// Subscription access through the official vendor CLIs only. ci-medic starts
// `claude` and `codex` as subprocesses and asks them about their own state.
// It never opens, reads, copies or forwards the credentials those CLIs store.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { defaultRunner } from '../proc.js';

export const claudeBin = (env = process.env) => env.CI_MEDIC_CLAUDE_BIN || 'claude';
export const codexBin = (env = process.env) => env.CI_MEDIC_CODEX_BIN || 'codex';

export const INSTALL_HINT = {
  claude: 'Install the official Claude Code CLI (see the vendor documentation), then run "claude" once. On Windows point CI_MEDIC_CLAUDE_BIN at claude.exe.',
  codex: 'Install the official Codex CLI (see the vendor documentation). On Windows point CI_MEDIC_CODEX_BIN at the codex executable, not a .cmd shim.',
};

/** Environment for vendor CLIs: the user's env without tokens ci-medic itself uses. */
function cliEnv(env = process.env) {
  const out = { ...env };
  delete out.GITHUB_TOKEN;
  delete out.CI_MEDIC_OAUTH_CLIENT_SECRET;
  return out;
}

async function version(cmd, runner) {
  try {
    const r = await runner.run(cmd, ['--version'], { timeoutMs: 20_000, env: cliEnv() });
    if (r.code !== 0) return null;
    return r.stdout.trim().split('\n')[0].slice(0, 80) || 'unknown';
  } catch {
    return null;
  }
}

/** Ask `claude auth status --json`. Only `loggedIn` and `authMethod` are kept. */
export async function claudeStatus({ runner = defaultRunner, env = process.env } = {}) {
  const bin = claudeBin(env);
  const v = await version(bin, runner);
  if (!v) return { installed: false, version: null, signedIn: false, method: null };
  try {
    const r = await runner.run(bin, ['auth', 'status', '--json'], { timeoutMs: 20_000, env: cliEnv(env) });
    const data = JSON.parse(r.stdout);
    return {
      installed: true,
      version: v,
      signedIn: data.loggedIn === true,
      method: typeof data.authMethod === 'string' ? data.authMethod.slice(0, 40) : null,
    };
  } catch {
    return { installed: true, version: v, signedIn: null, method: null };
  }
}

/** A tiny `claude -p` call with no tools. Proves the CLI can answer. */
export async function claudeProbe({ runner = defaultRunner, env = process.env } = {}) {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'ci-medic-probe-'));
  try {
    const r = await runner.run(
      claudeBin(env),
      ['-p', '--output-format', 'json', '--tools', '', '--strict-mcp-config', '--no-session-persistence'],
      { cwd, input: 'Reply with the single word OK.', timeoutMs: 120_000, env: cliEnv(env) },
    );
    if (r.code !== 0) return { ok: false };
    const data = JSON.parse(r.stdout);
    return { ok: data.is_error !== true && typeof data.result === 'string' };
  } catch {
    return { ok: false };
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
}

/** Ask `codex login status`. Exit code 0 means signed in. The text is not kept. */
export async function codexStatus({ runner = defaultRunner, env = process.env } = {}) {
  const bin = codexBin(env);
  const v = await version(bin, runner);
  if (!v) return { installed: false, version: null, signedIn: false, method: null };
  try {
    const r = await runner.run(bin, ['login', 'status'], { timeoutMs: 20_000, env: cliEnv(env) });
    const text = `${r.stdout}\n${r.stderr}`;
    const method = /ChatGPT/i.test(text) ? 'chatgpt' : /API key/i.test(text) ? 'api key' : null;
    return { installed: true, version: v, signedIn: r.code === 0, method };
  } catch {
    return { installed: true, version: v, signedIn: null, method: null };
  }
}

/**
 * `ci-medic auth login claude` and `ci-medic auth login chatgpt`. If the CLI
 * is not signed in, its own interactive sign in runs in the user's terminal.
 * @returns {Promise<{ok: boolean, message: string}>}
 */
export async function loginWithCli(which, { runner = defaultRunner, env = process.env, print = (s) => process.stderr.write(`${s}\n`) } = {}) {
  if (which === 'claude') {
    const status = await claudeStatus({ runner, env });
    if (!status.installed) return { ok: false, message: `claude CLI not found. ${INSTALL_HINT.claude}` };
    print(`claude CLI ${status.version} found, checking with a tiny probe`);
    if ((await claudeProbe({ runner, env })).ok) return { ok: true, message: 'claude CLI is signed in. Use --provider claude-cli.' };
    print('claude CLI is not signed in. Starting its own sign in, follow the prompts.');
    const code = await runner.runInteractive(claudeBin(env), ['auth', 'login'], { env: cliEnv(env) });
    if (code !== 0) return { ok: false, message: `claude auth login exited with code ${code}` };
    const after = await claudeProbe({ runner, env });
    return after.ok
      ? { ok: true, message: 'claude CLI is signed in. Use --provider claude-cli.' }
      : { ok: false, message: 'claude CLI sign in finished but the probe still fails' };
  }
  if (which === 'chatgpt' || which === 'codex') {
    const status = await codexStatus({ runner, env });
    if (!status.installed) return { ok: false, message: `codex CLI not found. ${INSTALL_HINT.codex}` };
    if (status.signedIn) return { ok: true, message: 'codex CLI is signed in. Use --provider codex-cli.' };
    print('codex CLI is not signed in. Starting its own sign in, follow the prompts.');
    const code = await runner.runInteractive(codexBin(env), ['login'], { env: cliEnv(env) });
    if (code !== 0) return { ok: false, message: `codex login exited with code ${code}` };
    const after = await codexStatus({ runner, env });
    return after.signedIn
      ? { ok: true, message: 'codex CLI is signed in. Use --provider codex-cli.' }
      : { ok: false, message: 'codex login finished but codex still reports no sign in' };
  }
  return { ok: false, message: `unknown subscription "${which}", use claude or chatgpt` };
}
