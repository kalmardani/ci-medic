// Hand written check for the model's triage object. Unknown keys are rejected
// at every level, so an injected field (a command, a URL to fetch) can never
// reach code that might act on it.

export const CATEGORIES = ['test_failure', 'regression', 'flaky', 'dependency', 'infrastructure', 'configuration', 'unknown'];
const TOP_KEYS = ['category', 'confidence', 'summary', 'root_cause', 'evidence', 'suggested_fix', 'patch'];
const EV_KEYS = ['quote', 'explains'];

function str(errors, where, v, min, max) {
  if (typeof v !== 'string') errors.push(`${where}: must be a string`);
  else if (v.length < min) errors.push(`${where}: must not be empty`);
  else if (v.length > max) errors.push(`${where}: longer than ${max} characters`);
}

function keys(errors, where, obj, allowed) {
  for (const k of Object.keys(obj)) if (!allowed.includes(k)) errors.push(`${where}: unknown key "${String(k).slice(0, 40)}"`);
  for (const k of allowed) if (!(k in obj)) errors.push(`${where}: missing key "${k}"`);
}

/**
 * @param {unknown} value parsed JSON
 * @returns {{ok: true, value: object} | {ok: false, errors: string[]}}
 */
export function validateTriage(value) {
  const errors = [];
  if (!value || typeof value !== 'object' || Array.isArray(value)) return { ok: false, errors: ['root: must be a JSON object'] };
  keys(errors, 'root', value, TOP_KEYS);
  if (!CATEGORIES.includes(value.category)) errors.push(`category: must be one of ${CATEGORIES.join(', ')}`);
  if (typeof value.confidence !== 'number' || !Number.isFinite(value.confidence) || value.confidence < 0 || value.confidence > 1) {
    errors.push('confidence: must be a number from 0 to 1');
  }
  str(errors, 'summary', value.summary, 1, 200);
  str(errors, 'root_cause', value.root_cause, 1, 3000);
  if ('suggested_fix' in value) str(errors, 'suggested_fix', value.suggested_fix, 0, 2000);
  if (!Array.isArray(value.evidence)) errors.push('evidence: must be an array');
  else {
    if (value.evidence.length > 12) errors.push('evidence: at most 12 items');
    value.evidence.slice(0, 12).forEach((e, i) => {
      if (!e || typeof e !== 'object' || Array.isArray(e)) {
        errors.push(`evidence[${i}]: must be an object`);
        return;
      }
      keys(errors, `evidence[${i}]`, e, EV_KEYS);
      str(errors, `evidence[${i}].quote`, e.quote, 1, 500);
      str(errors, `evidence[${i}].explains`, e.explains, 0, 300);
    });
  }
  if (value.patch !== null && value.patch !== undefined) {
    str(errors, 'patch', value.patch, 1, 60_000);
    if (typeof value.patch === 'string' && !/^(?:diff --git |--- )/m.test(value.patch)) errors.push('patch: must be a unified diff or null');
  }
  if (errors.length) return { ok: false, errors: errors.slice(0, 20) };
  return {
    ok: true,
    value: {
      category: value.category,
      confidence: value.confidence,
      summary: value.summary,
      root_cause: value.root_cause,
      evidence: value.evidence.map((e) => ({ quote: e.quote, explains: e.explains })),
      suggested_fix: value.suggested_fix,
      patch: value.patch ?? null,
    },
  };
}
