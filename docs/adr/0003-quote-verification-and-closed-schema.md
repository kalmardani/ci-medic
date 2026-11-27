# ADR 0003. Closed output schema and verbatim quote verification

## Status
Accepted, 2026-11-27

## Context
A diagnosis that sounds right but cites lines that are not in the log is worse than none,
because a reviewer trusts the quotes.

## Decision
The model answer is checked by a hand written schema that rejects unknown keys at every level.
Every evidence quote must appear in the normalised log as a substring of one line, after
whitespace is collapsed, and must have at least six non space characters. Quotes that fail are
dropped and counted. A diagnosis with no surviving quote is marked `unsupported` and its
confidence is capped at 0.2.

## Consequences
+ Every quote in a report is a real log line.
- A correct diagnosis whose quotes the model paraphrased is shown as unsupported. The prompt asks
  for verbatim lines to keep this rare.

## Confirmation
`test/units.test.js` and `test/triage.test.js`.
