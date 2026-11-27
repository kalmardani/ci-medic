// Working directory for one vendor CLI call. The claude and codex CLIs load
// instruction files (CLAUDE.md, AGENTS.md and similar) from their working
// directory and send them with every call, so neither the user's current
// directory nor the repository under triage may be used. Each call gets a fresh,
// empty folder under the OS temp dir, removed afterwards.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export function makeWorkDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'ci-medic-llm-'));
}

/**
 * Called from a finally block, so it also runs after an error or a timeout. The
 * retries cover Windows, where a killed process can hold the folder for a
 * moment. A leftover temp folder must not hide the real result.
 */
export function removeWorkDir(dir) {
  try {
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  } catch {
    // best effort
  }
}
