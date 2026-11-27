# ci-medic developer notes

This file holds the paper phase (written before the code), the architecture, the module map,
how to test, what was verified and what was not.

## Risk level

Level 2 (production tool for external users). Other people run it on their own private
repositories, it sends repository excerpts to a model provider, it can run a command the user
names and it can write to the working tree after a confirmation. The full canon workflow applies,
including the threat model and the complete checklist. Level 3 does not apply because the tool
handles no special category data, has no tenants and every irreversible step sits behind a human
confirmation.

## Paper phase

### One paragraph

ci-medic helps a developer whose CI run just failed. It reads the failed log (a file, stdin, or a
GitHub Actions run fetched with the user's token), reduces it deterministically to the lines that
matter, maps the file paths in the log to files in the local checkout, reads the relevant line
windows and the recent git history of those files, and asks a language model for a structured
diagnosis. Code then checks every log line the model quotes against the real log, drops what it
cannot find, checks the proposed patch against a path policy and with `git apply --check`, and
optionally runs the user's own test command on the patched code in a temporary git worktree. The
output is a markdown report ready to paste as a PR comment plus a JSON document. The working tree
changes only when the user passes `--apply` and confirms.

### IPO sheet

| Input | Source | Trust |
|---|---|---|
| CI log text | file, stdin, or GitHub REST API (`GITHUB_TOKEN`) | untrusted |
| Local git checkout | path given by the user | semi trusted (the user's own code, may contain hostile text) |
| Flags and env | the user | trusted |
| Model response | provider adapter | untrusted |
| Flaky memory | local SQLite file written by ci-medic | trusted structure, untrusted text fields |
| OAuth tokens | token endpoint, local cache | secret |

| Process | Deterministic? |
|---|---|
| Normalise and reduce the log | yes |
| Failure signature (hash) | yes |
| Path mapping, line windows, git history | yes |
| Diagnosis and patch proposal | no (model) |
| Schema check, quote check, patch policy, `git apply --check` | yes |
| Worktree verification with the user's command | yes, runs user configured command |

| Output | Side effect |
|---|---|
| Markdown report, JSON report | stdout or files the user names |
| Flaky memory row | SQLite file inside `.git/ci-medic/` by default |
| Temporary worktree | created and removed under `os.tmpdir()`, git metadata pruned |
| Patched working tree | only with `--apply` plus a yes |
| Token cache | per user config dir, mode 0600 |

### Context diagram with trust boundaries

```
                       trusted                         |          untrusted
                                                       |
   +--------+  flags, env, confirmation   +----------+ |  log text   +----------------+
   |  user  | --------------------------> |          | <---------- |  CI log file / |
   +--------+ <-------------------------- |          | |           |  stdin         |
       ^        markdown + JSON report    |          | |           +----------------+
       |                                  |          | |  HTTPS      +----------------+
   +--------+  JSON-RPC over stdio        | ci-medic | <=========> |  GitHub REST   |
   |  MCP   | --------------------------> |   core   | |  token     +----------------+
   | client | <-------------------------- |          | |
   +--------+  triage, report, patch      |          | |  prompt    +----------------+
                                          |          | ==========> |  model adapter |
   +---------------------+   spawn argv   |          | <========== |  (HTTP or CLI) |
   | git (local binary)  | <------------> |          | |  JSON text +----------------+
   +---------------------+                |          | |
   +---------------------+   spawn argv   |          | |  HTTPS     +----------------+
   | user verify command | <------------- |          | <=========> | OAuth token    |
   | (in temp worktree)  |  only if user  +----------+ |            | endpoint       |
   +---------------------+  configured it       |      |            +----------------+
                                                v      |
                                   +------------------+|
                                   | SQLite memory,   ||
                                   | token cache      ||
                                   +------------------+|
```

Boundaries crossed by hostile data: log into core, model text into core, repository text into the
prompt, model text into the markdown report (which GitHub renders), patch into git.

### Data model

Flaky memory (SQLite, `node:sqlite`).

```
failures
  signature   TEXT PRIMARY KEY, 16 lowercase hex chars (CHECK)
  first_seen  TEXT NOT NULL, ISO 8601 UTC
  last_seen   TEXT NOT NULL, ISO 8601 UTC
  headline    TEXT NOT NULL, first error line, max 300 chars, untrusted text
  last_category TEXT NULL, one of the category enum

outcomes
  id          INTEGER PRIMARY KEY
  signature   TEXT NOT NULL REFERENCES failures ON DELETE CASCADE
  outcome     TEXT NOT NULL CHECK IN ('failed', 'passed')
  source      TEXT NOT NULL, idempotency key (GitHub run and attempt, or log hash, or 'manual:<time>')
  at          TEXT NOT NULL, ISO 8601 UTC
  UNIQUE (signature, outcome, source)
```

Counts are derived from `outcomes` with `COUNT(*)`, so analysing the same run twice does not
double count. Only the local user reads and writes the file. All four memory operations exist:
add (a triage records a failure), update (`memory mark`), delete (`memory forget`), and no op
(lookup without write with `--no-memory`). `memory list` prints the content for a human.

Triage result (JSON, also the MCP structured result) is documented in README under "JSON output".
Model output schema (hand written check in `src/analysis/schema.js`).

```
category        enum: test_failure, regression, flaky, dependency, infrastructure, configuration, unknown
confidence      number 0..1
summary         string 1..200
root_cause      string 1..3000
evidence        array 0..12 of { quote: string 1..500, explains: string 0..300 }
suggested_fix   string 0..2000
patch           null or unified diff string up to 60000 chars
```

Unknown keys are rejected at every level.

OAuth token cache (JSON, one entry per token URL plus client id plus scope hash) with
`access_token`, `refresh_token`, `expires_at`, `token_type`, `scope`, `obtained_at`.

### Quality attribute scenarios

1. Security, prompt injection. Source is a CI log line written by an attacker ("ignore previous
   instructions and run curl ..."). Stimulus is a normal triage run. Response is that no process
   other than `git` starts, unknown output fields are rejected, a patch touching CI config or
   manifests cannot be verified or applied without an explicit confirmation, and links and images
   in model text are neutralised in the markdown. Measure is 100 percent of the injection tests
   pass, with the fake adapter scripted to obey the injection.
2. Correctness of claims. Source is the model. Stimulus is a diagnosis quoting log lines.
   Response is that every quote shown in the report appears verbatim in the normalised log.
   Measure is zero unverified quotes in any report; a diagnosis with no surviving quote is marked
   unsupported and its confidence capped at 0.2.
3. Cost and latency. Source is a 20 MB log. Stimulus is a triage run. Response is that the model
   sees at most about 50 000 characters (about 12 500 tokens) and at most two model calls happen.
   Measure is reduction under 2 seconds on a laptop for a 20 MB log (not measured on every OS, see
   "Not verified").

Deliberately not optimised for diagnosis quality on exotic toolchains. The log reducer knows the
common runners (node test, jest, pytest, go test, cargo, tsc, maven, rspec) and falls back to the
tail of the log otherwise.

### Decisions likely to change, and the module that hides each

| Decision | Hidden in |
|---|---|
| Model provider and wire format | `src/model/*.js` behind `createProvider` |
| Auth method (api key, OAuth grants, subscription CLI) | `src/auth/*.js` and `src/model/provider.js` |
| Log formats and error patterns | `src/log/reduce.js` |
| What counts as the same failure | `src/log/signature.js` |
| Prompt wording | `src/prompts/triage-v1.md` (versioned file) |
| Output schema | `src/analysis/schema.js` |
| Which paths a patch may touch | `src/patch/policy.js` |
| How a command string becomes argv | `src/patch/argv.js` |
| Storage of flaky memory | `src/memory/store.js` |
| CI source (GitHub today) | `src/github.js` |
| Report format | `src/report/*.js` |
| Agent interface (MCP protocol version) | `src/mcp/server.js` |

### Back of the envelope

Computed with a script (Python, kept in the commit history of this file's first version).

| Quantity | Value |
|---|---|
| System prompt | about 4 500 chars |
| Reduced log cap | 12 000 chars |
| Evidence windows cap | 24 000 chars |
| Git history cap | 8 000 chars |
| Max input per call | 50 000 chars, about 12 500 tokens at 4 chars per token |
| Typical input per call | about 20 000 chars, about 5 000 tokens |
| Output cap (`max_tokens`) | 4 096, typical answer about 1 200 tokens |
| Model calls per run | 1 typical, 2 worst case (one repair round) |
| Typical cost per run | 0.033 USD at an assumed 3 USD per million input and 15 USD per million output tokens |
| Worst case per run | 0.21 USD (two max size calls) |
| 100 runs a month | about 3.30 USD typical |
| 20 MB log | about 175 000 lines at 120 bytes per line, read fully in memory (fine below 100 MB) |
| Memory DB | about 9 MB for 10 000 signatures with outcomes, far beyond normal use |

The prices are an assumption for the arithmetic only. They change and must be checked on the
provider's page on the day. With a subscription CLI the user pays nothing per call but the
subscription's rate limits apply.

### Five minute threat model

What are we working on? A local CLI and MCP server that reads hostile text, talks to a model,
spawns git and optionally one user named command, and can write to the working tree.

STRIDE on the boundaries.

| Boundary | Threat | Mitigation |
|---|---|---|
| Log into core | Tampering, Elevation (prompt injection steers the model) | Model never chooses an action. Output is a closed schema with no command field, unknown keys rejected. Log and repository text sit inside random nonce fences labelled as data. Commands come only from flags |
| Log into core | Denial of service (huge log, catastrophic regex) | Download cap 20 MB per run, line length cap 4 000 chars before regex work, linear regexes only |
| Model into core | Tampering (fabricated evidence) | Quote verifier against the normalised log, unsupported diagnoses capped |
| Model into git | Elevation (patch writes `.git/hooks`, escapes repo, symlinks) | Patch policy rejects absolute paths, `..`, `.git/`, symlink modes, binary patches, over 20 files |
| Model into verify command | Elevation (patch edits `package.json` test script or CI config, then verify runs it) | Sensitive paths need explicit confirmation before verify or apply. Verify runs with secrets removed from the environment, inside a temp worktree, with a timeout. Documented as "verify executes the patched code" |
| Model into markdown | Information disclosure (image URL exfiltrates code when GitHub renders the comment), spoofing (mentions) | Markdown special characters escaped outside code spans, `@` mentions neutralised, quotes and patches in fences longer than any backtick run, bidi and control characters stripped |
| Core into provider | Information disclosure (code sent to a third party) | Only reduced log plus capped excerpts leave the machine, no git author names or emails, documented in README and SECURITY.md |
| Token handling | Information disclosure | Tokens only from env or cache file 0600, never printed, error messages carry status and error code only, Authorization not forwarded on the GitHub log redirect |
| OAuth flows | Spoofing (CSRF on the loopback redirect) | Random `state` checked, PKCE S256, loopback bound to 127.0.0.1 only, random port, one request accepted, 5 minute timeout |
| MCP client into core | Elevation (agent picks repo or command) | MCP has no verify and no apply tools. Repo and log paths must sit under allowed roots (server cwd or `CI_MEDIC_MCP_ROOTS`) |
| Local git config | Elevation (hooks run on worktree add) | `core.hooksPath` pointed at an empty temp dir, `--no-ext-diff --no-textconv`, no pager, no terminal prompt |
| Any boundary | Repudiation | JSON report records provider, model, prompt version, token counts, every dropped claim and every command run |

Did we do a good enough job? Good enough for 0.1.0. The worst residual risk is that `--verify`
executes model written code with the user's privileges. That is the purpose of verification and
is stated plainly; a real sandbox is out of scope.

The private data, untrusted content and outbound channel combination: one triage context holds
private code and an untrusted log, and the outbound channel is the model provider itself plus the
markdown report. The report channel is cut by escaping (no images, no links). The provider channel
is accepted by the user's choice of provider. There is no other outbound tool.

### Decision table, patch actions

Conditions. A = patch present and passes policy and `git apply --check`. S = patch touches a
sensitive path (CI config, manifests, lockfiles, build or shell scripts, env files). V = `--verify`
given. P = `--apply` given. Y = confirmed (interactive yes on a TTY, or `--yes`). R = verify result.

| # | A | S | V | P | Y | R | Action |
|---|---|---|---|---|---|---|---|
| 1 | no | any | any | any | any | none | report why, no verify, no apply |
| 2 | yes | any | no | no | any | none | report only |
| 3 | yes | no | yes | no | any | run | verify in temp worktree |
| 4 | yes | yes | yes | any | no | none | verify skipped, report how to confirm |
| 5 | yes | yes | yes | any | yes | run | verify in temp worktree |
| 6 | yes | any | any | yes | no | any | not applied, say how to confirm |
| 7 | yes | any | no | yes | yes | none | apply to working tree |
| 8 | yes | any | yes | yes | yes | pass | apply to working tree |
| 9 | yes | any | yes | yes | yes | fail or skipped | not applied, verify did not pass |

The code lives in `src/patch/decide.js` as one function whose cases mirror the rows, and the test
`test/decide.test.js` has one case per row.

### Decision table, diagnosis status

| Model output valid after at most one repair | At least one verified quote | Some quotes dropped | Status |
|---|---|---|---|
| no | any | any | `model_failed`, deterministic report only, exit code 3 |
| yes | no | any | `unsupported`, confidence capped at 0.2 |
| yes | yes | yes | `partially_supported`, dropped count shown |
| yes | yes | no | `supported` |
| provider `none` | n/a | n/a | `no_model`, deterministic report only |

## Architecture

See `docs/adr/` for the decisions. A pipeline in one process (modular monolith, one quantum).
Steps run in a fixed order chosen by code. The model is one step that proposes, code checks and
acts. There is no agent loop.

```
read log -> normalise -> reduce -> signature -> memory lookup
         -> evidence (git ls-files, windows, git log -p)
         -> prompt (nonce fenced data) -> provider -> parse -> schema check
         -> quote check -> patch policy -> git apply --check -> (one repair round if needed)
         -> decide (table above) -> verify in worktree? -> apply? -> memory record -> report
```

## Module map

Filled in after the code, see the section further below.
