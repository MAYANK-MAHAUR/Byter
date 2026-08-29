# ReproSmith

CI for bug reports. ReproSmith makes an AI agent prove a reported bug with executable evidence before it can claim the bug is real or write back to GitHub.

## What It Does

ReproSmith is a TrueForge-oriented bug reproduction harness for GitHub issues. It turns an issue report into a controlled run:

1. Receive and scan the issue text for unsafe instructions.
2. Read repository context through a narrow GitHub MCP boundary.
3. Build a disposable reproduction workspace.
4. Verify the same target failure across repeated runs.
5. Minimize the failing input when possible.
6. Validate a candidate patch with before, after, and regression commands.
7. Pause for maintainer approval before any GitHub write.

The local demo intentionally stops at `awaiting-approval`; no GitHub labels, comments, branches, or pull requests are created by the demo command.

## Current Build

The hackathon vertical slice is complete:

- pnpm monorepo with shared TypeScript types and project references
- deterministic ReproSmith state machine
- GitHub App auth, webhook verification, REST client, and MCP-style tools
- signed GitHub issues webhook endpoint in the production server
- TrueForge runtime adapter with sandbox and dynamic subagent configuration
- optional webhook-to-TrueForge session handoff when `TRUEFORGE_URL` and `TRUEFORGE_API_KEY` are configured
- reproduction runner with timeouts, output limits, and secret-safe environment filtering
- failure fingerprinting, repeated verification, and input minimization
- patch validator with protected reproducer files, symlink defense, and regression checks
- React dashboard for live persisted runs, evidence, security quarantine, and approval controls
- production Node server for dashboard/API serving, receipt persistence, and Railway health checks
- local end-to-end demo runner
- GitHub Actions CI running the full workspace verification

## Quick Start

```bash
pnpm install
pnpm verify
```

`pnpm verify` runs build, lint, typecheck, tests, and the local end-to-end demo. This is the same command used by CI.

## Demo

```bash
pnpm demo:e2e
```

The demo creates a disposable parser workspace, scans a safe issue and a quarantined issue, verifies the seeded `TypeError` three times, applies a candidate fix, runs regression proof, and prints structured JSON evidence.

Expected final status:

```text
awaiting-approval
```

## Dashboard
Use the two-terminal setup below to run the dashboard against the real ReproSmith server.

Open the Vite URL printed by the command, usually http://127.0.0.1:5173.

The dashboard is a console for the same proof path: timeline, reproduction evidence, patch validation, approval payload hash, and quarantine findings. It runs in live mode by default, so it reads persisted webhook runs and sends approval actions to the ReproSmith server.

For a production-style local run, start the server and dashboard in separate terminals:

~~~powershell
pnpm build

$env:PORT="8787"
$env:DATA_DIR=".data-local"
$env:APPROVAL_TOKEN="local-approval"
pnpm --filter @reprosmith/server start
~~~

~~~powershell
$env:REPROSMITH_API_TARGET="http://127.0.0.1:8787"
pnpm dev
~~~

The Vite server proxies /api and /mcp to the real backend. Set VITE_REPROSMITH_API_URL when the web console is hosted separately from the API. To intentionally preview generated proof data, set VITE_REPROSMITH_DATA_MODE=demo; demo mode is opt-in and still calls the server's /api/demo-run endpoint.

## Environment

Copy `.env.example` to `.env.local` for local secrets:

```bash
cp .env.example .env.local
```

Do not commit `.env.local`.

Key variables:

- `MODEL_PROVIDER`, `MODEL_NAME`, `MODEL_BASE_URL`, `MODEL_API_KEY`
- `TRUEFORGE_URL`, `TRUEFORGE_API_KEY`
- `DAYTONA_API_KEY`
- REPROSMITH_API_TARGET for the local Vite proxy
- VITE_REPROSMITH_API_URL and VITE_REPROSMITH_DATA_MODE for the web console
- APPROVAL_TOKEN, MCP_AUTH_TOKEN, MCP_PUBLIC_URL
- `GITHUB_TOKEN` for the authenticated remote MCP transport
- `GITHUB_APP_ID`, `GITHUB_PRIVATE_KEY`, and `GITHUB_INSTALLATION_ID` are reserved for GitHub App token exchange
- `DATA_DIR` for server-side JSONL receipt/run persistence

When using AgentRouter through a deployed TrueForge service, make sure that service sends AgentRouter's required request headers.

## Repository Layout

```text
apps/demo-runner    Local end-to-end proof runner
apps/github-mcp     Narrow GitHub MCP-style read/write boundary
apps/server         Production Node server for dashboard APIs and webhooks
apps/web            React dashboard console
demo/buggy-parser   Seeded parser fixture
packages/agent      TrueForge runtime adapter and agent prompt
packages/core       Shared types, state machine, security scanner
packages/github     GitHub App auth, webhook, REST client
packages/repro-engine Reproduction, fingerprinting, minimization, patch proof
```

## Safety Model

ReproSmith treats issue text as untrusted input. The scanner blocks credential exfiltration and destructive shell requests, records prompt-injection attempts, and the runtime instructions require a human approval checkpoint before GitHub mutations. Patch validation copies work into a temporary workspace and rejects changes to protected reproducer files.

## Useful Commands

```bash
pnpm build
pnpm lint
pnpm typecheck
pnpm test
pnpm demo:e2e
pnpm dev
```

## Status

Built as a fresh hackathon implementation for the TrueForge Agent Harness Hackathon.


To connect TrueForge to the live GitHub tools, configure its `reprosmith-github` MCP server with the Railway `${MCP_PUBLIC_URL}/mcp` URL and a header auth value of `Authorization: Bearer <MCP_AUTH_TOKEN>`. The TrueForge agent spec requires write-tool approval before the remote transport invokes a mutation.
