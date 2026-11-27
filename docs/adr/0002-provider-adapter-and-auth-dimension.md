# ADR 0002. Provider adapter and auth as two dimensions in one module

## Status
Accepted, 2026-11-27

## Context
Users connect with an API key, through an OAuth protected gateway, or with their own subscription
of a vendor. Subscriptions may only be used through the vendor's official CLI.

## Decision
`src/model/provider.js` resolves an adapter (`openai`, `anthropic`, `claude-cli`, `codex-cli`,
`fake`, `none`) and an auth kind (`api-key`, `oauth`, `subscription`, `none`). HTTP adapters take
`api-key` or `oauth`. CLI adapters take only `subscription` and run the official CLI as a
subprocess. ci-medic never reads, copies or forwards the credentials those CLIs store, and never
calls a vendor API with a consumer subscription token. The OAuth client is generic and has
three grants (client credentials, authorization code with PKCE on a loopback redirect, device
authorization) with a 0600 token cache in the per user config dir.

## Consequences
+ The rest of the code sees only `complete({system, user})`.
+ Adding a provider touches one adapter file and the switch in `provider.js`.
- The CLI adapters inherit whatever context the vendor CLI adds to each call.

## Confirmation
`test/providers.test.js` checks the combination rules; `test/oauth.test.js` checks the grants
against a local fake token server.
