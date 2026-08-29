# Release Checklist

## Verified

- `pnpm install --frozen-lockfile`
- `pnpm verify`
- Fresh clone install and verify from `https://github.com/MAYANK-MAHAUR/Byter.git`
- GitHub Actions CI green on `main`
- Secret grep across tracked source and git history
- Production server smoke test
- Signed GitHub issues webhook route
- Dashboard prefers the latest persisted webhook run and falls back to generated demo proof only when no live run exists
- Authenticated remote GitHub MCP transport exposes initialize, tools/list, and tools/call
- Authenticated approval receipt persistence with current-run validation
- Delivery deduplication for GitHub webhooks
- Optional webhook-to-TrueForge session handoff path, tested with an injected runtime
- Bounded API request bodies
- Demo endpoint single-flight/cached execution
- Approval-gated GitHub MCP write tools
- Draft PR creation primitive using one Git tree/commit plus branch cleanup on PR failure
- Bounded TrueForge harness trace projection with redacted output
- Run-specific dashboard route and GitHub progress comment lifecycle
- Issue form with explicit `reprosmith:run` trigger support

## Before Public Demo

- Push `feat/harness-visibility` and open a PR.
- Wait for CI, GitGuardian, and Qodo on the audit PR.
- Confirm final repository name: `Byter` vs `ByteHunter`.
- Deploy ReproSmith to Railway from this branch or merged `main`.
- Verify `/healthz`, `/api/runs/latest`, `/api/demo-run`, and dashboard route on the Railway URL.
- Configure the GitHub App webhook URL to `/api/github/webhook`.
- Run one real signed GitHub issue webhook through the deployed server.
- Confirm the deployed webhook response includes a started TrueForge session and turn.
- Verify TrueForge can initialize `/mcp`, discover `reprosmith-github` tools, and complete one read-only tool call.
- Verify the deployed TrueForge fork sends AgentRouter's Cline-compatible `User-Agent` header.
- Verify Daytona sandbox creation if Daytona is part of the demo path.
- Approve one payload-specific GitHub MCP write and confirm a draft PR appears.
- Refresh the permanent run URL while the run is active and after approval.
- Confirm each meaningful lifecycle update creates a new GitHub progress comment; no prior comment is edited.
- Confirm the Harness trace contains only bounded, redacted evidence.

## Do Not Claim Until Verified

- Full live issue -> TrueForge -> sandbox -> 3/3 repro -> patch -> approval -> draft PR flow.
- Durable production database.
- Docker image build on a host with Docker or Railway build log success.
- Genuine in-turn TrueForge pause/resume; the current implementation uses a server-side approval checkpoint before the approved MCP write.
