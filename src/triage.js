// The triage pipeline. Steps run in a fixed order chosen by code; the model is
// one step that proposes, and code checks and acts. There is no agent loop.
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { normalizeLog, reduceLog } from './log/reduce.js';
import { failureSignature } from './log/signature.js';
import { createGit, GitError } from './git.js';
import { gatherEvidence } from './evidence.js';
import { buildPrompt, extractJson, PROMPT_VERSION } from './model/prompt.js';
import { validateTriage } from './analysis/schema.js';
import { verifyClaims } from './analysis/claims.js';
import { checkPatch } from './patch/policy.js';
import { decideVerify, decideApply } from './patch/decide.js';
import { checkApplies, verifyInWorktree, applyToWorkingTree } from './patch/verify.js';
import { openMemory } from './memory/store.js';
import { defaultRunner, recordingRunner } from './proc.js';

export const VERSION = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version;

export class InputError extends Error {
  constructor(message) {
    super(message);
    this.name = 'InputError';
  }
}

function commandSummary(calls) {
  return calls.map((c) => ({
    cmd: path.basename(c.cmd),
    args: c.args
      .filter((a, i, all) => a !== '-c' && all[i - 1] !== '-c' && a !== '--no-pager')
      .slice(0, 6)
      .map((a) => (a.length > 80 ? `${a.slice(0, 80)}...` : a)),
  }));
}

/**
 * @param {object} opts
 * @param {string} opts.logText
 * @param {{kind: string, path?: string, github?: object}} opts.source
 * @param {string} opts.repoDir
 * @param {string[]|null} [opts.verifyArgv] parsed --verify command
 * @param {string|null} [opts.verifyCommand] the original string, for the report
 * @param {number} [opts.verifyTimeoutMs]
 * @param {boolean} [opts.apply]
 * @param {boolean} [opts.yes]
 * @param {{enabled: boolean, file?: string|null}} [opts.memory]
 * @param {(question: string) => Promise<boolean>} [opts.confirm]
 * @param {object} deps
 * @param {object|null} deps.provider adapter from createProvider, or null for no model
 * @param {{run: Function}} [deps.runner]
 * @param {(msg: string) => void} [deps.progress]
 */
export async function triage(opts, deps = {}) {
  const runner = recordingRunner(deps.runner ?? defaultRunner);
  const progress = deps.progress ?? (() => {});
  const provider = deps.provider ?? null;
  const warnings = [];

  const lines = normalizeLog(opts.logText);
  if (lines.length === 0) throw new InputError('the log is empty');
  const reduced = reduceLog(lines);
  const signature = failureSignature(reduced, lines);
  progress(`log reduced: ${lines.length} lines to ${reduced.view.length} characters, signature ${signature}`);

  const git = createGit(opts.repoDir, { runner });
  let root;
  try {
    root = await git.root();
  } catch (err) {
    if (err instanceof GitError) throw new InputError(`${opts.repoDir} is not inside a git checkout (${err.message})`);
    throw err;
  }

  const gh = opts.source?.github;
  if (gh?.headSha) {
    const head = await git.head();
    if (head && head !== gh.headSha) {
      const present = await git.hasCommit(gh.headSha);
      warnings.push(
        `The local HEAD ${head.slice(0, 12)} is not the commit of the run ${gh.headSha.slice(0, 12)}${present ? '' : ', and that commit is not in the local clone'}. Evidence comes from the local checkout.`,
      );
    }
  }

  let store = null;
  let before = null;
  if (opts.memory?.enabled !== false) {
    const file = opts.memory?.file ?? path.join(await git.commonDir(), 'ci-medic', 'memory.sqlite');
    store = await openMemory(file);
    if (!store) warnings.push('Flaky memory is off because node:sqlite is not available in this Node.js (it needs Node 22.13 or newer, or --experimental-sqlite).');
    else before = store.lookup(signature);
  }

  const evidence = await gatherEvidence({ git, root, reduced });
  progress(`evidence: ${evidence.paths.length} file(s) matched, ${evidence.unmapped.length} path(s) not found`);

  let status = 'no_model';
  let diagnosis = null;
  let patch = null;
  let modelError = null;
  const calls = [];

  const evaluatePatch = async (raw) => {
    if (!raw) return null;
    const policy = checkPatch(raw);
    if (!policy.ok) return { patch: raw, applies: false, reason: policy.errors.join('; '), files: policy.files, sensitive: policy.sensitive };
    const check = await checkApplies(git, policy.patch);
    return {
      patch: policy.patch,
      applies: check.ok,
      reason: check.ok ? null : `git apply --check failed: ${check.message.split('\n')[0]}`,
      files: policy.files,
      sensitive: policy.sensitive,
    };
  };

  if (provider) {
    const prompt = buildPrompt({ reduced, evidence, memory: before ? { failed: before.failed, passed: before.passed } : null, signature });
    const callOnce = async (user) => {
      const t0 = Date.now();
      const rec = { latencyMs: 0, inputTokens: null, outputTokens: null, costUsd: null, model: provider.model, valid: false, errors: [] };
      calls.push(rec);
      let res;
      try {
        res = await provider.complete({ system: prompt.system, user });
      } catch (err) {
        rec.latencyMs = Date.now() - t0;
        rec.errors = [err.message];
        return { valid: false, fatal: true, errors: [err.message], text: '' };
      }
      rec.latencyMs = Date.now() - t0;
      rec.inputTokens = res.usage?.inputTokens ?? null;
      rec.outputTokens = res.usage?.outputTokens ?? null;
      rec.costUsd = res.usage?.costUsd ?? null;
      rec.model = res.model ?? provider.model;
      const parsed = extractJson(res.text);
      if (!parsed.ok) {
        rec.errors = [parsed.error];
        return { valid: false, errors: [parsed.error], text: res.text };
      }
      const checked = validateTriage(parsed.value);
      if (!checked.ok) {
        rec.errors = checked.errors;
        return { valid: false, errors: checked.errors, text: res.text };
      }
      rec.valid = true;
      return { valid: true, value: checked.value, text: res.text };
    };
    const repair = (prev, problem) =>
      `${prompt.user}\n\nYour previous answer was rejected by the program.\nProblem: ${problem}\nPrevious answer (first 4000 characters):\n${String(prev.text).slice(0, 4000)}\n\nReturn one corrected JSON object only.`;

    progress(`asking ${provider.name} (${provider.model})`);
    let candidate = await callOnce(prompt.user);
    if (!candidate.valid && !candidate.fatal) {
      progress('model answer invalid, one repair round');
      candidate = await callOnce(repair(candidate, candidate.errors.join('; ')));
    }
    if (!candidate.valid) {
      status = 'model_failed';
      modelError = candidate.errors.slice(0, 3).join('; ');
    } else {
      patch = await evaluatePatch(candidate.value.patch);
      if (patch && !patch.applies && calls.length < 2) {
        progress('patch rejected, one repair round');
        const second = await callOnce(repair(candidate, `the patch was rejected: ${patch.reason}`));
        if (second.valid) {
          candidate = second;
          patch = await evaluatePatch(second.value.patch);
        }
      }
      const claims = verifyClaims(candidate.value, lines);
      status = claims.status;
      diagnosis = {
        category: candidate.value.category,
        confidence: claims.confidence,
        modelConfidence: candidate.value.confidence,
        summary: candidate.value.summary,
        root_cause: candidate.value.root_cause,
        evidence: claims.verified,
        dropped: claims.dropped,
        suggested_fix: candidate.value.suggested_fix,
      };
    }
  }

  let memory = null;
  if (store) {
    const source = gh ? `github:${gh.owner}/${gh.repo}:${gh.runId}:${gh.attempt}` : `log:${createHash('sha256').update(opts.logText).digest('hex').slice(0, 16)}`;
    const headline = (reduced.headline ?? reduced.firstError)?.text ?? lines[lines.length - 1];
    let after = store.record(signature, { headline, category: diagnosis?.category ?? null, outcome: 'failed', source });
    if (gh?.passedOnRerun) after = store.record(signature, { headline, outcome: 'passed', source: `${source}:rerun` });
    memory = { failed: after.failed, passed: after.passed, label: after.label, firstSeen: after.firstSeen, file: store.file };
    store.close();
    if (memory.label === 'likely_flaky' && diagnosis && diagnosis.category !== 'flaky') {
      warnings.push('This failure signature failed before and later passed, which points to a flaky test even though the model chose another category.');
    }
  }

  if (patch && evidence.dirty.length && patch.files.some((f) => evidence.dirty.includes(f))) {
    warnings.push('Some patched files have uncommitted changes. Verification runs on HEAD in a clean worktree, not on those changes.');
  }

  // Patch actions, decision table "patch actions" in DEVELOPER.md.
  if (patch) {
    const wantsVerify = Boolean(opts.verifyArgv);
    const sensitive = patch.sensitive.length > 0;
    let confirmVerify = Boolean(opts.yes);
    if (patch.applies && wantsVerify && sensitive && !confirmVerify && opts.confirm) {
      confirmVerify = await opts.confirm(`The patch touches ${patch.sensitive.join(', ')}. Run "${opts.verifyCommand}" on it in a temporary worktree?`);
    }
    const v = decideVerify({ applies: patch.applies, sensitive, verify: wantsVerify, confirmVerify });
    if (v.runVerify) {
      progress(`verifying with: ${opts.verifyCommand}`);
      const res = await verifyInWorktree({ git, patch: patch.patch, argv: opts.verifyArgv, timeoutMs: opts.verifyTimeoutMs ?? 600_000, runner });
      patch.verify = { ...res, command: opts.verifyCommand, row: v.row };
    } else if (wantsVerify) {
      patch.verify = { result: 'skipped', message: v.reason, command: opts.verifyCommand, row: v.row, ms: 0 };
    }

    if (opts.apply) {
      const c = { applies: patch.applies, verify: wantsVerify, apply: true, verifyResult: patch.verify?.result ?? null };
      let decision = decideApply({ ...c, confirmApply: true });
      if (decision.doApply) {
        const confirmed = Boolean(opts.yes) || (opts.confirm ? await opts.confirm(`Apply the patch to the working tree in ${root}?`) : false);
        decision = decideApply({ ...c, confirmApply: confirmed });
      }
      if (decision.doApply) {
        const r = await applyToWorkingTree(git, patch.patch);
        patch.applied = { ok: r.ok, reason: r.ok ? decision.reason : r.message, row: decision.row };
      } else {
        patch.applied = { ok: false, reason: decision.reason, row: decision.row };
      }
    }
  } else if (opts.apply || opts.verifyArgv) {
    warnings.push('No patch was proposed, so there was nothing to verify or apply.');
  }

  return {
    version: VERSION,
    promptVersion: PROMPT_VERSION,
    status,
    signature,
    source: { kind: opts.source?.kind ?? 'text', path: opts.source?.path ?? null, github: gh ?? null },
    reduction: {
      totalLines: reduced.totalLines,
      step: reduced.step,
      firstError: reduced.firstError,
      headline: reduced.headline,
      errorCount: reduced.errors.length,
      failingTests: reduced.failingTests,
      locations: reduced.locations.slice(0, 20),
      viewChars: reduced.view.length,
    },
    evidence: {
      paths: evidence.paths,
      unmapped: evidence.unmapped,
      dirty: evidence.dirty,
      warnings: evidence.warnings,
      historyChars: evidence.history.length,
    },
    diagnosis,
    patch,
    memory,
    model: provider ? { provider: provider.name, model: calls.find((c) => c.valid)?.model ?? provider.model, calls } : null,
    modelError,
    warnings,
    commands: commandSummary(runner.calls),
    view: deps.includeView ? reduced.view : undefined,
  };
}
