# Actions Required From Repository Owner

## GitHub App

Need:

- GitHub App ID.
- Private key.
- Webhook secret.
- Client ID and client secret if OAuth installation flow is required.

Where:

- Store real values only in `.env.local` or deployment secrets.
- Keep placeholders only in `.env.example`.

## TrueForge

Need:

- Confirm the official TrueForge server/runtime setup for the hackathon environment.
- Provide `TRUEFORGE_URL` and `TRUEFORGE_API_KEY` if the local/runtime setup requires them.

## Daytona

Need:

- Daytona API key or documented TrueForge sandbox configuration.

## Qodo

Need:

- Qodo posted a trial-expiring notice on recent PRs.
- Repository owner should confirm billing/trial status so review comments keep running through the submission window.

## Demo Issues

Need:

- Four controlled GitHub issues when integrations are ready:
- deterministic bug,
- insufficient report,
- malicious report,
- non-reproduced report.
