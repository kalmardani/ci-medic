// Markdown report for a PR comment. Every untrusted string passes through
// mdText or mdFence; only fixed labels are written raw.
import { mdText, mdFence } from './sanitize.js';

const CATEGORY_LABEL = {
  test_failure: 'test failure',
  regression: 'regression',
  flaky: 'flaky',
  dependency: 'dependency',
  infrastructure: 'infrastructure',
  configuration: 'configuration',
  unknown: 'unknown',
};

const HISTORY_LABEL = {
  likely_flaky: 'likely flaky (failed before, and passed later)',
  recurring: 'recurring (failed before, never recorded as passing)',
  passed_before: 'recorded as passing before',
  new: 'first time seen',
};

const code = (s) => `\`${String(s).replace(/`/g, '')}\``;

export function renderMarkdown(r) {
  const out = [];
  out.push('### ci-medic triage');
  out.push('');
  const d = r.diagnosis;
  const facts = [];
  if (d) {
    facts.push(`**Category** ${CATEGORY_LABEL[d.category] ?? 'unknown'}`);
    facts.push(`**Confidence** ${d.confidence.toFixed(2)}`);
  }
  facts.push(`**Signature** ${code(r.signature)}`);
  if (r.memory) facts.push(`**History** ${HISTORY_LABEL[r.memory.label]}, failed ${r.memory.failed}, passed ${r.memory.passed}`);
  out.push(facts.join(' | '));
  out.push('');

  if (r.source?.github) {
    const g = r.source.github;
    out.push(`Run ${mdText(`${g.owner}/${g.repo}`)} ${g.runId}, attempt ${g.attempt}${g.passedOnRerun ? ', a later attempt of this run passed' : ''}.`);
    out.push('');
  }
  for (const w of r.warnings ?? []) {
    out.push(`> ${mdText(w)}`);
    out.push('');
  }

  if (r.status === 'model_failed') {
    out.push(`The model did not return a valid answer (${mdText(r.modelError ?? 'unknown error')}). Only the deterministic findings below are reported.`);
    out.push('');
  } else if (r.status === 'no_model') {
    out.push('No model was used. Only the deterministic findings below are reported.');
    out.push('');
  }

  if (d) {
    out.push(`**Summary.** ${mdText(d.summary)}`);
    out.push('');
    if (r.status === 'unsupported') {
      out.push('No quoted log line could be found in the log, so this diagnosis is unsupported and its confidence was capped.');
      out.push('');
    }
    out.push('**Root cause**');
    out.push('');
    out.push(mdText(d.root_cause));
    out.push('');
    if (d.evidence.length) {
      out.push('**Evidence from the log** (each line checked against the log)');
      out.push('');
      for (const e of d.evidence) {
        out.push(mdFence(`L${e.line}: ${e.quote}`));
        if (e.explains) out.push(mdText(e.explains));
        out.push('');
      }
    }
    if (d.dropped.length) {
      out.push(`${d.dropped.length} quoted line(s) did not appear in the log and were removed.`);
      out.push('');
    }
    if (d.suggested_fix) {
      out.push('**Suggested fix**');
      out.push('');
      out.push(mdText(d.suggested_fix));
      out.push('');
    }
  }

  if (r.patch) {
    const p = r.patch;
    out.push('**Proposed patch**');
    out.push('');
    const lines = [];
    lines.push(p.applies ? 'Applies cleanly to the checkout (`git apply --check`).' : `Does not apply, ${mdText(p.reason ?? 'unknown reason')}.`);
    if (p.sensitive.length) lines.push(`Touches files that control builds or dependencies ${p.sensitive.map(code).join(', ')}.`);
    if (p.verify) {
      const v = p.verify;
      if (v.result === 'pass') lines.push(`Verified in a temporary worktree with ${code(v.command)}, passed in ${(v.ms / 1000).toFixed(1)} s.`);
      else if (v.result === 'fail') lines.push(`Verified in a temporary worktree with ${code(v.command)}, failed (${mdText(v.message)}).`);
      else if (v.result === 'skipped') lines.push(`Verification skipped, ${mdText(v.message)}.`);
      else lines.push(`Verification could not run, ${mdText(v.message)}.`);
    }
    if (p.applied) lines.push(p.applied.ok ? 'Applied to the working tree.' : `Not applied to the working tree, ${mdText(p.applied.reason)}.`);
    out.push(lines.join(' '));
    out.push('');
    if (p.applies) out.push(mdFence(p.patch, 'diff'));
    else {
      out.push('<details><summary>Rejected patch</summary>');
      out.push('');
      out.push(mdFence(p.patch, 'diff'));
      out.push('');
      out.push('</details>');
    }
    out.push('');
  }

  out.push('<details><summary>Deterministic findings</summary>');
  out.push('');
  const red = r.reduction;
  if (red.step) out.push(`- Step ${mdText(red.step)}`);
  if (red.firstError) out.push(`- First error at log line ${red.firstError.line}`);
  if (red.failingTests.length) out.push(`- Failing tests ${red.failingTests.slice(0, 10).map((t) => mdText(t.name)).join(', ')}`);
  if (r.evidence?.paths?.length) out.push(`- Files matched in the repository ${r.evidence.paths.map(code).join(', ')}`);
  if (r.evidence?.unmapped?.length) out.push(`- Paths from the log not found in the repository ${r.evidence.unmapped.length}`);
  out.push(`- Log lines ${red.totalLines}, reduced view ${red.viewChars} characters`);
  const head = red.headline ?? red.firstError;
  if (head) {
    out.push('');
    out.push(mdFence(`L${head.line}: ${head.text}`));
  }
  out.push('');
  out.push('</details>');
  out.push('');
  const model = r.model ? `${r.model.provider} ${r.model.model}` : 'no model';
  out.push(
    `<sub>ci-medic ${r.version}, ${mdText(model)}, prompt ${r.promptVersion}. The diagnosis comes from a language model and is checked by code where possible. Review it before merging.</sub>`,
  );
  return `${out.join('\n')}\n`;
}
