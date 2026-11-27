// Command line interface. Every feature is reachable from here: triage, reduce,
// memory, auth and the MCP server.
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline/promises';
import { parseArgs } from 'node:util';
import { triage, InputError, VERSION } from './triage.js';
import { normalizeLog, reduceLog } from './log/reduce.js';
import { failureSignature } from './log/signature.js';
import { renderMarkdown } from './report/markdown.js';
import { termText } from './report/sanitize.js';
import { resolveProviderConfig, createProvider, ConfigError } from './model/provider.js';
import { parseRunRef, fetchRunLogs } from './github.js';
import { parseCommand, CommandParseError } from './patch/argv.js';
import { openMemory, SIGNATURE_RE } from './memory/store.js';
import { createGit } from './git.js';
import { checkPatch } from './patch/policy.js';
import { decideVerify, decideApply } from './patch/decide.js';
import { checkApplies, verifyInWorktree, applyToWorkingTree } from './patch/verify.js';
import { authStatus, renderAuthStatus } from './auth/status.js';
import { loadOAuthConfig, validateOAuthConfig } from './auth/config.js';
import { createTokenCache, cacheKey } from './auth/token-cache.js';
import { login as oauthLogin } from './auth/oauth.js';
import { loginWithCli } from './auth/subscription.js';
import { openBrowser } from './auth/browser.js';
import { startMcpServer } from './mcp/server.js';

export const EXIT = { ok: 0, error: 1, usage: 2, model: 3, input: 4 };
const MAX_STDIN = 50 * 1024 * 1024;

const HELP = `ci-medic ${VERSION}, triage for failed CI runs

Usage
  ci-medic [triage] --log <file|-> [options]
  ci-medic [triage] --run <github run url> [options]
  ci-medic reduce --log <file|->           print the reduced log view, no model
  ci-medic apply --patch <file> [--verify "<cmd>"] [--yes]
                                           check, verify and apply a saved patch
  ci-medic memory list | forget <sig> | mark <sig> passed|failed
  ci-medic auth login [claude|chatgpt]     sign in (OAuth, or a vendor CLI)
  ci-medic auth status [--json]            show every connection type
  ci-medic auth logout                     remove the cached OAuth token
  ci-medic mcp                             MCP server on stdio

Triage options
  --log <file|->           log file, or - for stdin (stdin is used when piped)
  --run <url>              GitHub Actions run, https://github.com/O/R/actions/runs/ID
  --attempt <n>            run attempt (default latest)
  --repo <dir>             local git checkout (default current directory)
  --provider <name>        openai, anthropic, claude-cli, codex-cli, fake, none
  --auth <kind>            api-key, oauth, subscription, none (default fits provider)
  --model <id>             model id (required for openai and anthropic)
  --max-tokens <n>         output cap per model call (default 4096)
  --oauth-config <file>    OAuth config JSON (default in the user config dir)
  --format <md|json>       stdout format (default md)
  --output <file>          write the report to a file instead of stdout
  --json-output <file>     also write the JSON report to a file
  --verify "<command>"     run this command on the patched code in a temp worktree
  --verify-timeout <s>     verify timeout in seconds (default 600)
  --apply                  apply the patch to the working tree after a yes
  --yes                    answer yes to confirmations
  --memory <file>          flaky memory file (default .git/ci-medic/memory.sqlite)
  --no-memory              do not read or write flaky memory
  --quiet                  no progress messages on stderr

Exit codes  0 report written, 2 usage or config error, 3 model failed (fail closed),
            4 input error (log, git, GitHub), 1 unexpected error
`;

const OPTIONS = {
  log: { type: 'string' },
  run: { type: 'string' },
  attempt: { type: 'string' },
  repo: { type: 'string' },
  provider: { type: 'string' },
  auth: { type: 'string' },
  model: { type: 'string' },
  'max-tokens': { type: 'string' },
  'oauth-config': { type: 'string' },
  format: { type: 'string' },
  output: { type: 'string' },
  'json-output': { type: 'string' },
  verify: { type: 'string' },
  'verify-timeout': { type: 'string' },
  apply: { type: 'boolean' },
  patch: { type: 'string' },
  yes: { type: 'boolean' },
  memory: { type: 'string' },
  'no-memory': { type: 'boolean' },
  quiet: { type: 'boolean' },
  json: { type: 'boolean' },
  grant: { type: 'string' },
  'no-browser': { type: 'boolean' },
  help: { type: 'boolean', short: 'h' },
  version: { type: 'boolean', short: 'v' },
};

class UsageError extends Error {}

async function readStdin() {
  const chunks = [];
  let total = 0;
  for await (const chunk of process.stdin) {
    total += chunk.length;
    if (total > MAX_STDIN) throw new InputError('stdin is larger than 50 MB');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString('utf8');
}

function readLogFile(file) {
  const abs = path.resolve(file);
  let stat;
  try {
    stat = fs.statSync(abs);
  } catch {
    throw new InputError(`log file not found: ${file}`);
  }
  if (!stat.isFile()) throw new InputError(`not a file: ${file}`);
  if (stat.size > MAX_STDIN) throw new InputError('log file is larger than 50 MB');
  return fs.readFileSync(abs, 'utf8');
}

/** Get the log text and its source description from flags. */
export async function loadLog(values, io) {
  if (values.run) {
    if (values.log) throw new UsageError('use either --log or --run, not both');
    const ref = parseRunRef(values.run);
    if (values.attempt) {
      const n = Number(values.attempt);
      if (!Number.isInteger(n) || n < 1) throw new UsageError('--attempt must be a positive integer');
      ref.attempt = n;
    }
    io.progress(`fetching run ${ref.owner}/${ref.repo} ${ref.runId} from GitHub`);
    const env = io.env;
    const fetched = await fetchRunLogs(ref, { token: env.GITHUB_TOKEN || undefined, apiBase: env.GITHUB_API_URL || undefined, fetch: io.fetch });
    if (fetched.truncated) io.progress('the log was larger than 20 MB and was truncated');
    return { text: fetched.text, source: { kind: 'github', github: fetched.meta }, fromStdin: false };
  }
  if (values.log && values.log !== '-') return { text: readLogFile(values.log), source: { kind: 'file', path: values.log }, fromStdin: false };
  if (values.log === '-' || !io.stdinIsTTY) return { text: await io.readStdin(), source: { kind: 'stdin' }, fromStdin: true };
  throw new UsageError('no log given. Use --log <file>, pipe the log on stdin, or --run <url>');
}

function makeConfirm(io, fromStdin) {
  if (fromStdin || !io.stdinIsTTY || !io.stderrIsTTY) return async () => false;
  return async (question) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stderr });
    try {
      const answer = await rl.question(`${termText(question)} [y/N] `);
      return /^y(es)?$/i.test(answer.trim());
    } finally {
      rl.close();
    }
  };
}

async function cmdTriage(values, io) {
  if (values.format && !['md', 'json'].includes(values.format)) throw new UsageError('--format must be md or json');
  const { verifyArgv, verifyTimeoutMs } = parseVerify(values);
  const cfg = resolveProviderConfig(
    { provider: values.provider, auth: values.auth, model: values.model, maxTokens: values['max-tokens'], oauthConfig: values['oauth-config'] },
    io.env,
  );
  const provider = createProvider(cfg, { env: io.env, fetch: io.fetch, runner: io.runner, fakeAdapter: io.fakeAdapter });
  const log = await loadLog(values, io);
  const result = await triage(
    {
      logText: log.text,
      source: log.source,
      repoDir: path.resolve(values.repo ?? io.cwd),
      verifyArgv,
      verifyCommand: values.verify ?? null,
      verifyTimeoutMs,
      apply: Boolean(values.apply),
      yes: Boolean(values.yes),
      memory: { enabled: !values['no-memory'], file: values.memory ? path.resolve(values.memory) : null },
      confirm: io.confirm ?? makeConfirm(io, log.fromStdin),
    },
    { provider, runner: io.runner, progress: io.progress },
  );
  const md = renderMarkdown(result);
  const json = `${JSON.stringify(result, null, 2)}\n`;
  const primary = values.format === 'json' ? json : md;
  if (values.output) fs.writeFileSync(path.resolve(values.output), primary);
  else io.stdout(primary);
  if (values['json-output']) fs.writeFileSync(path.resolve(values['json-output']), json);
  return result.status === 'model_failed' ? EXIT.model : EXIT.ok;
}

function parseVerify(values) {
  let verifyArgv = null;
  if (values.verify !== undefined) {
    try {
      verifyArgv = parseCommand(values.verify);
    } catch (err) {
      if (err instanceof CommandParseError) throw new UsageError(`--verify: ${err.message}`);
      throw err;
    }
  }
  let verifyTimeoutMs = 600_000;
  if (values['verify-timeout']) {
    const s = Number(values['verify-timeout']);
    if (!Number.isFinite(s) || s <= 0 || s > 86_400) throw new UsageError('--verify-timeout must be seconds between 1 and 86400');
    verifyTimeoutMs = Math.round(s * 1000);
  }
  return { verifyArgv, verifyTimeoutMs };
}

/** Apply a saved patch (for example one returned by the MCP propose_patch tool). */
async function cmdApply(values, io) {
  if (!values.patch) throw new UsageError('apply needs --patch <file>');
  const { verifyArgv, verifyTimeoutMs } = parseVerify(values);
  const raw = readLogFile(values.patch);
  const policy = checkPatch(raw);
  if (!policy.ok) {
    io.stdout(`patch rejected: ${policy.errors.join('; ')}\n`);
    return EXIT.input;
  }
  const git = createGit(path.resolve(values.repo ?? io.cwd), { runner: io.runner });
  const root = await git.root();
  const check = await checkApplies(git, policy.patch);
  if (!check.ok) {
    io.stdout(`patch does not apply: ${termText(check.message)}\n`);
    return EXIT.input;
  }
  const confirm = io.confirm ?? makeConfirm(io, false);
  const sensitive = policy.sensitive.length > 0;
  let confirmVerify = Boolean(values.yes);
  if (verifyArgv && sensitive && !confirmVerify) {
    confirmVerify = await confirm(`The patch touches ${policy.sensitive.join(', ')}. Run "${values.verify}" on it in a temporary worktree?`);
  }
  const v = decideVerify({ applies: true, sensitive, verify: Boolean(verifyArgv), confirmVerify });
  let verifyResult = null;
  if (v.runVerify) {
    io.progress(`verifying with: ${values.verify}`);
    const res = await verifyInWorktree({ git, patch: policy.patch, argv: verifyArgv, timeoutMs: verifyTimeoutMs, runner: io.runner });
    verifyResult = res.result;
    io.stdout(`verify ${res.result}: ${res.message}\n`);
    if (res.result !== 'pass' && res.output) io.stdout(`${termText(res.output)}\n`);
  } else if (verifyArgv) {
    verifyResult = 'skipped';
    io.stdout(`verify skipped: ${v.reason}\n`);
  }
  const c = { applies: true, apply: true, verify: Boolean(verifyArgv), verifyResult };
  let d = decideApply({ ...c, confirmApply: true });
  if (d.doApply) {
    const ok = Boolean(values.yes) || (await confirm(`Apply the patch (${policy.files.join(', ')}) to the working tree in ${root}?`));
    d = decideApply({ ...c, confirmApply: ok });
  }
  if (!d.doApply) {
    io.stdout(`not applied: ${d.reason}\n`);
    return EXIT.ok;
  }
  const r = await applyToWorkingTree(git, policy.patch);
  io.stdout(r.ok ? `applied to ${policy.files.join(', ')}\n` : `not applied: ${termText(r.message)}\n`);
  return r.ok ? EXIT.ok : EXIT.input;
}

async function cmdReduce(values, io) {
  const log = await loadLog(values, io);
  const lines = normalizeLog(log.text);
  if (lines.length === 0) throw new InputError('the log is empty');
  const reduced = reduceLog(lines);
  if (values.format === 'json' || values.json) {
    const { view, ...rest } = reduced;
    io.stdout(`${JSON.stringify({ signature: failureSignature(reduced, lines), ...rest, view }, null, 2)}\n`);
  } else {
    io.stdout(`signature: ${failureSignature(reduced, lines)}\n${termText(reduced.view)}\n`);
  }
  return EXIT.ok;
}

async function memoryFile(values, io) {
  if (values.memory) return path.resolve(values.memory);
  const git = createGit(path.resolve(values.repo ?? io.cwd), { runner: io.runner });
  return path.join(await git.commonDir(), 'ci-medic', 'memory.sqlite');
}

async function cmdMemory(positionals, values, io) {
  const [action, sig, outcome] = positionals;
  const store = await openMemory(await memoryFile(values, io));
  if (!store) throw new InputError('node:sqlite is not available. Use Node 22.13 or newer, or run node with --experimental-sqlite');
  try {
    if (action === 'list' || action === undefined) {
      const rows = store.list();
      if (values.json) io.stdout(`${JSON.stringify(rows, null, 2)}\n`);
      else if (rows.length === 0) io.stdout('no failures recorded\n');
      else for (const r of rows) io.stdout(`${r.signature}  ${r.label.padEnd(13)} failed ${r.failed} passed ${r.passed}  last ${r.lastSeen}  ${termText(r.headline).slice(0, 100)}\n`);
      return EXIT.ok;
    }
    if (!SIGNATURE_RE.test(sig ?? '')) throw new UsageError('a signature is 16 lowercase hex characters, see "ci-medic memory list"');
    if (action === 'forget') {
      io.stdout(store.forget(sig) ? `forgot ${sig}\n` : `${sig} was not recorded\n`);
      return EXIT.ok;
    }
    if (action === 'mark') {
      if (outcome !== 'passed' && outcome !== 'failed') throw new UsageError('memory mark <sig> passed|failed');
      const r = store.mark(sig, outcome);
      if (!r) throw new InputError(`${sig} was not recorded`);
      io.stdout(`${sig} now ${r.label}, failed ${r.failed} passed ${r.passed}\n`);
      return EXIT.ok;
    }
    throw new UsageError(`unknown memory action "${action}"`);
  } finally {
    store.close();
  }
}

async function cmdAuth(positionals, values, io) {
  const [action, target] = positionals;
  if (action === 'status' || action === undefined) {
    const status = await authStatus({ env: io.env, runner: io.runner, oauthConfigFile: values['oauth-config'] });
    io.stdout(values.json ? `${JSON.stringify(status, null, 2)}\n` : renderAuthStatus(status));
    return EXIT.ok;
  }
  if (action === 'login' && (target === 'claude' || target === 'chatgpt')) {
    const r = await loginWithCli(target, { runner: io.runner, env: io.env, print: io.progressAlways });
    io.stdout(`${r.message}\n`);
    return r.ok ? EXIT.ok : EXIT.input;
  }
  if (action === 'login' || action === 'logout') {
    if (target) throw new UsageError(`unknown auth target "${target}", use claude, chatgpt, or nothing for OAuth`);
    const env = values.grant ? { ...io.env, CI_MEDIC_OAUTH_GRANT: values.grant } : io.env;
    const cfg = loadOAuthConfig({ file: values['oauth-config'], env });
    const cache = createTokenCache();
    if (action === 'logout') {
      const removed = cfg.tokenUrl && cfg.clientId ? cache.remove(cacheKey(cfg)) : false;
      io.stdout(removed ? 'removed the cached OAuth token\n' : 'no cached OAuth token for this configuration\n');
      io.stdout('Vendor CLIs keep their own sign in, use "claude auth logout" or "codex logout" for those.\n');
      return EXIT.ok;
    }
    const problems = validateOAuthConfig(cfg);
    if (problems.length) throw new ConfigError(`OAuth config incomplete: ${problems.join('; ')}`);
    const entry = await oauthLogin(cfg, cache, {
      fetch: io.fetch,
      print: io.progressAlways,
      openBrowser: values['no-browser'] ? undefined : (url) => openBrowser(url, { runner: io.runner }),
    });
    io.stdout(`signed in with the ${cfg.grant} grant${entry.expires_at ? `, token valid until ${new Date(entry.expires_at).toISOString()}` : ''}\n`);
    return EXIT.ok;
  }
  throw new UsageError(`unknown auth action "${action}"`);
}

/**
 * @param {string[]} argv arguments after the executable and script
 * @param {object} [ioOverrides] for tests
 */
export async function main(argv, ioOverrides = {}) {
  let quiet = false;
  const io = {
    env: process.env,
    cwd: process.cwd(),
    stdinIsTTY: Boolean(process.stdin.isTTY),
    stderrIsTTY: Boolean(process.stderr.isTTY),
    stdout: (s) => process.stdout.write(s),
    stderr: (s) => process.stderr.write(s),
    readStdin,
    fetch: undefined,
    runner: undefined,
    ...ioOverrides,
  };
  io.progress = (msg) => {
    if (!quiet) io.stderr(`ci-medic: ${termText(msg)}\n`);
  };
  io.progressAlways = (msg) => io.stderr(`${termText(msg)}\n`);

  let parsed;
  try {
    parsed = parseArgs({ args: argv, options: OPTIONS, allowPositionals: true, strict: true });
  } catch (err) {
    io.stderr(`ci-medic: ${err.message}\nRun "ci-medic --help" for usage.\n`);
    return EXIT.usage;
  }
  const { values, positionals } = parsed;
  quiet = Boolean(values.quiet);
  if (values.version) {
    io.stdout(`${VERSION}\n`);
    return EXIT.ok;
  }
  if (values.help) {
    io.stdout(HELP);
    return EXIT.ok;
  }
  const [command = 'triage', ...rest] = positionals;
  try {
    switch (command) {
      case 'triage':
        return await cmdTriage(values, io);
      case 'reduce':
        return await cmdReduce(values, io);
      case 'apply':
        return await cmdApply(values, io);
      case 'memory':
        return await cmdMemory(rest, values, io);
      case 'auth':
        return await cmdAuth(rest, values, io);
      case 'mcp':
        await startMcpServer({ env: io.env, cwd: io.cwd, runner: io.runner, fetch: io.fetch, input: io.mcpInput, output: io.mcpOutput, stderr: io.stderr });
        return EXIT.ok;
      default:
        throw new UsageError(`unknown command "${command}"`);
    }
  } catch (err) {
    if (err instanceof UsageError || err instanceof ConfigError) {
      io.stderr(`ci-medic: ${err.message}\n`);
      return EXIT.usage;
    }
    if (['InputError', 'HttpError', 'GitError', 'OAuthError', 'GitHubError'].includes(err.name)) {
      io.stderr(`ci-medic: ${termText(err.message)}\n`);
      return EXIT.input;
    }
    io.stderr(`ci-medic: unexpected error: ${termText(err.message)}\n`);
    if (io.env.CI_MEDIC_DEBUG) io.stderr(`${err.stack}\n`);
    return EXIT.error;
  }
}
