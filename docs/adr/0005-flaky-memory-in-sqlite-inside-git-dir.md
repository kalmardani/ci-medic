# ADR 0005. Flaky memory in node:sqlite inside the git directory

## Status
Accepted, 2026-11-27

## Context
Repeated identical failures that later passed point to flaky tests. That needs a small local
store. The platform rules forbid dependencies.

## Decision
`node:sqlite` with two tables, `failures` and `outcomes`. Counts come from `outcomes`, which has a
unique key on signature, outcome and source, so the same run counted twice stays one. The default
file is `.git/ci-medic/memory.sqlite` (the git common dir), so it is never committed and never
touches the working tree. Where `node:sqlite` is missing (Node 22.5 to 22.12 without the flag)
memory is off with a warning.

## Consequences
+ No new dependency, no file in the working tree.
- Memory is per clone, not shared across a team.

## Confirmation
`test/triage.test.js` and `test/interfaces.test.js` memory tests.
