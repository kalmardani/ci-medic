# Changelog

The format follows Keep a Changelog, and the project uses semantic versioning. Versions below
1.0.0 make no stability promise.

## 0.1.1, 2026-11-27

### Changed
- The `claude-cli` and `codex-cli` adapters start the vendor CLI in a fresh, empty folder made
  with `mkdtemp` under the OS temp dir (`ci-medic-llm-` prefix) and remove it after every call,
  also after an error or a timeout, now with retries for Windows and without letting a failed
  cleanup hide the real result. Project instruction files of the folder you work in or of the
  repository under triage are never sent to the model.
- The process runner accepts an injected spawn function, used by tests.

### Added
- A test that checks, with a fake spawn, that both adapters run in an empty folder inside the
  OS temp dir, never the current directory, and that the folder is gone after the call.

## 0.1.0, 2026-11-27

### Added
- Triage of a failed CI log from a file, stdin or a GitHub Actions run (REST API, `GITHUB_TOKEN`).
- Deterministic log reduction (ANSI, timestamps, CRLF, first real error, failing tests, file
  locations, stack frames, noise collapse) and a failure signature.
- Evidence from tracked files, imported files and recent git history, gathered without the model.
- Structured model answer with a closed schema, one repair round, quote verification against the
  log and a confidence cap for unsupported diagnoses.
- Patch policy, `git apply --check`, verification in a temporary git worktree with `--verify`,
  and `--apply` behind a confirmation.
- Flaky memory on `node:sqlite` with `memory list`, `mark` and `forget`.
- Markdown report for PR comments with escaped model text, and JSON output.
- Providers `openai`, `anthropic`, `claude-cli`, `codex-cli`, `none` and `fake`, with the auth
  kinds `api-key`, `oauth` (client credentials, PKCE, device grant) and `subscription`.
- `auth login`, `auth login claude`, `auth login chatgpt`, `auth status`, `auth logout`.
- `ci-medic apply --patch <file>` and `ci-medic reduce`.
- MCP stdio server with `triage_log`, `get_report` and `propose_patch`.
