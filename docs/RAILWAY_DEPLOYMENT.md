# Railway Deployment

ReproSmith includes `Dockerfile`, `.dockerignore`, and `railway.json`.

## Required Variables

Set these in Railway:

```text
NODE_ENV=production
PORT=3000
DATA_DIR=/data
APPROVAL_TOKEN=<secret>
MODEL_PROVIDER=agentrouter
MODEL_NAME=glm-5.3
MODEL_BASE_URL=https://agentrouter.org/v1
MODEL_API_KEY=<secret>
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
curl https://<railway-domain>/api/demo-run
```

Configure the GitHub App webhook URL:

```text
https://<railway-domain>/api/github/webhook
```

Subscribe to GitHub `issues` events.

## Known Limits

The production server currently persists approval and webhook records as JSONL files under `DATA_DIR`. Use a mounted volume for demos. For longer-running production, replace this with Postgres or another durable store.

The deployed TrueForge service must handle AgentRouter's required Cline-compatible request headers on model-provider calls.
