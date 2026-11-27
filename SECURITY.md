# Security policy

## Reporting a vulnerability

Please report security problems privately through GitHub's "Report a vulnerability" form on the
repository's Security tab, not in a public issue. Include the version, the command you ran and a
log or patch that shows the problem, with secrets removed. You will get an answer within a week.

## Supported versions

Only the latest 0.x release gets fixes.

## Threat model summary

ci-medic reads hostile text (CI logs, repository content, model answers), talks to the model
provider you choose, runs git, and runs one command only when you pass `--verify`.

| Risk | What ci-medic does |
|---|---|
| Prompt injection in the log or the code | The model only fills a closed JSON object with no command field. Unknown fields are rejected. Data sits in fences the log cannot close. Only git and your `--verify` command ever run |
| Fabricated evidence | Every quoted log line is looked up in the log; unknown quotes are dropped and unsupported diagnoses are capped |
| A patch that escapes the repository or edits git internals | Absolute paths, `..`, `.git/`, symlinks, binaries, executables, renames and more than 20 files are refused |
| A patch that edits the test script or CI config, then gets run by `--verify` | Files that control builds or dependencies need an explicit confirmation before verification or apply |
| Exfiltration through the PR comment (an image URL that carries code) | Markdown and HTML in model and log text are escaped, mentions are broken, fences cannot be closed |
| Secrets | API keys, OAuth tokens and `GITHUB_TOKEN` are never printed. The verify command runs with secret looking env vars removed. The GitHub token is not forwarded to the signed log URL. The OAuth token cache is mode 0600 |
| OAuth sign in hijack | PKCE S256, random `state` checked, loopback on 127.0.0.1 only, one callback accepted, five minute timeout |
| Agents through MCP | No verify or apply tool; repository and log paths are limited to allowed roots |
| Local git configuration | Hooks are disabled for git calls, no external diff or pager, no terminal prompt |

## Known limits

`--verify` executes code the model changed, with your privileges. The temporary worktree is not a
sandbox. Read the patch before you verify it on a machine that holds sensitive data.

The reduced log, matched file excerpts and recent diffs of those files are sent to the model
provider. Choose a provider whose data handling fits your code.

ci-medic uses a vendor subscription only by starting that vendor's official CLI. It never reads
the credentials those CLIs store.
