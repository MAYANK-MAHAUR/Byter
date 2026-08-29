# Railway Deployment

ReproSmith includes `Dockerfile`, `.dockerignore`, and `railway.json`.

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
```

Do not commit real values.

## Build

Railway should use:

- Builder: Dockerfile
- Dockerfile path: `Dockerfile`
- Health check path: `/healthz`

Local Docker build command when Docker is available:

```bash
docker build -t reprosmith .
docker run --rm -p 3000:3000 --env-file .env.local reprosmith
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

Subscribe to GitHub `issues` events.

After setting `TRUEFORGE_URL` and `TRUEFORGE_API_KEY`, send one signed test issue delivery to `/api/github/webhook` and confirm the JSON response includes:

```json
{
  "run": { "status": "environment-building" },
  "trueForge": { "status": "started" }
}
```

If `trueForge.status` is `not-configured`, the server accepted and persisted the webhook but did not start live orchestration.

Refresh the dashboard after the signed delivery. The deployed server serves the built dashboard and its API from the same origin, so the dashboard reads /api/runs/latest and sends approvals to /api/approvals without a Vite mock layer. /api/demo-run is available only when the web build is explicitly configured with VITE_REPROSMITH_DATA_MODE=demo.

For a separately hosted web build, set VITE_REPROSMITH_API_URL=https://<railway-domain> at build time. For local Vite development, set REPROSMITH_API_TARGET=http://127.0.0.1:8787 and run the production server on port 8787; the Vite server proxies API and MCP requests to it.

## Known Limits

The production server currently persists approval and webhook records as JSONL files under `DATA_DIR`. Use a mounted volume for demos. For longer-running production, replace this with Postgres or another durable store.

The deployed TrueForge service must handle AgentRouter's required Cline-compatible request headers on model-provider calls.

## TrueForge MCP setup

Configure the deployed TrueForge service with a remote MCP server named `reprosmith-github`:

```text
URL: https://<railway-domain>/mcp
Authorization: Bearer <MCP_AUTH_TOKEN>
```

The ReproSmith agent spec attaches that configured name and requires approval for write and destructive tools. Verify `POST /mcp` with an authenticated `initialize` and `tools/list` call before sending a real issue.
