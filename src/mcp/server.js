// MCP server over stdio (JSON-RPC 2.0, one message per line). Three tools:
// triage a log, get the report, propose the patch. There is no verify and no
// apply tool: running commands and changing the working tree stay in the CLI,
// behind the user's own flags and confirmation.
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { randomBytes } from 'node:crypto';
import { triage, VERSION } from '../triage.js';
import { renderMarkdown } from '../report/markdown.js';
import { resolveProviderConfig, createProvider } from '../model/provider.js';
import { parseRunRef, fetchRunLogs } from '../github.js';

export const PROTOCOL_VERSIONS = ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];
const MAX_LOG = 20 * 1024 * 1024;
const MAX_CACHE = 20;

export const TOOLS = [
  {
    name: 'triage_log',
    description:
      'Triage one failed CI run. Give exactly one of log (the log text), log_path (a log file under an allowed root) or github_run (a GitHub Actions run URL). Returns a triage_id, the category, a verified root cause and whether a patch was proposed. Uses the model the server was configured with. Never runs commands and never changes files.',
    inputSchema: {
      type: 'object',
      properties: {
        log: { type: 'string', description: 'Full CI log text' },
        log_path: { type: 'string', description: 'Path to a log file under an allowed root' },
        github_run: { type: 'string', description: 'https://github.com/OWNER/REPO/actions/runs/ID' },
        repo: { type: 'string', description: 'Path to the local git checkout, under an allowed root. Default is the server working directory' },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'get_report',
    description: 'Return the report of an earlier triage as markdown (ready for a PR comment) or JSON.',
    inputSchema: {
      type: 'object',
      properties: { triage_id: { type: 'string' }, format: { type: 'string', enum: ['markdown', 'json'] } },
      required: ['triage_id'],
      additionalProperties: false,
    },
  },
  {
    name: 'propose_patch',
    description:
      'Return the proposed unified diff of an earlier triage with its git apply check result and the files it touches. The patch is not applied. To apply it, the user saves it and runs "ci-medic apply --patch <file>" in a terminal, which asks for confirmation.',
    inputSchema: { type: 'object', properties: { triage_id: { type: 'string' } }, required: ['triage_id'], additionalProperties: false },
  },
];

class ToolError extends Error {}

export function allowedRoots(env, cwd) {
  const raw = env.CI_MEDIC_MCP_ROOTS;
  const list = raw ? raw.split(path.delimiter).filter(Boolean) : [cwd];
  return list.map((p) => {
    try {
      return fs.realpathSync(path.resolve(cwd, p));
    } catch {
      return path.resolve(cwd, p);
    }
  });
}

export function insideRoots(p, roots) {
  let real;
  try {
    real = fs.realpathSync(p);
  } catch {
    throw new ToolError(`path does not exist: ${path.basename(p)}`);
  }
  const ok = roots.some((r) => {
    const rel = path.relative(r, real);
    return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
  });
  if (!ok) throw new ToolError('path is outside the allowed roots (set CI_MEDIC_MCP_ROOTS)');
  return real;
}

function text(t) {
  return { content: [{ type: 'text', text: t }] };
}

/**
 * Build a handler for JSON-RPC messages. Exported for tests.
 * @param {{env?: object, cwd?: string, runner?: object, fetch?: Function, provider?: object|null}} deps
 */
export function createMcpHandler(deps = {}) {
  const env = deps.env ?? process.env;
  const cwd = deps.cwd ?? process.cwd();
  const roots = allowedRoots(env, cwd);
  const cache = new Map();
  let providerReady = deps.provider !== undefined ? deps.provider : undefined;

  const getProvider = () => {
    if (providerReady === undefined) providerReady = createProvider(resolveProviderConfig({}, env), { env, fetch: deps.fetch, runner: deps.runner });
    return providerReady;
  };

  async function triageTool(args) {
    const given = ['log', 'log_path', 'github_run'].filter((k) => typeof args[k] === 'string' && args[k].length > 0);
    if (given.length !== 1) throw new ToolError('give exactly one of log, log_path, github_run');
    const repo = insideRoots(path.resolve(cwd, args.repo ?? '.'), roots);
    let logText;
    let source;
    if (given[0] === 'log') {
      if (Buffer.byteLength(args.log) > MAX_LOG) throw new ToolError('log is larger than 20 MB');
      logText = args.log;
      source = { kind: 'mcp' };
    } else if (given[0] === 'log_path') {
      const file = insideRoots(path.resolve(cwd, args.log_path), roots);
      if (fs.statSync(file).size > MAX_LOG) throw new ToolError('log file is larger than 20 MB');
      logText = fs.readFileSync(file, 'utf8');
      source = { kind: 'file', path: path.relative(cwd, file) };
    } else {
      const fetched = await fetchRunLogs(parseRunRef(args.github_run), { token: env.GITHUB_TOKEN || undefined, apiBase: env.GITHUB_API_URL || undefined, fetch: deps.fetch });
      logText = fetched.text;
      source = { kind: 'github', github: fetched.meta };
    }
    const result = await triage(
      { logText, source, repoDir: repo, verifyArgv: null, apply: false, yes: false, memory: { enabled: env.CI_MEDIC_MCP_MEMORY !== '0' } },
      { provider: getProvider(), runner: deps.runner },
    );
    const id = randomBytes(6).toString('hex');
    cache.set(id, result);
    while (cache.size > MAX_CACHE) cache.delete(cache.keys().next().value);
    const brief = {
      triage_id: id,
      status: result.status,
      signature: result.signature,
      category: result.diagnosis?.category ?? null,
      confidence: result.diagnosis?.confidence ?? null,
      summary: result.diagnosis?.summary ?? null,
      root_cause: result.diagnosis?.root_cause ?? null,
      verified_evidence: result.diagnosis?.evidence ?? [],
      dropped_claims: result.diagnosis?.dropped.length ?? 0,
      history: result.memory ? { label: result.memory.label, failed: result.memory.failed, passed: result.memory.passed } : null,
      patch_proposed: Boolean(result.patch),
      patch_applies: result.patch?.applies ?? null,
      warnings: result.warnings,
    };
    return { ...text(JSON.stringify(brief, null, 2)), structuredContent: brief };
  }

  function lookup(args) {
    const r = cache.get(String(args.triage_id ?? ''));
    if (!r) throw new ToolError('unknown triage_id, run triage_log first');
    return r;
  }

  async function callTool(name, args) {
    if (!args || typeof args !== 'object' || Array.isArray(args)) throw new ToolError('arguments must be an object');
    const tool = TOOLS.find((t) => t.name === name);
    if (!tool) throw new ToolError(`unknown tool ${String(name).slice(0, 60)}`);
    for (const k of Object.keys(args)) if (!(k in tool.inputSchema.properties)) throw new ToolError(`unknown argument "${k.slice(0, 40)}"`);
    if (name === 'triage_log') return triageTool(args);
    const r = lookup(args);
    if (name === 'get_report') {
      if (args.format === 'json') return text(JSON.stringify(r, null, 2));
      return text(renderMarkdown(r));
    }
    if (!r.patch) return text('No patch was proposed for this triage.');
    const info = { applies: r.patch.applies, reason: r.patch.reason, files: r.patch.files, sensitive_files: r.patch.sensitive, patch: r.patch.patch };
    return { ...text(`${r.patch.applies ? 'The patch applies cleanly.' : `The patch does not apply: ${r.patch.reason}`}\n\n${r.patch.patch}`), structuredContent: info };
  }

  return async function handle(msg) {
    if (!msg || typeof msg !== 'object' || Array.isArray(msg) || msg.jsonrpc !== '2.0' || typeof msg.method !== 'string') {
      return { jsonrpc: '2.0', id: msg?.id ?? null, error: { code: -32600, message: 'invalid request' } };
    }
    const isNotification = !('id' in msg);
    const reply = (result) => (isNotification ? null : { jsonrpc: '2.0', id: msg.id, result });
    const fail = (code, message) => (isNotification ? null : { jsonrpc: '2.0', id: msg.id, error: { code, message } });
    switch (msg.method) {
      case 'initialize': {
        const asked = msg.params?.protocolVersion;
        return reply({
          protocolVersion: PROTOCOL_VERSIONS.includes(asked) ? asked : PROTOCOL_VERSIONS[0],
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: 'ci-medic', version: VERSION },
          instructions: 'Triage failed CI logs. The tools read logs and the repository and return a verified diagnosis and a proposed patch. They never run commands or change files.',
        });
      }
      case 'notifications/initialized':
      case 'notifications/cancelled':
        return null;
      case 'ping':
        return reply({});
      case 'tools/list':
        return reply({ tools: TOOLS });
      case 'tools/call':
        try {
          return reply(await callTool(msg.params?.name, msg.params?.arguments ?? {}));
        } catch (err) {
          const message = err instanceof ToolError ? err.message : `triage failed: ${err.message}`;
          return reply({ content: [{ type: 'text', text: message }], isError: true });
        }
      default:
        return fail(-32601, `method not found: ${msg.method.slice(0, 60)}`);
    }
  };
}

/** Run the server on stdin and stdout until stdin closes. */
export function startMcpServer({ input = process.stdin, output = process.stdout, stderr = (s) => process.stderr.write(s), ...deps } = {}) {
  const handle = createMcpHandler(deps);
  const rl = readline.createInterface({ input, crlfDelay: Infinity });
  let chain = Promise.resolve();
  rl.on('line', (line) => {
    if (!line.trim()) return;
    chain = chain.then(async () => {
      let msg;
      try {
        msg = JSON.parse(line);
      } catch {
        output.write(`${JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'parse error' } })}\n`);
        return;
      }
      try {
        const res = await handle(msg);
        if (res) output.write(`${JSON.stringify(res)}\n`);
      } catch (err) {
        stderr(`ci-medic mcp: ${err.message}\n`);
      }
    });
  });
  return new Promise((resolve) => rl.on('close', () => chain.then(resolve)));
}
