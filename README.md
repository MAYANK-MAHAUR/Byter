# Byter

CI for bug reports. Byter makes an AI agent prove a reported bug with executable evidence before it can claim the bug is real or write back to GitHub.

## What It Does

Byter is a TrueForge-oriented bug reproduction harness for GitHub issues. It turns an issue report into a controlled run:

1. Receive and scan the issue text for unsafe instructions.
2. Read repository context through a narrow GitHub MCP boundary.
3. Build a disposable reproduction workspace.
4. Verify the same target failure across repeated runs.
5. Minimize the failing input when possible.
6. Validate a candidate patch with before, after, and regression commands.
7. Pause for maintainer approval before any GitHub write.

The local demo intentionally stops at `awaiting-approval`; no GitHub labels, comments, branches, or pull requests are created by the demo command.

## Current Build

The hackathon vertical slice includes a live TrueForge path and a separate
deterministic fixture mode:

- pnpm monorepo with shared TypeScript types and project references
- deterministic Byter state machine
- GitHub App auth, webhook verification, REST client, and MCP-style tools
- signed GitHub issues webhook endpoint in the production server
- TrueForge runtime adapter with sandbox and dynamic subagent configuration
- optional webhook-to-TrueForge session handoff when `TRUEFORGE_URL` and `TRUEFORGE_API_KEY` are configured
- reproduction runner with timeouts, output limits, and secret-safe environment filtering
- failure fingerprinting, repeated verification, and input minimization
- patch validator with protected reproducer files, symlink defense, and regression checks
- React dashboard with an always-visible TrueForge harness panel, readable trace tabs, reproduction proof, candidate patch, security review, and approval controls
- production Node server for dashboard/API serving, receipt persistence, and Railway health checks
- append-only GitHub progress comments per live run with a permanent `/runs/:runId` dashboard URL
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

## How TrueForge Fits

TrueForge is the agent harness around the model. AgentRouter is the model
gateway, GitHub MCP is the repository boundary, and Daytona is the disposable
execution environment. Byter owns the signed webhook, security scan,
approval checkpoint, run record, and dashboard.

```text
GitHub issue
    |
    v
Byter server -- signed intake + security scan -- GitHub progress comments
    |
    v
TrueForge session / turn -- AgentRouter model
    |                         |
    |                         +--> GitHub MCP reads
    +--> Daytona sandbox ----> bounded commands and proof
    |
    v
proof + candidate patch -- maintainer approval -- GitHub MCP draft PR write
```

The dashboard exposes high-level agent actions, tool names, files, sandbox
commands, bounded stdout/stderr, proof, and approval state. It deliberately
does not expose private chain-of-thought. Live webhook data is labeled as a
persisted run; `/api/demo-run` and the fixture trace are labeled as demo data.

## Dashboard
Use the two-terminal setup below to run the dashboard against the real Byter server.

Open the Vite URL printed by the command, usually http://127.0.0.1:5173.

The dashboard is a console for the same proof path: TrueForge session identity,
agent activity, MCP calls, Daytona commands, timeline, reproduction evidence,
candidate patch, security findings, GitHub progress comments, verified label, and approval state.
It runs in live mode by default, so it reads persisted webhook runs and sends
approval actions to the Byter server. A URL such as
`/runs/github-MAYANK-MAHAUR-Byter-22` reconnects to that specific persisted run.

For a production-style local run, start the server and dashboard in separate terminals:

~~~powershell
pnpm build

$env:PORT="8787"
$env:DATA_DIR=".data-local"
$env:APPROVAL_TOKEN="local-approval"
pnpm --filter @byter/server start
~~~

~~~powershell
$env:BYTER_API_TARGET="http://127.0.0.1:8787"
pnpm dev
~~~

The Vite server proxies /api and /mcp to the real backend. Set VITE_BYTER_API_URL when the web console is hosted separately from the API. To intentionally preview generated proof data, set VITE_BYTER_DATA_MODE=demo; demo mode is opt-in and still calls the server's /api/demo-run endpoint.

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
- BYTER_API_TARGET for the local Vite proxy
- VITE_BYTER_API_URL and VITE_BYTER_DATA_MODE for the web console
- APPROVAL_TOKEN, MCP_AUTH_TOKEN, MCP_PUBLIC_URL
- `APP_BASE_URL` for permanent GitHub progress-comment links
- `BYTER_REQUIRE_TRIGGER_LABEL` and `BYTER_TRIGGER_LABEL` for explicit issue triggering
- `GITHUB_TOKEN` for the authenticated remote MCP transport
- GitHub access requires `Issues: Read and write` for progress comments and the `byter:verified` label; `Contents` and `Pull requests` write access is only used after maintainer approval for a draft PR
- `GITHUB_APP_ID`, `GITHUB_PRIVATE_KEY`, and `GITHUB_INSTALLATION_ID` are reserved for GitHub App token exchange
- `DATA_DIR` for server-side JSONL receipt/run persistence

When using AgentRouter through a deployed TrueForge service, make sure that service sends AgentRouter's required request headers, including `User-Agent: Cline`.

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

Byter treats issue text as untrusted input. The scanner blocks credential exfiltration and destructive shell requests, records prompt-injection attempts, and the runtime instructions require a human approval checkpoint before GitHub mutations. Patch validation copies work into a temporary workspace and rejects changes to protected reproducer files. Harness output is bounded and redacted before persistence. Progress comments are operational run receipts; the verified label is added only after complete proof, while branches, commits, and pull requests remain approval-gated.

## Live Evidence

The deployed Railway integration has been exercised with the current `Byter`
repository. Issue `#22` reached a real TrueForge session, Daytona sandbox
initialization, proof completion, and `awaiting-approval` without a branch or
pull request. Earlier approved run `#21` created draft PR `#21`. These are live
integration records, while the local demo remains fixture data.

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


To connect TrueForge to the live GitHub tools, configure its `byter-github` MCP server with the Railway `${MCP_PUBLIC_URL}/mcp` URL and a header auth value of `Authorization: Bearer <MCP_AUTH_TOKEN>`. The TrueForge agent spec requires write-tool approval before the remote transport invokes a mutation. Byter's server owns the final approval checkpoint and records the resulting GitHub MCP receipt in the run trace.
