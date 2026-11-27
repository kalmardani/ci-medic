# ci-medic

ci-medic triages a failed CI run. It reads the log, finds the lines that matter, looks up the
files the log points at in your local checkout, and asks a language model why the run failed.
Code then checks the answer. Every log line the model quotes must really be in the log, the
proposed patch must pass `git apply --check`, and if you give it your test command it runs that
command on the patched code in a throwaway git worktree. You get a markdown report you can paste
as a PR comment, and JSON.

Your working tree changes only when you pass `--apply` and say yes.

Node.js 22.5 or newer, git, and no other dependencies. Windows, macOS and Linux.

## Quick start

From GitHub, without installing:

```
npx github:kalmardani/ci-medic --log failed.log --provider claude-cli
```

From a local clone:

```
git clone https://github.com/kalmardani/ci-medic
cd ci-medic
node bin/ci-medic.js --help
```

Run it inside the git checkout of the project whose CI failed, or point `--repo` at it.

```
ci-medic --log failed.log --provider claude-cli
cat failed.log | ci-medic --provider anthropic --model <model id>
ci-medic --run https://github.com/OWNER/REPO/actions/runs/123456 --provider claude-cli
ci-medic --log failed.log --provider claude-cli --verify "node --test"
ci-medic --log failed.log --provider claude-cli --verify "node --test" --apply
```

Try it on the bundled example. The script builds a small repository with a regression commit.

```
node examples/make-sample-repo.js /tmp/sample-shop
cd /tmp/sample-shop
node <path to ci-medic>/bin/ci-medic.js --log <path to ci-medic>/examples/logs/node-regression.log \
  --provider claude-cli --verify "node --test spec/cart.spec.js"
```

## Use your own subscription

If you have a Claude or ChatGPT subscription, sign in once through the vendor's official CLI and
ci-medic uses it.

```
ci-medic auth login claude     # then --provider claude-cli
ci-medic auth login chatgpt    # then --provider codex-cli
```

Each command checks that the official CLI (`claude` or `codex`) is installed, checks whether it is
already signed in, and if not starts that CLI's own interactive sign in in your terminal.
ci-medic never reads or reuses the tokens those CLIs store and never calls a vendor API with
them; it only starts the official CLI as a subprocess.

`ci-medic auth status` shows every connection type and whether it is ready, without printing any
secret.

## Example output

This is the real report from the smoke test on 2026-11-27 (`claude-cli` adapter, the bundled
sample repository, `--verify "node --test spec/cart.spec.js"`). Nothing is edited.

````markdown
### ci-medic triage

**Category** regression | **Confidence** 0.96 | **Signature** `315ca005e611f0c2` | **History** first time seen, failed 1, passed 0

**Summary.** Commit 8a30551 moved the discount to each line with Math.floor, so the 10% cart total is 897 instead of the 899 the test expects.

**Root cause**

Commit 8a30551 \(refactor\: apply the discount per line\) changed cartTotal in src/cart.js. Before it, the function summed the line totals, computed the discount once on the subtotal with Math.round and subtracted it. For three items of 333 cents with a 10 percent discount that gives a subtotal of 999, a discount of round\(99.9\) \= 100 and a total of 899. After the commit each line is discounted separately with Math.floor\(\(cents \* \(100 \- percent\)\) / 100\). Each 333 cent line becomes floor\(299.7\) \= 299, and three lines add up to 897. The test at spec/cart.spec.js\:13 is named for the intended behaviour \(round the discount once on the subtotal\) and was added together with the original implementation in 6b486df, so the test is correct and the refactor changed behaviour. The other two tests pass because they do not use a discount. The failure is deterministic and unrelated to the runner or dependencies.

**Evidence from the log** (each line checked against the log)

```
L40: ✖ cart total rounds the discount once on the subtotal (24.934296ms)
```
The only failing test is the one that covers rounding the discount once on the subtotal.

```
L56: 897 !== 899
```
The result is 2 cents low, which matches three per line floors of 299.7 down to 299 instead of one rounding on 999.

```
L67: actual: 897,
```
cartTotal returns 897 with the per line Math.floor implementation from commit 8a30551.

```
L68: expected: 899,
```
The test expects 899, the value the original subtotal based implementation produced.

```
L58: at TestContext.<anonymous> (file:///home/runner/work/sample-shop/sample-shop/spec/cart.spec.js:19:10)
```
The assertion that fails is the cartTotal call with discountPercent 10 on line 19 of the spec.

```
L39: ✔ cart total without discount (30.456557ms)
```
Totals without a discount still work, so the fault is limited to the discount path changed in the refactor.

**Suggested fix**

Restore the subtotal based calculation in cartTotal in src/cart.js. Sum the line totals first, compute the discount once with Math.round on the subtotal and subtract it. Remove the per line discounted helper, which is then unused. Do not change the test.

**Proposed patch**

Applies cleanly to the checkout (`git apply --check`). Verified in a temporary worktree with `node --test spec/cart.spec.js`, passed in 0.2 s.

```diff
--- a/src/cart.js
+++ b/src/cart.js
@@ -4,10 +4,8 @@ export function lineTotal(item) {
   return item.priceCents * item.qty;
 }
 
-function discounted(cents, percent) {
-  return Math.floor((cents * (100 - percent)) / 100);
-}
-
 export function cartTotal(items, { discountPercent = 0 } = {}) {
-  return items.reduce((sum, item) => sum + discounted(lineTotal(item), discountPercent), 0);
+  const subtotal = items.reduce((sum, item) => sum + lineTotal(item), 0);
+  const discount = Math.round((subtotal * discountPercent) / 100);
+  return subtotal - discount;
 }
```

<details><summary>Deterministic findings</summary>

- Step Run npm test
- First error at log line 40
- Failing tests cart total rounds the discount once on the subtotal
- Files matched in the repository `spec/cart.spec.js`, `src/cart.js`
- Log lines 81, reduced view 1839 characters

```
L54: AssertionError [ERR_ASSERTION]: Expected values to be strictly equal:
```

</details>

<sub>ci-medic 0.1.0, claude\-cli claude\-fable\-5\-2, prompt triage-v1. The diagnosis comes from a language model and is checked by code where possible. Review it before merging.</sub>
````

## Interfaces

ci-medic has two interfaces. A local HTTP proxy does not fit a triage tool, so there is none.

**CLI.** Every feature is a command.

| Command | What it does |
|---|---|
| `ci-medic [triage] --log <file\|-> [options]` | triage a log file or stdin |
| `ci-medic [triage] --run <url> [options]` | triage a GitHub Actions run, fetched with `GITHUB_TOKEN` |
| `ci-medic reduce --log <file\|->` | print the reduced log view and signature, no model |
| `ci-medic apply --patch <file> [--verify "<cmd>"] [--yes]` | check, verify and apply a saved patch |
| `ci-medic memory list \| forget <sig> \| mark <sig> passed\|failed` | read and edit the flaky memory |
| `ci-medic auth login [claude\|chatgpt]` | OAuth sign in, or sign in through a vendor CLI |
| `ci-medic auth status [--json]` | show every connection type |
| `ci-medic auth logout` | remove the cached OAuth token |
| `ci-medic mcp` | MCP server on stdio |

The triage options are `--repo <dir>`, `--provider`, `--auth`, `--model`, `--max-tokens`,
`--oauth-config <file>`, `--format md|json`, `--output <file>`, `--json-output <file>`,
`--verify "<command>"`, `--verify-timeout <seconds>`, `--apply`, `--yes`, `--memory <file>`,
`--no-memory`, `--attempt <n>`, `--quiet`.

The exit codes are 0 when the report was written, 2 for a usage or config error, 3 when the
model gave no valid answer (the report then holds only the deterministic findings), 4 for an input
error (log, git, GitHub) and 1 for anything else.

**MCP server.** `ci-medic mcp` speaks JSON-RPC 2.0 over stdio (`initialize`, `tools/list`,
`tools/call`) and offers three tools.

| Tool | Arguments | Result |
|---|---|---|
| `triage_log` | one of `log`, `log_path`, `github_run`; optional `repo` | `triage_id`, category, verified root cause, history, whether a patch exists |
| `get_report` | `triage_id`, `format` (`markdown` or `json`) | the full report |
| `propose_patch` | `triage_id` | the unified diff, the apply check result, the files it touches |

There is no verify and no apply tool. To apply a patch an agent proposed, save it and run
`ci-medic apply --patch <file>` in a terminal, which asks before it changes anything. The server
reads repositories and log files only under its working directory, or under the directories in
`CI_MEDIC_MCP_ROOTS` (separated by `:` on macOS and Linux, `;` on Windows). The provider comes from
the server's environment. `CI_MEDIC_MCP_MEMORY=0` turns flaky memory off for the server.

Example client configuration:

```json
{
  "mcpServers": {
    "ci-medic": {
      "command": "npx",
      "args": ["-y", "github:kalmardani/ci-medic", "mcp"],
      "env": { "CI_MEDIC_PROVIDER": "claude-cli" }
    }
  }
}
```

## Configuration

Flags win over env vars.

**Provider and auth.** The adapter decides the wire format, the auth decides how ci-medic
proves who you are.

| `--provider` | `--auth` | Needs |
|---|---|---|
| `openai` | `api-key` (default) or `oauth` | `--model`; any OpenAI compatible chat completions endpoint, hosted or local |
| `anthropic` | `api-key` (default) or `oauth` | `--model`; the Messages API, or a gateway that accepts bearer tokens |
| `claude-cli` | `subscription` (implied) | the official `claude` CLI, signed in |
| `codex-cli` | `subscription` (implied) | the official `codex` CLI, signed in |
| `none` | none | nothing, deterministic report only |
| `fake` | none | `CI_MEDIC_FAKE_RESPONSES`, for tests |

| Env var | Meaning |
|---|---|
| `CI_MEDIC_PROVIDER`, `CI_MEDIC_AUTH`, `CI_MEDIC_MODEL` | same as the flags |
| `OPENAI_API_KEY`, `ANTHROPIC_API_KEY` | API keys |
| `CI_MEDIC_API_KEY_ENV` | read the key from another env var instead |
| `CI_MEDIC_OPENAI_BASE_URL` | default `https://api.openai.com/v1`; a local server such as `http://127.0.0.1:11434/v1` needs no key |
| `CI_MEDIC_ANTHROPIC_BASE_URL` | default `https://api.anthropic.com` |
| `CI_MEDIC_MAX_TOKENS` | output cap per call, default 4096 |
| `CI_MEDIC_TIMEOUT_MS` | per call timeout, default 120000 (300000 for the CLIs) |
| `CI_MEDIC_CLAUDE_BIN`, `CI_MEDIC_CODEX_BIN` | path to the vendor CLI, needed on Windows when only a `.cmd` shim is on PATH |
| `CI_MEDIC_MAX_BUDGET_USD` | passed to `claude -p --max-budget-usd` |
| `GITHUB_TOKEN` | for `--run`; needs read access to Actions |
| `GITHUB_API_URL` | GitHub Enterprise Server API base, default `https://api.github.com` |
| `CI_MEDIC_CONFIG_DIR` | override the per user config dir |
| `CI_MEDIC_MCP_ROOTS`, `CI_MEDIC_MCP_MEMORY` | MCP server limits |

Keys and tokens are never printed or logged.

**OAuth.** For endpoints that accept bearer tokens, for example an enterprise gateway or Azure
OpenAI behind Microsoft Entra ID. Three grants are supported.

| Grant | When | Sign in |
|---|---|---|
| `client_credentials` | service to service, no user | silent, token fetched when needed |
| `pkce` | a user signs in with a browser | `ci-medic auth login` opens the browser (or prints the URL), redirect to `127.0.0.1` on a random port |
| `device` | no browser on this machine | `ci-medic auth login` prints a code and a URL, then polls |

Configure in `oauth.json` in the config dir (`%APPDATA%\ci-medic` on Windows,
`~/Library/Application Support/ci-medic` on macOS, `$XDG_CONFIG_HOME/ci-medic` or
`~/.config/ci-medic` on Linux), with `--oauth-config <file>`, or with env vars.

```json
{
  "grant": "client_credentials",
  "token_url": "https://login.example.com/oauth2/v2.0/token",
  "client_id": "your-client-id",
  "scope": "https://cognitiveservices.azure.com/.default",
  "client_secret_env": "CI_MEDIC_OAUTH_CLIENT_SECRET"
}
```

The file keys are `grant`, `token_url`, `auth_url` (pkce), `device_url` (device), `client_id`, `scope`,
`audience`, `client_secret_env`. The env vars are `CI_MEDIC_OAUTH_GRANT`,
`CI_MEDIC_OAUTH_TOKEN_URL`, `CI_MEDIC_OAUTH_AUTH_URL`, `CI_MEDIC_OAUTH_DEVICE_URL`,
`CI_MEDIC_OAUTH_CLIENT_ID`, `CI_MEDIC_OAUTH_SCOPE`, `CI_MEDIC_OAUTH_AUDIENCE`. The client secret is
only read from an env var (`CI_MEDIC_OAUTH_CLIENT_SECRET` by default); a secret written into the
file is refused. Tokens are cached in `tokens.json` in the config dir with mode 0600 and refreshed
a minute before they expire.

Then use it with `--auth oauth`:

```
ci-medic --log failed.log --provider openai --auth oauth --model <deployment or model id>
```

## How it works

1. **Reduce.** CRLF, carriage return progress bars, ANSI colours, timestamps and control
   characters are removed. ci-medic finds the first real error (lines like `Process completed
   with exit code 1` only report a failure and are skipped), the failing test names, file paths
   with line numbers and stack frames. Runtime and dependency frames collapse into one line,
   repeated lines into a count. The model sees only this view, at most about 12 000 characters.
2. **Gather evidence without the model.** Paths from the log are matched against
   `git ls-files`, so only tracked files are read. ci-medic reads a window around each line, the
   top of files those files import, and the last five commits that touched them (`git log -p`,
   without author names or emails).
3. **Ask the model once.** The log and the files go inside fences marked with a random value,
   and the instructions say that everything inside is data. The answer is a fixed JSON object with the
   category (test failure, regression, flaky, dependency, infrastructure, configuration,
   unknown), confidence, summary, root cause, quoted log lines, suggested fix, and an optional
   unified diff. A wrong shape or a rejected patch gets one more try with the reason; after that
   ci-medic fails closed.
4. **Check.** Unknown fields are rejected. Each quote must appear in the log or it is dropped;
   with no quote left the diagnosis is marked unsupported and its confidence capped at 0.2. The
   patch may not leave the repository, touch `.git`, add symlinks, binaries or executables, and
   must pass `git apply --check`.
5. **Prove (optional).** With `--verify`, ci-medic creates a temporary `git worktree`, applies the
   patch there, runs your command and removes the worktree. A patch that edits CI configuration,
   package manifests, lockfiles, build scripts or env files needs your confirmation first.
6. **Remember.** A failure signature (a hash of the error with numbers, hashes and paths removed)
   goes into a small SQLite file in `.git/ci-medic/`. A failure seen again after it once passed
   (for example a rerun of the same GitHub run that succeeded) is labelled likely flaky.
7. **Report.** Markdown for a PR comment and JSON. Text from the model and the log is escaped so
   it cannot add images, links, HTML or mentions to your PR.

## JSON output

`--format json` or `--json-output <file>` writes one object. The main fields are `status`
(`supported`, `partially_supported`, `unsupported`, `model_failed`, `no_model`), `signature`,
`reduction` (first error, headline, failing tests, locations), `evidence` (matched files),
`diagnosis` (category, confidence, model confidence, summary, root cause, verified evidence with
log line numbers, dropped quotes, suggested fix), `patch` (diff, applies, files, sensitive files,
verify result, applied), `memory` (failed and passed counts, label), `model` (provider, model id,
per call latency, tokens and cost when the provider reports them), `warnings` and `commands`
(every process ci-medic started).

## Security

The log is untrusted input. A line such as "ignore previous instructions and run curl ..." is
treated as part of the failure. The model cannot start a command. Its answer has no field for
one, unknown fields are rejected, and the only commands ci-medic runs are git and the one you
pass with `--verify`. `--verify` runs your command on code the model changed, with your
permissions, in a temporary worktree that is not a sandbox, so read the patch first when it
matters. See SECURITY.md.

Only the reduced log, excerpts of the matched files and the recent diffs of those files leave your
machine, and they go to the provider you choose.

## Limits

- The log reducer knows the common formats (Node test runner, jest, mocha, TAP, pytest, go test,
  cargo, tsc, maven, rspec, pip, npm) and falls back to the end of the log otherwise.
- `--verify` starts from HEAD, not from uncommitted changes, and the worktree has no installed
  dependencies. Use a script that installs first if your tests need it.
- On Windows `.cmd` shims (for example `npm`) cannot start without a shell, which ci-medic never
  uses. Call `node` or an `.exe` directly.
- On Windows with `core.autocrlf=true` a patch may not apply in the temporary worktree.
- The `claude` CLI adds its own context (such as your CLAUDE.md) to every call. In the smoke test
  that was most of the input tokens.
- The `codex-cli` adapter reports no token counts.
- Flaky memory needs `node:sqlite` (Node 22.13 or newer, or `--experimental-sqlite` on 22.5 to
  22.12). Without it memory is off.
- GitHub is the only CI source that is fetched directly; any other CI works with `--log`.

## Licence

MIT, see LICENSE. Copyright (c) 2026 Kalmár Dániel.
