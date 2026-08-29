# ReproSmith Release Audit

Audit date: 2026-08-28
Branch audited: `chore/release-readiness-audit`
Base remote observed: `https://github.com/MAYANK-MAHAUR/Byter.git`

## Verdict

Status: PARTIALLY VERIFIED

ReproSmith is no longer just a static mock dashboard. The repository now has a production Node server, live local API data, signed GitHub issues webhook intake, optional webhook-to-TrueForge session handoff, persisted approval receipts, an authenticated remote MCP transport, and an approval-gated MCP tool that can create a fix branch and draft pull request when wired to GitHub credentials.

It is not honestly production-complete yet. Live TrueForge execution, AgentRouter header behavior inside the deployed TrueForge fork, Daytona sandbox execution, Railway deployment, and a real GitHub issue -> webhook -> TrueForge session -> draft PR run were not verified in this audit environment.

## What TrueForge Is

TrueForge is the agent harness/runtime around the AI model. It is not AgentRouter and it is not the model itself. ReproSmith uses TrueForge as the orchestration layer that owns agent sessions, turns, tool calls, sandbox access, subagents, approvals, events, and state.

Sources checked:

- https://www.truefoundry.com/docs/agent-platform/agent-harness/overview
- https://trueforge.dev/introduction
- https://github.com/truefoundry/trueforge

AgentRouter is the model gateway. The user-provided TrueForge fork is expected to add AgentRouter's required Cline-compatible `User-Agent` header on model-provider requests. That behavior lives in the TrueForge service/fork, not in ReproSmith's TrueForge client call.

## Repository Identity

Status: PARTIALLY VERIFIED

Observed local remote is `MAYANK-MAHAUR/Byter`, while the pasted release brief names `MAYANK-MAHAUR/ByteHunter`. I did not switch to another repository because the user explicitly said the old repo was deleted and not to use older history.

Evidence:

- `git remote -v` returned `https://github.com/MAYANK-MAHAUR/Byter.git`.
- `git status --short --branch` returned clean `main...origin/main` before the audit branch was created.
- No open PRs were present before this audit branch.

## Build And Test Evidence

Status: VERIFIED

Commands run locally:

- `pnpm install --frozen-lockfile` passed.
- `pnpm verify` passed after the production server, webhook route, failed state, and draft PR MCP changes.
- Fresh clone from `https://github.com/MAYANK-MAHAUR/Byter.git` into `D:\Temp\reprosmith-audit-20260828-180933\reprosmith` passed `pnpm install --frozen-lockfile` and `pnpm verify` on the then-current `main`.

CI evidence:

- GitHub Actions CI on `main` commit `34d71ad2f1df813bf14667f900dd28783e9cdeea` completed successfully on 2026-08-28.
- Run URL: https://github.com/MAYANK-MAHAUR/Byter/actions/runs/33171430973

## Feature Verification Matrix

| Area | Status | Evidence |
| --- | --- | --- |
| Monorepo bootstrap | VERIFIED | 10 workspace projects install with frozen lockfile. |
| State machine | VERIFIED | Added terminal `failed`; tests cover valid failure transition and no exit from failed. |
| Security scanner | VERIFIED | Tests cover ordinary issue, credential exfiltration, destructive shell, Windows format command, and prompt injection detection. |
| GitHub webhook verification | VERIFIED | HMAC verification tests pass; production server route rejects invalid signatures. |
| GitHub webhook intake route | VERIFIED | `POST /api/github/webhook` accepts signed `issues` events, scans text, transitions to `triaging`, `environment-building`, `failed`, or `rejected`, and persists JSONL when `DATA_DIR` is set. |
| GitHub MCP reads | VERIFIED | `read_issue` and `read_file` are tested through a narrow client boundary and exposed through the authenticated JSON-RPC `/mcp` transport. |
| GitHub MCP writes | PARTIALLY VERIFIED | Label/comment/draft-PR tools require payload-specific approval hashes, are exposed through `/mcp`, and pass mocked-client plus protocol tests. Live GitHub mutation was not run. |
| Draft PR creation primitive | VERIFIED | GitHub client can get base branch, create one Git tree/commit, point a branch at that commit, open a draft PR, and clean up the branch if PR creation fails; tests assert REST paths and payloads. |
| TrueForge adapter | PARTIALLY VERIFIED | SDK adapter builds agent specs with sandbox/subagents/MCP, preloads the configured GitHub MCP server, requires write approval, and creates sessions in mocked SDK tests. Production webhook handoff is tested with an injected runtime. No live TrueForge session was created. |
| AgentRouter header compatibility | PARTIALLY VERIFIED | Direct AgentRouter smoke request with `User-Agent: Cline/3.0.0` succeeded. Could not verify the deployed TrueForge fork sends that header internally. |
| Reproduction verifier | VERIFIED | 3/3 same-fingerprint reproduction and flaky/not-reproduced classification are tested. |
| Patch validation | VERIFIED | Before-fail/after-pass/regression-pass path is tested with symlink and protected-path defenses. |
| Minimization | VERIFIED | Reproducer minimization has focused tests. |
| Dashboard data | VERIFIED | Web prefers `/api/runs/latest` for persisted GitHub webhook runs and falls back to `/api/demo-run`; no old static `demoRun` fixture remains in `apps/web/src`. |
| Production server | VERIFIED | `/healthz`, static dashboard, `/api/demo-run`, `/api/runs/latest`, `/api/approvals`, and `/api/github/webhook` were probed locally on `http://127.0.0.1:4180`. |
| Approval persistence | PARTIALLY VERIFIED | Approval receipts require bearer auth and current-run validation, then persist to JSONL with `DATA_DIR`; this is not a database. |
| Dockerfile | PARTIALLY VERIFIED | Dockerfile and `.dockerignore` exist; local `docker --version` failed because Docker is not installed. |
| Railway config | PARTIALLY VERIFIED | `railway.json` uses Dockerfile builder and `/healthz`; no live Railway deployment was performed. |
| Daytona sandbox | BLOCKED BY USER ACTION | No Daytona API key or live sandbox execution was available. Local command runner is tested. |
| Qodo | PARTIALLY VERIFIED | Qodo found no actionable issues on PRs #13 and #14; later reviews are billing-blocked after the trial ended. |
| Secrets | VERIFIED | `.env.local` is ignored. Tracked-source grep and git-history grep for common key patterns returned no matches. |

## Production Server Evidence

Server start used:

```bash
pnpm build
PORT=4180 DATA_DIR=<temp> GITHUB_WEBHOOK_SECRET=<test-secret> pnpm start
```

Endpoint probes:

- `GET /healthz` returned `{"ok":true}`.
- `GET /` returned HTTP 200 and dashboard root HTML.
- `GET /api/demo-run` returned run status `awaiting-approval`, validation status `patch-ready`, patch hash `ea26aee839ac`, and quarantined malicious issue `safeToExecute=false`.
- `POST /api/approvals` without bearer auth returned HTTP 401.
- `POST /api/approvals` with bearer auth returned `approved` and persisted an approval receipt.
- `POST /api/github/webhook` with a valid test signature and delivery ID returned run status `triaging` and persisted webhook evidence.
- Repeating the same webhook delivery ID returned duplicate ignored response.

## TrueForge And AgentRouter Evidence

Status: PARTIALLY VERIFIED

- `.env.local` contains a model API key and TrueForge URL/token, but no Daytona key or GitHub App credentials.
- Direct AgentRouter smoke request with `User-Agent: Cline/3.0.0` completed successfully on 2026-08-28. The API response content was empty, so this proves request acceptance/connectivity, not answer quality.
- TrueForge SDK session-create smoke test failed with `ECONNREFUSED` against `localhost:8000`. That indicates the local `.env.local` TrueForge URL is not the deployed Railway service.
- No live TrueForge turn was created.

## External Blockers

Status: BLOCKED BY USER ACTION

These cannot be honestly verified from this local workspace without external state:

- Deployed TrueForge Railway URL and API token.
- Proof that deployed TrueForge sends AgentRouter's required Cline-compatible `User-Agent` header internally.
- Daytona API key and live sandbox session.
- GitHub token or GitHub App installation credentials for the remote `/mcp` transport.
- GitHub App installation on the final target repository.
- A real target GitHub issue to drive through webhook -> TrueForge -> proof -> approval -> draft PR.
- Docker runtime on this machine, or a remote build log from Railway.

## Release Recommendation

Do not label the project as fully production complete yet. It is a strong, verified vertical slice plus production-serving scaffolding. The next honest milestone is a live integration run against the deployed TrueForge service and a real GitHub App installation.
