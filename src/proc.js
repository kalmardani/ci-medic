// Process runner. Every child process in ci-medic starts here, with an argument
// array, shell disabled, a timeout and an output cap. Tests pass their own runner
// object to observe or replace calls.
import { spawn } from 'node:child_process';

const DEFAULT_CAP = 4 * 1024 * 1024;

/**
 * Run a command and collect its output.
 * @param {string} cmd executable name or path
 * @param {string[]} args argument array, never joined into a shell string
 * @param {{cwd?: string, env?: object, input?: string, timeoutMs?: number, maxBytes?: number}} [opts]
 * @returns {Promise<{code: number|null, signal: string|null, stdout: string, stderr: string, timedOut: boolean, truncated: boolean, ms: number}>}
 */
export function run(cmd, args, opts = {}) {
  if (!Array.isArray(args)) throw new TypeError('args must be an array');
  const started = Date.now();
  const cap = opts.maxBytes ?? DEFAULT_CAP;
  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawn(cmd, args, {
        cwd: opts.cwd,
        env: opts.env ?? process.env,
        shell: false,
        windowsHide: true,
        stdio: ['pipe', 'pipe', 'pipe'],
      });
    } catch (err) {
      reject(err);
      return;
    }
    const out = [];
    const errOut = [];
    let outLen = 0;
    let errLen = 0;
    let truncated = false;
    let timedOut = false;
    const timer = opts.timeoutMs
      ? setTimeout(() => {
          timedOut = true;
          child.kill('SIGKILL');
        }, opts.timeoutMs)
      : null;

    child.stdout.on('data', (chunk) => {
      if (outLen < cap) {
        out.push(chunk);
        outLen += chunk.length;
      } else truncated = true;
    });
    child.stderr.on('data', (chunk) => {
      if (errLen < cap) {
        errOut.push(chunk);
        errLen += chunk.length;
      } else truncated = true;
    });
    child.on('error', (err) => {
      if (timer) clearTimeout(timer);
      reject(err);
    });
    child.on('close', (code, signal) => {
      if (timer) clearTimeout(timer);
      resolve({
        code,
        signal,
        stdout: Buffer.concat(out).toString('utf8').slice(0, cap),
        stderr: Buffer.concat(errOut).toString('utf8').slice(0, cap),
        timedOut,
        truncated,
        ms: Date.now() - started,
      });
    });
    child.stdin.on('error', () => {});
    if (opts.input !== undefined) child.stdin.end(opts.input);
    else child.stdin.end();
  });
}

/** The default runner object. Tests replace it with a recorder. */
export const defaultRunner = { run };

/**
 * Wrap a runner so every call is recorded. Used by the injection tests to prove
 * which executables were started.
 */
export function recordingRunner(inner = defaultRunner) {
  const calls = [];
  return {
    calls,
    run(cmd, args, opts) {
      calls.push({ cmd, args: [...args], cwd: opts?.cwd });
      return inner.run(cmd, args, opts);
    },
  };
}

/** Environment for commands that run user or model influenced code. Secrets removed. */
export function scrubbedEnv(env = process.env) {
  const out = {};
  for (const [key, value] of Object.entries(env)) {
    if (/TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL|API_KEY|APIKEY|PRIVATE_KEY|_KEY$/i.test(key)) continue;
    out[key] = value;
  }
  // Set by the Node.js test runner for its children; inherited, it makes a
  // nested `node --test` exit 0 even when tests fail.
  delete out.NODE_TEST_CONTEXT;
  out.CI_MEDIC_VERIFY = '1';
  return out;
}

/**
 * Run a command attached to the user's terminal (inherited stdio), for the
 * official interactive sign in of a vendor CLI. Resolves with the exit code.
 */
export function runInteractive(cmd, args, opts = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { cwd: opts.cwd, env: opts.env ?? process.env, shell: false, stdio: 'inherit' });
    child.on('error', reject);
    child.on('close', (code) => resolve(code));
  });
}

defaultRunner.runInteractive = runInteractive;
