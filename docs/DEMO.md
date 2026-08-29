# ReproSmith Demo

## Local Full Check

```bash
pnpm install --frozen-lockfile
pnpm verify
```

Expected final demo status:

```text
awaiting-approval
```

The demo proves:

- Safe issue text passes security review.
- A malicious credential-exfiltration issue is quarantined.
- The same failure fingerprint reproduces 3/3 times.
- A candidate patch changes the target file.
- The reproducer passes after the patch.
- The regression command passes.
- The run pauses before GitHub mutation.

## Dashboard

Development:

```bash
pnpm dev
```

Production-style local run:

PowerShell:

```powershell
$env:PORT = "3000"
$env:DATA_DIR = ".data"
$env:APPROVAL_TOKEN = "replace-me"
$env:GITHUB_WEBHOOK_SECRET = "replace-me"
pnpm build
pnpm start
```

Bash:

```bash
PORT=3000 DATA_DIR=.data APPROVAL_TOKEN=replace-me GITHUB_WEBHOOK_SECRET=replace-me pnpm start
```

Open `http://127.0.0.1:3000`. The console has five evidence views: Overview,
Harness trace, Reproduction, Patch, and Security. Live runs show a TrueForge
session/turn, model provider, observed MCP calls, Daytona activity, bounded
command output, and the approval checkpoint. Fixture mode is labeled in the
header and is not production evidence.

## API Smoke Test

```bash
curl http://127.0.0.1:3000/healthz
curl http://127.0.0.1:3000/api/demo-run
```

Approval receipt:

```bash
curl -X POST http://127.0.0.1:3000/api/approvals \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer replace-me" \
  -d '{"runId":"demo-run","actionId":"approve-pr","patchHash":"ea26aee839ac"}'
```

## Live Integration Demo Requirements

Before claiming a live production demo, verify:

- GitHub App is installed on the target repo.
- `APPROVAL_TOKEN` is set and available only to maintainers.
- `GITHUB_WEBHOOK_SECRET` matches the GitHub App webhook secret.
- `TRUEFORGE_URL` and `TRUEFORGE_API_KEY` point at the deployed TrueForge service.
- The deployed TrueForge service sends AgentRouter's Cline-compatible `User-Agent` header.
- `DAYTONA_API_KEY` is valid if using Daytona-backed sandboxes.

For the current Railway deployment, the live test issue is
`https://github.com/MAYANK-MAHAUR/Byter/issues/22`. Its permanent run route is
`https://byter-production-1024.up.railway.app/runs/github-MAYANK-MAHAUR-Byter-22`.
Before approval, confirm the dashboard says that no branch or pull request has
been created. The latest progress comment on the issue should contain the same
run URL; earlier progress comments remain available as an append-only history.

Use the issue form in `.github/ISSUE_TEMPLATE/bug.yml` for a repeatable test.
When `REPROSMITH_REQUIRE_TRIGGER_LABEL=true`, only an issue with the configured
`reprosmith:run` label or the `/reprosmith run` marker starts a live run.
