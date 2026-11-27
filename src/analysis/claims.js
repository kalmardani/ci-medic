// Deterministic claim check. Every quote the model gives must appear in the
// normalised log, otherwise it is dropped. The status follows the decision
// table "diagnosis status" in DEVELOPER.md.

const MIN_QUOTE = 6;
export const UNSUPPORTED_CAP = 0.2;

export function normalizeQuote(q) {
  return String(q ?? '')
    .replace(/^\s*L\d+:?\s+/, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * @param {{evidence: {quote:string, explains:string}[], confidence:number}} triage
 * @param {string[]} lines normalised log lines
 */
export function verifyClaims(triage, lines) {
  const haystack = lines.map((l) => l.replace(/\s+/g, ' ').trim());
  const verified = [];
  const dropped = [];
  for (const ev of triage.evidence) {
    const q = normalizeQuote(ev.quote);
    if (q.replace(/\s/g, '').length < MIN_QUOTE) {
      dropped.push({ quote: ev.quote, reason: 'too short to verify' });
      continue;
    }
    const idx = haystack.findIndex((l) => l.includes(q));
    if (idx === -1) dropped.push({ quote: ev.quote, reason: 'not found in the log' });
    else verified.push({ quote: q, explains: ev.explains, line: idx + 1 });
  }
  let status;
  let confidence = triage.confidence;
  if (verified.length === 0) {
    status = 'unsupported';
    confidence = Math.min(confidence, UNSUPPORTED_CAP);
  } else if (dropped.length > 0) status = 'partially_supported';
  else status = 'supported';
  return { verified, dropped, status, confidence };
}
