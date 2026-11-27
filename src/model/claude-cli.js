// Subscription adapter through the official `claude` CLI. The CLI runs with no
// tools, no MCP servers, no saved session, in an empty temp directory, and the
// prompt goes in on stdin. ci-medic never touches the CLI's stored credentials.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { defaultRunner } from '../proc.js';
import { claudeBin, INSTALL_HINT } from '../auth/subscription.js';

const TRANSIENT = /overloaded|rate.?limit|\b429\b|\b5\d\d\b|timed? ?out|ECONNRESET|network/i;

export function createClaudeCliAdapter({ model, timeoutMs, runner = defaultRunner, env = process.env, sleep }) {
  const wait = sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  return {
    name: 'claude-cli',
    model: model ?? 'cli default',
    async complete({ system, user }) {
      const args = ['-p', '--output-format', 'json', '--tools', '', '--strict-mcp-config', '--no-session-persistence', '--system-prompt', system];
      if (model) args.push('--model', model);
      if (env.CI_MEDIC_MAX_BUDGET_USD) args.push('--max-budget-usd', String(env.CI_MEDIC_MAX_BUDGET_USD));
      const childEnv = { ...env };
      delete childEnv.GITHUB_TOKEN;
      let lastErr;
      for (let attempt = 0; attempt < 3; attempt++) {
        const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'ci-medic-claude-'));
        let r;
        try {
          r = await runner.run(claudeBin(env), args, { cwd, input: user, timeoutMs, env: childEnv });
        } catch (err) {
          if (err.code === 'ENOENT' || err.code === 'EINVAL') throw new Error(`claude CLI could not be started. ${INSTALL_HINT.claude}`);
          throw err;
        } finally {
          fs.rmSync(cwd, { recursive: true, force: true });
        }
        let data = null;
        try {
          data = JSON.parse(r.stdout);
        } catch {}
        if (r.code === 0 && data && data.is_error !== true && typeof data.result === 'string') {
          const models = data.modelUsage && typeof data.modelUsage === 'object' ? Object.keys(data.modelUsage) : [];
          return {
            text: data.result,
            model: models[0] ?? model ?? 'cli default',
            usage: {
              inputTokens: sumTokens(data.usage),
              outputTokens: data.usage?.output_tokens ?? null,
              costUsd: typeof data.total_cost_usd === 'number' ? data.total_cost_usd : null,
            },
            truncated: false,
          };
        }
        const detail = r.timedOut ? 'timed out' : `${data?.result ?? ''} ${r.stderr}`.trim().slice(0, 300) || `exit code ${r.code}`;
        lastErr = new Error(`claude CLI call failed: ${detail}`);
        if (/not logged in|login|authenticat/i.test(detail)) {
          throw new Error('claude CLI is not signed in. Run "ci-medic auth login claude"');
        }
        if (!TRANSIENT.test(detail) || attempt === 2) break;
        await wait(1000 * 2 ** attempt);
      }
      throw lastErr;
    },
  };
}

function sumTokens(u) {
  if (!u || typeof u !== 'object') return null;
  const parts = [u.input_tokens, u.cache_creation_input_tokens, u.cache_read_input_tokens].filter((n) => typeof n === 'number');
  return parts.length ? parts.reduce((a, b) => a + b, 0) : null;
}
