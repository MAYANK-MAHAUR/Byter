# Railway Deployment

Byter includes `Dockerfile`, `.dockerignore`, and `railway.json`.

## Required Variables

Set these in Railway:

```text
NODE_ENV=production
PORT=3000
DATA_DIR=/data
APPROVAL_TOKEN=<secret>
MCP_AUTH_TOKEN=<secret>
MCP_PUBLIC_URL=https://<railway-domain>
MODEL_PROVIDER=agentrouter
# TrueForge model ID.
MODEL_NAME=glm-5.3
MODEL_BASE_URL=https://agentrouter.org/v1
MODEL_API_KEY=<secret>
GITHUB_TOKEN=<GitHub installation token or scoped token>
TRUEFORGE_URL=<deployed-trueforge-url>
TRUEFORGE_API_KEY=<secret>
DAYTONA_API_KEY=<secret>
GITHUB_APP_ID=<id>
GITHUB_PRIVATE_KEY=<pem-or-escaped-pem>
GITHUB_WEBHOOK_SECRET=<secret>
GITHUB_CLIENT_ID=<id>
GITHUB_CLIENT_SECRET=<secret>
APP_BASE_URL=https://<byter-railway-domain>
BYTER_REQUIRE_TRIGGER_LABEL=true
BYTER_TRIGGER_LABEL=byter:run
```

Do not commit real values.

The GitHub App installation or token must have repository access with `Issues:
Read and write` so the service can create progress comments and apply the
`byter:verified` label. `Contents: Read and write` and `Pull requests:
Read and write` are required only for the explicit maintainer-approved draft
PR path.

## Build

Railway should use:

- Builder: Dockerfile
- Dockerfile path: `Dockerfile`
- Health check path: `/healthz`

Local Docker build command when Docker is available:

```bash
docker build -t byter .
docker run --rm -p 3000:3000 --env-file .env.local byter
```

## Post-Deploy Smoke Test

```bash
curl https://<railway-domain>/healthz
curl https://<railway-domain>/api/runs/latest
curl https://<railway-domain>/api/demo-run
```

Configure the GitHub App webhook URL:

```text
https://<railway-domain>/api/github/webhook
```

Subscribe to GitHub `issues` and `issue_comment` events. The second event is
required for maintainer approvals from the issue page.

After setting `TRUEFORGE_URL` and `TRUEFORGE_API_KEY`, send one signed test issue delivery to `/api/github/webhook` and confirm the JSON response includes:

```json
{
  "run": { "status": "environment-building" },
  "trueForge": { "status": "started" }
}
```

If `trueForge.status` is `not-configured`, the server accepted and persisted the webhook but did not start live orchestration.

Refresh the dashboard after the signed delivery. The deployed server serves the built dashboard and its API from the same origin, so the dashboard reads `/api/runs/latest` and sends approvals to `/api/approvals` without a Vite mock layer. Each run also has `/api/runs/:runId` and `/runs/:runId` routes for reconnecting to a specific record. `/api/demo-run` is available only when the web build is explicitly configured with `VITE_BYTER_DATA_MODE=demo`.

The server creates append-only progress comments on the source issue when the
run starts, completes, fails, or receives a maintainer decision. Each comment
links to the permanent run route and never includes credentials, raw provider
events, or private model reasoning. After complete proof, the server also adds
the purple `byter:verified` label and the red
`byter:awaiting-approval` label using the configured GitHub write token.
The completion comment includes the proposed remedy, bounded file contents,
the patch hash, and an approval command. A repository maintainer can approve
the newest awaiting patch for that issue by posting this as a new issue comment:

```text
approve
```

The server verifies the signed webhook, maintainer permission, issue, run, and
stored patch hash before creating a draft pull request. GitHub receives one
editable Byter status comment; the verified state links to
`/runs/<run-id>/review`, where the maintainer can inspect the evidence, diff,
and tests before selecting `Approve & Resume`. The single-word `approve` form
remains accepted as an optional fallback for older comments. No branch,
commit, or pull request is created before approval succeeds.

For a separately hosted web build, set VITE_BYTER_API_URL=https://<railway-domain> at build time. For local Vite development, set BYTER_API_TARGET=http://127.0.0.1:8787 and run the production server on port 8787; the Vite server proxies API and MCP requests to it.

## Known Limits

The production server currently persists approval and webhook records as JSONL files under `DATA_DIR`. Use a mounted volume for demos. For longer-running production, replace this with Postgres or another durable store.

The deployed TrueForge service must handle AgentRouter's required Cline-compatible request headers on model-provider calls.

Set `BYTER_REQUIRE_TRIGGER_LABEL=true` to avoid starting a live run for
every issue. The issue form supplies `byter:run`; `/byter run` in the
issue body is also accepted as an explicit marker.

## TrueForge MCP setup

Configure the deployed TrueForge service with a remote MCP server named `byter-github`:

```text
URL: https://<railway-domain>/mcp
Authorization: Bearer <MCP_AUTH_TOKEN>
```

The Byter agent spec attaches that configured name and requires approval for write and destructive tools. Verify `POST /mcp` with an authenticated `initialize` and `tools/list` call before sending a real issue.
