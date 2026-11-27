// Flaky memory. A small SQLite file (node:sqlite) of failure signatures and
// outcomes. Counts come from the outcomes table, and each outcome has an
// idempotency key, so analysing the same run twice counts once.

let sqliteModule;
export async function loadSqlite() {
  if (sqliteModule !== undefined) return sqliteModule;
  try {
    sqliteModule = await import('node:sqlite');
  } catch {
    sqliteModule = null;
  }
  return sqliteModule;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS failures (
  signature TEXT PRIMARY KEY CHECK (length(signature) = 16 AND signature NOT GLOB '*[^0-9a-f]*'),
  first_seen TEXT NOT NULL,
  last_seen TEXT NOT NULL,
  headline TEXT NOT NULL CHECK (length(headline) <= 300),
  last_category TEXT
);
CREATE TABLE IF NOT EXISTS outcomes (
  id INTEGER PRIMARY KEY,
  signature TEXT NOT NULL REFERENCES failures(signature) ON DELETE CASCADE,
  outcome TEXT NOT NULL CHECK (outcome IN ('failed', 'passed')),
  source TEXT NOT NULL CHECK (length(source) <= 200),
  at TEXT NOT NULL,
  UNIQUE (signature, outcome, source)
);
CREATE INDEX IF NOT EXISTS outcomes_signature ON outcomes(signature);
PRAGMA user_version = 1;
`;

export const SIGNATURE_RE = /^[0-9a-f]{16}$/;

/**
 * Flaky label from counts (decision in DEVELOPER.md).
 * failed >= 2 and passed >= 1: likely_flaky. failed >= 2: recurring. Else new.
 */
export function flakyLabel({ failed, passed }) {
  if (failed >= 2 && passed >= 1) return 'likely_flaky';
  if (failed >= 2) return 'recurring';
  if (passed >= 1) return 'passed_before';
  return 'new';
}

export async function openMemory(file, { now = () => new Date() } = {}) {
  const sqlite = await loadSqlite();
  if (!sqlite) return null;
  const fs = await import('node:fs');
  const path = await import('node:path');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new sqlite.DatabaseSync(file);
  db.exec('PRAGMA foreign_keys = ON;');
  db.exec(SCHEMA);
  const iso = () => now().toISOString();

  const counts = (signature) => {
    const rows = db.prepare('SELECT outcome, COUNT(*) AS n FROM outcomes WHERE signature = ? GROUP BY outcome').all(signature);
    const c = { failed: 0, passed: 0 };
    for (const r of rows) c[r.outcome] = Number(r.n);
    return c;
  };

  return {
    file,
    lookup(signature) {
      const row = db.prepare('SELECT * FROM failures WHERE signature = ?').get(signature);
      if (!row) return null;
      const c = counts(signature);
      return { signature, firstSeen: row.first_seen, lastSeen: row.last_seen, headline: row.headline, lastCategory: row.last_category, ...c, label: flakyLabel(c) };
    },
    record(signature, { headline, category = null, outcome = 'failed', source }) {
      if (!SIGNATURE_RE.test(signature)) throw new Error('invalid signature');
      if (outcome !== 'failed' && outcome !== 'passed') throw new Error('outcome must be failed or passed');
      const t = iso();
      db.exec('BEGIN');
      try {
        db.prepare(
          `INSERT INTO failures (signature, first_seen, last_seen, headline, last_category) VALUES (?, ?, ?, ?, ?)
           ON CONFLICT(signature) DO UPDATE SET last_seen = excluded.last_seen, last_category = COALESCE(excluded.last_category, failures.last_category)`,
        ).run(signature, t, t, String(headline ?? '').slice(0, 300) || '(no headline)', category);
        db.prepare('INSERT OR IGNORE INTO outcomes (signature, outcome, source, at) VALUES (?, ?, ?, ?)').run(
          signature,
          outcome,
          String(source ?? `manual:${t}`).slice(0, 200),
          t,
        );
        db.exec('COMMIT');
      } catch (err) {
        db.exec('ROLLBACK');
        throw err;
      }
      return this.lookup(signature);
    },
    mark(signature, outcome) {
      if (!this.lookup(signature)) return null;
      return this.record(signature, { outcome, source: `manual:${iso()}` });
    },
    forget(signature) {
      const r = db.prepare('DELETE FROM failures WHERE signature = ?').run(signature);
      return Number(r.changes) > 0;
    },
    list(limit = 50) {
      const rows = db.prepare('SELECT signature FROM failures ORDER BY last_seen DESC LIMIT ?').all(limit);
      return rows.map((r) => this.lookup(r.signature));
    },
    close() {
      db.close();
    },
  };
}
