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
- TrueForge runtime adapter with sandbox and dynamic subagent configuration
- reproduction runner with timeouts, output limits, and secret-safe environment filtering
- failure fingerprinting, repeated verification, and input minimization
- patch validator with protected reproducer files, symlink defense, and regression checks
- React dashboard for run timeline, evidence, security quarantine, and approval controls
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

```bash
pnpm dev
```

Open the Vite URL printed by the command, usually `http://127.0.0.1:5173`.

The dashboard is a local console for the same proof path: timeline, reproduction evidence, patch validation, approval payload hash, and quarantine findings.

In development, the dashboard calls the local Vite API:

- `GET /api/demo-run` executes the demo runner and returns freshly generated proof data.
- `POST /api/approvals` records the selected approval action without mutating GitHub.

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
- `GITHUB_APP_ID`, `GITHUB_PRIVATE_KEY`, `GITHUB_WEBHOOK_SECRET`

When using AgentRouter through a deployed TrueForge service, make sure that service sends AgentRouter's required request headers.

## Repository Layout

```text
apps/demo-runner    Local end-to-end proof runner
apps/github-mcp     Narrow GitHub MCP-style read/write boundary
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
