# Release Checklist

## Verified

- `pnpm install --frozen-lockfile`
- `pnpm verify`
- Fresh clone install and verify from `https://github.com/MAYANK-MAHAUR/Byter.git`
- GitHub Actions CI green on `main`
- Secret grep across tracked source and git history
- Production server smoke test
- Signed GitHub issues webhook route
- Authenticated approval receipt persistence with current-run validation
- Delivery deduplication for GitHub webhooks
- Bounded API request bodies
- Demo endpoint single-flight/cached execution
- Approval-gated GitHub MCP write tools
- Draft PR creation primitive using one Git tree/commit plus branch cleanup on PR failure

## Before Public Demo

- Push this audit branch and open a PR.
- Wait for CI, GitGuardian, and Qodo on the audit PR.
- Confirm final repository name: `Byter` vs `ByteHunter`.
- Deploy ReproSmith to Railway from this branch or merged `main`.
- Verify `/healthz`, `/api/demo-run`, and dashboard route on the Railway URL.
- Configure the GitHub App webhook URL to `/api/github/webhook`.
- Run one real signed GitHub issue webhook through the deployed server.
- Start one live TrueForge session from a real issue.
- Verify the deployed TrueForge fork sends AgentRouter's Cline-compatible `User-Agent` header.
- Verify Daytona sandbox creation if Daytona is part of the demo path.
- Approve one payload-specific GitHub MCP write and confirm a draft PR appears.

## Do Not Claim Until Verified

- Full live issue -> TrueForge -> sandbox -> 3/3 repro -> patch -> approval -> draft PR flow.
- Durable production database.
- Docker image build on a host with Docker or Railway build log success.
