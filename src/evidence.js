// Evidence gathering without the model. Paths from the log are matched against
// tracked files only (`git ls-files`), so nothing outside the repository and
// nothing untracked is ever read.
import fs from 'node:fs/promises';
import path from 'node:path';

const WINDOW = 10;
const MAX_FILES = 8;
const MAX_FILE_BYTES = 1024 * 1024;
export const EVIDENCE_BUDGET = 24_000;

/** Split a path from a log into components, any separator, no empty or dot parts. */
export function pathParts(p) {
  return String(p)
    .replace(/^[A-Za-z]:/, '')
    .split(/[\\/]+/)
    .filter((s) => s && s !== '.');
}

/**
 * Map a log path to a tracked file. Tries the longest suffix of the log path
 * that matches exactly one tracked file.
 * @param {string} logPath
 * @param {{bySuffix: Map<string, string[]>}} index
 * @returns {string|null} repo relative path with forward slashes
 */
export function mapPath(logPath, index) {
  const parts = pathParts(logPath);
  if (parts.includes('..') || parts.length === 0) {
    // Relative paths with `..` are resolved by their trailing parts only.
    const tail = parts.filter((s) => s !== '..');
    if (tail.length === 0) return null;
    return mapPath(tail.join('/'), index);
  }
  for (let k = parts.length; k >= 1; k--) {
    const key = parts.slice(parts.length - k).join('/');
    const hits = index.bySuffix.get(key);
    // A shorter suffix can only match more files, so the first hit decides.
    if (hits) return hits.length === 1 ? hits[0] : null;
  }
  return null;
}

export function buildIndex(files) {
  const bySuffix = new Map();
  for (const f of files) {
    const parts = f.split('/');
    for (let k = 1; k <= parts.length; k++) {
      const key = parts.slice(parts.length - k).join('/');
      const list = bySuffix.get(key);
      if (list) {
        if (list.length < 3) list.push(f);
      } else bySuffix.set(key, [f]);
    }
  }
  return { bySuffix, files: new Set(files) };
}

/**
 * @param {{git: ReturnType<import('./git.js').createGit>, root: string, reduced: object, budget?: number}} args
 */
export async function gatherEvidence({ git, root, reduced, budget = EVIDENCE_BUDGET }) {
  const tracked = await git.lsFiles();
  const index = buildIndex(tracked);
  const mapped = [];
  const unmapped = [];
  const seen = new Map();
  for (const loc of reduced.locations) {
    const rel = mapPath(loc.path, index);
    if (!rel) {
      if (unmapped.length < 20) unmapped.push(`${loc.path}:${loc.line}`);
      continue;
    }
    const entry = seen.get(rel) ?? { path: rel, lines: [] };
    if (!seen.has(rel)) {
      if (seen.size >= MAX_FILES) continue;
      seen.set(rel, entry);
      mapped.push(entry);
    }
    if (!entry.lines.includes(loc.line) && entry.lines.length < 4) entry.lines.push(loc.line);
  }

  // Files imported by the matched files, read from the top. A stack trace often
  // ends in the test while the cause sits in the module it imports.
  for (const entry of [...mapped]) {
    if (seen.size >= MAX_FILES) break;
    let content;
    try {
      content = await fs.readFile(path.join(root, ...entry.path.split('/')), 'utf8');
    } catch {
      continue;
    }
    if (content.length > MAX_FILE_BYTES) continue;
    for (const imp of relativeImports(entry.path, content, index.files)) {
      if (seen.has(imp) || seen.size >= MAX_FILES) continue;
      const e = { path: imp, lines: [], imported: true };
      seen.set(imp, e);
      mapped.push(e);
    }
  }

  const files = [];
  const warnings = [];
  let used = 0;
  for (const entry of mapped) {
    const abs = path.join(root, ...entry.path.split('/'));
    let stat;
    try {
      stat = await fs.lstat(abs);
    } catch {
      warnings.push(`${entry.path} is tracked but missing in the working tree`);
      continue;
    }
    if (!stat.isFile()) {
      warnings.push(`${entry.path} is not a regular file, skipped`);
      continue;
    }
    if (stat.size > MAX_FILE_BYTES) {
      warnings.push(`${entry.path} is larger than 1 MB, skipped`);
      continue;
    }
    const content = (await fs.readFile(abs, 'utf8')).replace(/\r\n/g, '\n');
    if (content.includes('\0')) {
      warnings.push(`${entry.path} looks binary, skipped`);
      continue;
    }
    const fileLines = content.split('\n');
    const ranges = entry.imported
      ? [{ a: 1, b: Math.min(fileLines.length, 80) }]
      : mergeRanges(
          entry.lines
            .filter((n) => n <= fileLines.length)
            .map((n) => ({ a: Math.max(1, n - WINDOW), b: Math.min(fileLines.length, n + WINDOW) })),
        );
    if (ranges.length === 0) {
      warnings.push(`${entry.path} has fewer lines than the log refers to`);
      continue;
    }
    for (const r of ranges) {
      const text = fileLines
        .slice(r.a - 1, r.b)
        .map((l, i) => `${String(r.a + i).padStart(5)}  ${l.length > 300 ? `${l.slice(0, 300)} [line truncated]` : l}`)
        .join('\n');
      if (used + text.length > budget) {
        warnings.push(`evidence budget reached, ${entry.path}:${r.a} left out`);
        continue;
      }
      used += text.length;
      files.push({ path: entry.path, start: r.a, end: r.b, refs: entry.lines, imported: Boolean(entry.imported), text });
    }
  }

  const paths = [...new Set(files.map((f) => f.path))];
  const history = await git.logPatch(paths, { n: 5, maxChars: 8000 });
  const dirty = await git.dirty(paths);
  return { files, paths, history, dirty, unmapped, warnings, trackedCount: tracked.length };
}

const IMPORT_RE = /(?:\bfrom\s*|\brequire\s*\(\s*|\bimport\s*\(\s*|^\s*import\s+)['"](\.{1,2}\/[^'"\n]{1,200})['"]/gm;
const EXTS = ['', '.js', '.mjs', '.cjs', '.ts', '.tsx', '.jsx', '.mts', '.cts', '/index.js', '/index.ts'];

/** Relative imports of a source file, resolved to tracked files. */
export function relativeImports(fromPath, content, tracked) {
  const out = [];
  const dir = fromPath.split('/').slice(0, -1);
  IMPORT_RE.lastIndex = 0;
  let m;
  while ((m = IMPORT_RE.exec(content)) !== null && out.length < 6) {
    const parts = [...dir];
    for (const seg of m[1].split('/')) {
      if (seg === '..') parts.pop();
      else if (seg !== '.' && seg !== '') parts.push(seg);
    }
    const base = parts.join('/');
    const swapped = base.replace(/\.js$/, '.ts');
    for (const candidate of [...EXTS.map((e) => base + e), swapped]) {
      if (tracked.has(candidate)) {
        if (!out.includes(candidate)) out.push(candidate);
        break;
      }
    }
  }
  return out;
}

function mergeRanges(rs) {
  const sorted = rs.sort((x, y) => x.a - y.a);
  const out = [];
  for (const r of sorted) {
    const last = out[out.length - 1];
    if (last && r.a <= last.b + 1) last.b = Math.max(last.b, r.b);
    else out.push({ ...r });
  }
  return out;
}
