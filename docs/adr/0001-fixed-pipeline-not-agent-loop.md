# ADR 0001. A fixed pipeline with one model step, not an agent loop

## Status
Accepted, 2026-11-27

## Context
ci-medic reads hostile text (CI logs, repository content) and has access to private code and to
command execution. An agent loop that lets the model choose tools would put private data, hostile
input and an action channel in one context.

## Decision
The order of steps is fixed in `src/triage.js`. The model is called once, with at most one repair
round, and returns a closed JSON object. It cannot choose a file to read, a command to run or an
action to take. Code decides every side effect from the decision table in DEVELOPER.md.

## Consequences
+ Prompt injection in the log cannot start a process or change the working tree.
+ Cost is bounded at two calls per run.
- The model cannot ask for a file the deterministic evidence step did not pick. Missing evidence
  shows up as a low confidence or an `unknown` category.

## Confirmation
`test/injection.test.js` scripts the model to obey an injection and checks the recorded process
list.
