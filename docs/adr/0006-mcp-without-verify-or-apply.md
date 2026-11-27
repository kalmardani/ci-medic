# ADR 0006. MCP server without verify or apply tools

## Status
Accepted, 2026-11-27

## Context
The MCP client is usually an agent driven by a model. A verify or apply tool there would let a
model choose the command or change files, which the project rules forbid.

## Decision
`ci-medic mcp` offers `triage_log`, `get_report` and `propose_patch`. Repository and log paths
must sit under the server working directory or `CI_MEDIC_MCP_ROOTS`. The provider comes from the
server's environment, not from tool arguments. Applying a proposed patch is done in a terminal
with `ci-medic apply --patch <file>`, which asks for confirmation.

## Consequences
+ An agent can triage and read the patch but cannot run or apply anything.
- A user who wants verification from an agent session must run the CLI.

## Confirmation
`test/interfaces.test.js` checks the tool list, the roots and that files stay unchanged.
