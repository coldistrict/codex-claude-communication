# Codex + Claude collaboration

Local-first personal-alpha collaboration service implementing the approved
`collab-product-v3` blueprint.

## Run

```sh
npm ci
npm run build
npm start
```

Open the single-use loopback URL printed by `npm start`. The fragment is
exchanged for an HttpOnly, SameSite=Strict session and removed from browser
history. Starting a collaboration performs metadata-only billing preflight
first. No provider turn starts unless both routes are proven as either
`subscription_allowance` or `existing_credits`.

The product uses:

- the pinned Codex app-server over JSON-RPC/stdio;
- `@anthropic-ai/claude-agent-sdk` and its project-local bundled runtime;
- no global Claude CLI, API key, Console PAYG, cloud-provider route, custom
  base URL, credit purchase, top-up, or reset-credit method.

## Claude subscription login prerequisite

If the dashboard reports `claude.subscription_oauth_unavailable`, the user
must complete the official interactive subscription login:

```sh
npm run login:claude
```

This launches the runtime bundled with the pinned Agent SDK. It never asks for
an Anthropic API key. After login, select **Retry preflight** in the dashboard.

## Verification

```sh
npm run verify:pins
npm test
npm run verify:zero-call
npm run doctor
npm run verify:all
```

V-0 through V-12 use deterministic fake adapters and must report zero model
starts. V-13 requires a short-lived, current-session authorization file and is
never run by `verify:all`.

See [docs/implementation-handoff.md](docs/implementation-handoff.md) for the
complete architecture, observed results, deviations, and review handoff.
