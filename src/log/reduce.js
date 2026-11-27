// Deterministic log reduction. The model only ever sees the `view` built here.
// Every regex below is linear (no nested quantifiers over overlapping classes)
// and runs on lines already capped at MAX_LINE chars.

export const MAX_LINE = 4000;
const VIEW_LINE = 400;
export const VIEW_BUDGET = 12_000;

const ANSI = /\x1b\[[0-?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[@-Z\\-_]/g;
const CONTROL = /[\x00-\x08\x0b-\x1f\x7f]/g;
const BIDI = /[‪-‮⁦-⁩‎‏﻿]/g;
const TS_ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z ?/;
const TS_BRACKET = /^\[\d{2}:\d{2}:\d{2}(?:\.\d+)?\] ?/;

/**
 * Normalise raw log text into clean lines. CRLF and lone CR (progress bars) are
 * handled, ANSI escapes, control and bidi characters and timestamps removed.
 * @param {string} raw
 * @returns {string[]} lines, index 0 is log line 1
 */
export function normalizeLog(raw) {
  const text = String(raw ?? '').replace(/\r\n/g, '\n');
  const out = [];
  for (let line of text.split('\n')) {
    if (line.includes('\r')) {
      const parts = line.split('\r').filter((p) => p.length > 0);
      line = parts.length ? parts[parts.length - 1] : '';
    }
    if (line.length > MAX_LINE * 2) line = line.slice(0, MAX_LINE * 2);
    line = line.replace(ANSI, '').replace(BIDI, '').replace(CONTROL, '');
    line = line.replace(TS_ISO, '').replace(TS_BRACKET, '');
    if (line.length > MAX_LINE) line = line.slice(0, MAX_LINE);
    out.push(line.replace(/\s+$/, ''));
  }
  while (out.length && out[out.length - 1] === '') out.pop();
  return out;
}

const NEGATIVE = [
  /\b0 (?:errors?|failures?|failed|failing)\b/i,
  /\b(?:errors?|failures?|failed|fail):? 0\b/i,
  /\bno errors?\b/i,
  /^\s*(?:✔|✓|ok \d+\b)/,
];

// Lines that report that something already failed. They are never the first real error.
const CONSEQUENCE = [
  /Process completed with exit code \d+/i,
  /^npm (?:ERR!|error) (?:code|errno|path|command|syscall|signal|workspace|location)\b/i,
  /^npm (?:ERR!|error) (?:A complete log|Lifecycle script|Error: command failed|This is probably not a problem)/i,
  /^npm (?:ERR!|error)\s*$/i,
  /^error Command failed with exit code/i,
  /^ELIFECYCLE\b/,
  /^make(?:\[\d+\])?: \*\*\*/,
  /^Error: The operation was canceled/i,
  /^##\[error\]The operation was canceled/i,
  /^FAIL\s*$/,
  /^exit status \d+$/,
  /^(?:✖|✗|×) failing tests:?\s*$/,
  /^\s*(?:ℹ|#) (?:fail|failed) \d+/,
];

const ERROR = [
  /^##\[error\]/,
  /^::error\b/,
  /^\s*(?:✖|✗|✕|×)\s+\S/,
  /^\s*not ok \d+/,
  /^\s*●\s+\S/,
  /^\s*(?:FAIL|FAILED)\s+\S/,
  /^--- FAIL: /,
  /^test \S+ \.\.\. FAILED$/,
  /^\s*Traceback \(most recent call last\)/,
  /^\s*(?:[A-Za-z_$][\w$.]*)?(?:Error|Exception)(?: \[[A-Z_0-9]+\])?:/,
  /^\s*E\s{2,}\S/,
  /^\S+\(\d+,\d+\): error [A-Z]+\d+:/,
  /^\S+:\d+(?::\d+)?: (?:fatal )?error:/,
  /^error(?:\[E\d{4}\])?: /,
  /^(?:ERROR|\[ERROR\]):? /,
  /^npm (?:ERR!|error) /,
  /^(?:panic|fatal): /,
  /^FATAL\b/,
  /^thread '.+' panicked at/,
];

// Lines that carry the actual message, preferred as the headline.
const MESSAGE = [
  /^\s*(?:[A-Za-z_$][\w$.]*)?(?:Error|Exception)(?: \[[A-Z_0-9]+\])?:/,
  /^\s*E\s{2,}\S/,
  /^\S+\(\d+,\d+\): error [A-Z]+\d+:/,
  /^\S+:\d+(?::\d+)?: (?:fatal )?error:/,
  /^error(?:\[E\d{4}\])?: /,
  /^(?:ERROR|\[ERROR\]):? /,
  /^(?:panic|fatal): /,
  /^##\[error\]/,
  /^thread '.+' panicked at/,
  /\b(?:ECONNREFUSED|ECONNRESET|ETIMEDOUT|ENOTFOUND|EADDRINUSE|EACCES|EAI_AGAIN)\b/,
];

const TESTS = [
  /^\s*(?:✖|✗|✕|×)\s+(.+?)(?:\s+\(\d+(?:\.\d+)?\s?m?s\))?\s*$/,
  /^\s*not ok \d+ - (.+?)\s*(?:#.*)?$/,
  /^\s*●\s+(.+?)\s*$/,
  /^FAILED\s+(\S+::\S+)/,
  /^--- FAIL: (\S+)/,
  /^\[ERROR\]\s+(\S+)\s+Time elapsed.*<<< (?:FAILURE|ERROR)!/,
  /^rspec (\.\/\S+:\d+)/,
  /^test (\S+) \.\.\. FAILED$/,
];

const NOT_A_TEST = /^(?:failing tests:?|Test suite failed to run)$/i;

const LOCATIONS = [
  { re: /File "([^"]+)", line (\d+)/g, p: 1, l: 2, c: 0 },
  { re: /::error file=([^,]+),line=(\d+)(?:,col=(\d+))?/g, p: 1, l: 2, c: 3 },
  { re: /((?:[A-Za-z]:[\\/]|[\\/]|\.{1,2}[\\/])?(?:[\w@.+-]+[\\/])*[\w@+-][\w@.+-]*\.[A-Za-z][A-Za-z0-9]{0,5})\((\d+),(\d+)\)/g, p: 1, l: 2, c: 3 },
  { re: /((?:[A-Za-z]:[\\/]|[\\/]|\.{1,2}[\\/])?(?:[\w@.+-]+[\\/])*[\w@+-][\w@.+-]*\.[A-Za-z][A-Za-z0-9]{0,5}):(\d+)(?::(\d+))?/g, p: 1, l: 2, c: 3 },
];

const FOREIGN = /node_modules|(?:^|[\\/])internal[\\/]|site-packages|dist-packages|^[\\/]usr[\\/]|<anonymous>|^node:/;
const FRAME = /^\s+(?:at\s|File ")|^\s+\S+\.go:\d+/;

const any = (list, s) => list.some((re) => re.test(s));

/** A stack frame whose location is inside a runtime or a dependency. */
export function isInternalFrame(s) {
  if (!FRAME.test(s)) return false;
  const t = s.trim().replace(/^at\s+/, '');
  const open = t.lastIndexOf('(');
  const where = open !== -1 ? t.slice(open + 1) : t;
  return FOREIGN.test(where) || /^node:/.test(where) || where.startsWith('node:') || /^async node:/.test(t);
}

export function isErrorLine(s) {
  return any(ERROR, s) && !any(NEGATIVE, s) && !any(CONSEQUENCE, s);
}

/** Extract file locations from one line. */
export function extractLocations(text) {
  const found = [];
  const clean = text.replace(/file:\/\/(?=\/)/g, '');
  const seen = new Set();
  for (const { re, p, l, c } of LOCATIONS) {
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(clean)) !== null) {
      const file = m[p];
      const line = Number(m[l]);
      const col = c && m[c] ? Number(m[c]) : null;
      const start = m.index;
      const tokenStart = clean.lastIndexOf(' ', start) + 1;
      const token = clean.slice(tokenStart, start + m[0].length);
      if (token.includes('://')) continue;
      const before = clean.slice(Math.max(0, start - 5), start);
      if (before.endsWith('node:')) continue;
      if (FOREIGN.test(file)) continue;
      if (!(line > 0 && line < 10_000_000)) continue;
      const key = `${file}:${line}`;
      if (seen.has(key)) continue;
      seen.add(key);
      found.push({ path: file, line, col });
    }
  }
  return found;
}

/**
 * Reduce normalised lines to the parts that explain the failure.
 * @param {string[]} lines from normalizeLog
 */
export function reduceLog(lines, { budget = VIEW_BUDGET } = {}) {
  const total = lines.length;
  const steps = new Array(total);
  let step = null;
  const errors = [];
  const failingTests = [];
  const testSeen = new Set();
  const locations = [];
  const locSeen = new Set();
  let frames = 0;
  let internalFrames = 0;

  for (let i = 0; i < total; i++) {
    const s = lines[i];
    const group = /^##\[group\](.*)$/.exec(s);
    if (group) step = group[1].trim().slice(0, 200);
    steps[i] = step;

    if (FRAME.test(s)) {
      frames++;
      if (isInternalFrame(s)) internalFrames++;
    }

    if (isErrorLine(s)) {
      if (errors.length < 200) errors.push({ line: i + 1, text: s.trim() });
      for (const re of TESTS) {
        const m = re.exec(s);
        if (m) {
          const name = m[1].trim();
          if (!NOT_A_TEST.test(name) && !testSeen.has(name) && failingTests.length < 30) {
            testSeen.add(name);
            failingTests.push({ name, line: i + 1 });
          }
          break;
        }
      }
    }

    if (locations.length < 60 && /\d/.test(s)) {
      for (const loc of extractLocations(s)) {
        const key = `${loc.path}:${loc.line}`;
        if (locSeen.has(key)) continue;
        locSeen.add(key);
        locations.push({ ...loc, logLine: i + 1 });
        if (locations.length >= 60) break;
      }
    }
  }

  const firstError = errors[0] ?? null;
  let headline = firstError;
  if (firstError) {
    const end = Math.min(total, firstError.line + 40);
    for (let i = firstError.line - 1; i < end; i++) {
      if (any(MESSAGE, lines[i]) && !any(NEGATIVE, lines[i]) && !any(CONSEQUENCE, lines[i])) {
        headline = { line: i + 1, text: lines[i].trim() };
        break;
      }
    }
  }

  // Windows in priority order. Line numbers are 1 based and inclusive.
  const windows = [];
  const clampW = (a, b, prio) => windows.push({ a: Math.max(1, a), b: Math.min(total, b), prio });
  if (firstError) {
    clampW(firstError.line - 8, firstError.line + 30, 0);
    if (headline && headline.line > firstError.line + 30) clampW(headline.line - 3, headline.line + 12, 1);
    failingTests.slice(0, 6).forEach((t) => clampW(t.line - 2, t.line + 15, 2));
    errors.slice(1, 12).forEach((e) => clampW(e.line - 1, e.line + 3, 3));
    // Tail: the last 12 non empty lines usually hold the summary and exit code.
    let tailStart = total;
    let nonEmpty = 0;
    while (tailStart > 1 && nonEmpty < 12) {
      tailStart--;
      if (lines[tailStart - 1].trim()) nonEmpty++;
    }
    clampW(tailStart, total, 4);
  } else {
    clampW(total - 79, total, 0);
  }

  const chosen = [];
  let used = 0;
  for (const w of windows.sort((x, y) => x.prio - y.prio)) {
    let cost = 0;
    for (let n = w.a; n <= w.b; n++) cost += Math.min(lines[n - 1].length, VIEW_LINE) + 8;
    if (used + cost <= budget || chosen.length === 0) {
      chosen.push(w);
      used += cost;
    }
  }
  const merged = mergeWindows(chosen);
  const view = renderView(lines, merged, budget, {
    step: firstError ? steps[firstError.line - 1] : null,
    firstError,
    headline,
    failingTests,
    locations,
  });

  return {
    totalLines: total,
    step: firstError ? steps[firstError.line - 1] : null,
    firstError,
    headline,
    errors: errors.slice(0, 30),
    failingTests,
    locations,
    frames,
    internalFrames,
    windows: merged,
    view,
  };
}

export function mergeWindows(ws) {
  const sorted = ws.map((w) => ({ a: w.a, b: w.b })).filter((w) => w.b >= w.a).sort((x, y) => x.a - y.a);
  const out = [];
  for (const w of sorted) {
    const last = out[out.length - 1];
    if (last && w.a <= last.b + 1) last.b = Math.max(last.b, w.b);
    else out.push(w);
  }
  return out;
}

function renderView(lines, windows, budget, meta) {
  const head = [];
  if (meta.step) head.push(`step: ${meta.step}`);
  if (meta.firstError) head.push(`first error at L${meta.firstError.line}: ${clipLine(meta.firstError.text)}`);
  if (meta.headline && meta.headline.line !== meta.firstError?.line) head.push(`headline at L${meta.headline.line}: ${clipLine(meta.headline.text)}`);
  if (meta.failingTests.length) head.push(`failing tests: ${meta.failingTests.slice(0, 10).map((t) => t.name).join(' | ')}`);
  if (meta.locations.length)
    head.push(`locations: ${meta.locations.slice(0, 12).map((l) => `${l.path}:${l.line} (L${l.logLine})`).join(', ')}`);
  if (!meta.firstError) head.push('no error line recognised, showing the end of the log');

  const body = [];
  let prevEnd = 0;
  for (const w of windows) {
    if (w.a > prevEnd + 1) body.push(`[... ${w.a - prevEnd - 1} lines omitted ...]`);
    let n = w.a;
    while (n <= w.b) {
      const text = lines[n - 1];
      if (/^##\[endgroup\]/.test(text)) {
        n++;
        continue;
      }
      if (isInternalFrame(text)) {
        let k = n;
        while (k <= w.b && isInternalFrame(lines[k - 1])) k++;
        body.push(`[${k - n} internal frames hidden]`);
        n = k;
        continue;
      }
      let k = n + 1;
      while (k <= w.b && lines[k - 1] === text) k++;
      body.push(`L${n}  ${clipLine(text)}`);
      if (k - n > 1) body.push(`[previous line repeated ${k - n - 1} more times]`);
      n = k;
    }
    prevEnd = w.b;
  }
  if (prevEnd < lines.length) body.push(`[... ${lines.length - prevEnd} lines omitted ...]`);

  let view = `${head.join('\n')}\n--- excerpt ---\n${body.join('\n')}`;
  if (view.length > budget + 2000) view = `${view.slice(0, budget + 2000)}\n[view truncated]`;
  return view;
}

function clipLine(s) {
  return s.length > VIEW_LINE ? `${s.slice(0, VIEW_LINE)} [line truncated]` : s;
}
