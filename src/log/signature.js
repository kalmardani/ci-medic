// Failure signature. Two failures with the same signature are treated as the
// same failure by the flaky memory. Volatile parts (numbers, hashes, ids,
// directory prefixes) are removed before hashing.
import { createHash } from 'node:crypto';

export function normalizeForSignature(text) {
  return String(text ?? '')
    .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, '<uuid>')
    .replace(/\b[0-9a-f]{7,64}\b/gi, (m) => (/\d/.test(m) ? '<hex>' : m))
    .replace(/(?:[A-Za-z]:)?(?:[\\/][\w.@+-]+)+[\\/]/g, '')
    .replace(/\d+(?:\.\d+)?/g, '<n>')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

/**
 * @param {ReturnType<import('./reduce.js').reduceLog>} reduced
 * @param {string[]} lines normalised lines, used only when no error was recognised
 * @returns {string} 16 lowercase hex chars
 */
export function failureSignature(reduced, lines = []) {
  const parts = [];
  if (reduced.headline) parts.push(normalizeForSignature(reduced.headline.text));
  else if (reduced.firstError) parts.push(normalizeForSignature(reduced.firstError.text));
  const tests = reduced.failingTests.map((t) => normalizeForSignature(t.name)).sort();
  parts.push(...tests);
  if (parts.length === 0) {
    const tail = lines.filter((l) => l.trim()).slice(-5);
    parts.push(...tail.map(normalizeForSignature));
  }
  return createHash('sha256').update(parts.join('\n')).digest('hex').slice(0, 16);
}
