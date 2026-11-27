// Patch policy. Decides which paths a model written patch may touch before git
// ever sees it, and marks paths whose change alters what commands run or what
// gets downloaded (those need an explicit confirmation before verify or apply).

const SENSITIVE = [
  /^\.github\//,
  /^\.gitlab-ci\.ya?ml$/,
  /^\.circleci\//,
  /^\.buildkite\//,
  /^azure-pipelines\.ya?ml$/,
  /^Jenkinsfile$/,
  /(?:^|\/)\.gitattributes$/,
  /(?:^|\/)\.gitmodules$/,
  /(?:^|\/)package\.json$/,
  /(?:^|\/)(?:package-lock\.json|npm-shrinkwrap\.json|pnpm-lock\.yaml|yarn\.lock|bun\.lockb?)$/,
  /(?:^|\/)\.npmrc$/,
  /(?:^|\/)\.yarnrc(?:\.yml)?$/,
  /(?:^|\/)(?:Makefile|makefile|GNUmakefile|Rakefile|Justfile|justfile|Taskfile\.ya?ml)$/,
  /(?:^|\/)Dockerfile[^/]*$/,
  /(?:^|\/)(?:docker-)?compose\.ya?ml$/,
  /\.(?:sh|bash|zsh|ps1|psm1|bat|cmd)$/i,
  /(?:^|\/)(?:setup\.py|setup\.cfg|pyproject\.toml|tox\.ini|noxfile\.py|conftest\.py|Pipfile(?:\.lock)?|poetry\.lock|uv\.lock)$/,
  /(?:^|\/)requirements[^/]*\.txt$/,
  /(?:^|\/)(?:Cargo\.toml|Cargo\.lock|build\.rs|go\.mod|go\.sum|pom\.xml|build\.gradle(?:\.kts)?|settings\.gradle(?:\.kts)?|gradlew|Gemfile(?:\.lock)?|composer\.(?:json|lock))$/,
  /(?:^|\/)\.env(?:\.[^/]*)?$/,
  /(?:^|\/)\.pre-commit-config\.ya?ml$/,
  /(?:^|\/)\.husky\//,
];

export function isSensitivePath(p) {
  return SENSITIVE.some((re) => re.test(p));
}

function cleanHeaderPath(raw) {
  return raw.split('\t')[0].trim().replace(/^"(.*)"$/, '$1');
}

function stripPrefix(p) {
  return p.replace(/^[ab]\//, '');
}

/** Problems with a single repository relative path, or null when fine. */
export function pathProblem(p) {
  if (!p) return 'empty path';
  if (/^[\\/]/.test(p) || /^[A-Za-z]:/.test(p)) return `absolute path "${p}"`;
  const parts = p.split(/[\\/]/);
  if (parts.includes('..')) return `path escapes the repository "${p}"`;
  if (parts.some((s) => s.toLowerCase() === '.git')) return `path inside .git "${p}"`;
  if (/[\0\r]/.test(p)) return 'control character in path';
  return null;
}

/**
 * Normalise and check a unified diff.
 * @param {string} patch
 * @returns {{ok: boolean, errors: string[], files: string[], sensitive: string[], patch: string}}
 */
export function checkPatch(patch) {
  const errors = [];
  const files = new Set();
  const text = String(patch ?? '').replace(/\r\n/g, '\n');
  const lines = text.split('\n');
  let hunks = 0;
  const out = [];
  let prevHeader = false;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    // A "--- " line is a file header only when "+++ " follows, otherwise it is a
    // removed line that happens to start with dashes.
    const isOld = line.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ');
    const isNew = line.startsWith('+++ ') && prevHeader;
    prevHeader = isOld;
    if (/^GIT binary patch|^Binary files /.test(line)) errors.push('binary patches are not allowed');
    if (/^(?:old|new) mode /.test(line) || /^new file mode (?!100644$)/.test(line)) {
      errors.push('mode changes, executables and symlinks are not allowed');
    }
    if (/^(?:rename|copy) (?:from|to) /.test(line)) errors.push('renames and copies are not allowed');
    if (/^@@ /.test(line)) hunks++;
    let m = isOld || isNew ? /^(---|\+\+\+) (.+)$/.exec(line) : null;
    if (m) {
      const p = cleanHeaderPath(m[2]);
      if (p !== '/dev/null') {
        const rel = stripPrefix(p);
        const problem = pathProblem(rel);
        if (problem) errors.push(problem);
        files.add(rel);
        out.push(`${m[1]} ${m[1] === '---' ? 'a' : 'b'}/${rel}`);
        continue;
      }
      out.push(`${m[1]} /dev/null`);
      continue;
    }
    m = /^diff --git (\S+) (\S+)$/.exec(line);
    if (m) {
      const a = stripPrefix(m[1]);
      const b = stripPrefix(m[2]);
      for (const p of [a, b]) {
        const problem = pathProblem(p);
        if (problem) errors.push(problem);
      }
      out.push(`diff --git a/${a} b/${b}`);
      continue;
    }
    out.push(line);
  }
  if (files.size === 0) errors.push('patch names no file');
  if (files.size > 20) errors.push('patch touches more than 20 files');
  if (hunks === 0) errors.push('patch has no hunk');
  let normalized = out.join('\n');
  if (!normalized.endsWith('\n')) normalized += '\n';
  const list = [...files];
  return { ok: errors.length === 0, errors: [...new Set(errors)], files: list, sensitive: list.filter(isSensitivePath), patch: normalized };
}
