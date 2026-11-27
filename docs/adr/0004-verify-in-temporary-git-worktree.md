# ADR 0004. Verify in a temporary git worktree, no sandbox

## Status
Accepted, 2026-11-27

## Context
The strongest proof of a patch is the user's own test command passing on the patched code. That
means running code the model changed. A real sandbox (container, VM) is not available on all
three platforms without dependencies.

## Decision
`--verify` creates `git worktree add --detach` under `os.tmpdir()`, applies the patch there, runs
the user's command as an argument array without a shell, with secrets removed from the
environment and a timeout, and removes the worktree in a `finally`. A patch that touches CI
configuration, manifests, lockfiles, build scripts or env files needs an explicit confirmation
before verification. The real working tree changes only through `--apply` after a yes.

## Consequences
+ Works the same on Windows, macOS and Linux with only git and Node.
- The verify command runs with the user's privileges. This is stated in README and SECURITY.md.
- The worktree has no installed dependencies and starts from HEAD.

## Confirmation
`test/triage.test.js` and `test/injection.test.js`, decision table rows in `test/units.test.js`.
