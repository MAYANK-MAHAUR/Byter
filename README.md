# Byter

**CI for bug reports.** Byter turns a GitHub issue into executable proof, a tested candidate fix, and a human-controlled draft pull request.

[Live app](https://byter-production-1024.up.railway.app/) · [Verified run](https://byter-production-1024.up.railway.app/runs/github-MAYANK-MAHAUR-Byter-32-8fd16ca98fd2) · [Source issue](https://github.com/MAYANK-MAHAUR/Byter/issues/32) · [Build story](docs/BLOG.md)

![Byter showing a live TrueForge investigation](docs/images/byter-live-overview.png)

## Why Byter

Large repositories receive more bug reports than maintainers can manually reproduce. Byter gives each report the same evidence-first path:

1. Scan the issue as untrusted input.
2. Read scoped repository context through GitHub MCP.
3. Reproduce the failure repeatedly in a disposable Daytona sandbox.
4. Generate a minimal patch and run before, after, and regression checks.
5. Pause before any branch, commit, or pull request is created.
6. Continue only when a maintainer approves on the dashboard or replies `approve` on GitHub.

## TrueForge In The Loop

TrueForge is the durable harness behind every live run. It starts the model turn, connects the GitHub MCP tools, provisions sandbox execution, records observable events, and returns the structured proof contract that drives Byter's UI.

The public [issue #32 run](https://byter-production-1024.up.railway.app/runs/github-MAYANK-MAHAUR-Byter-32-8fd16ca98fd2) is real: 57 persisted events, 11 repository-tool events, 22 sandbox events, a 3/3 reproduction, a passing candidate patch, and regression proof. It is intentionally paused at `awaiting-approval`.

| Observable harness trace | Review before repository writes |
| --- | --- |
| ![GitHub MCP and Daytona activity](docs/images/byter-harness-trace.png) | ![Candidate patch and approval gate](docs/images/byter-review-gate.png) |

Byter shows what the agent did, what evidence it produced, and what it is waiting for. It does not expose private chain-of-thought, credentials, internal provider IDs, or raw infrastructure paths.

## Safety Boundary

- Signed webhook intake and prompt-injection scanning.
- Scoped GitHub tools and bounded sandbox output.
- Secret, path, and provider-detail redaction before public persistence.
- Repeated failure proof plus after-patch and regression validation.
- Maintainer approval before the first GitHub write; approved changes open as a draft PR.

## Qodo Code Review Evidence

Qodo reviewed the project through focused pull requests while it was being built. We fixed valid findings and requested follow-up reviews instead of treating review as a final badge.

- [PR #14](https://github.com/MAYANK-MAHAUR/Byter/pull/14): merged TrueForge webhook integration reviewed by Qodo.
- [PR #23](https://github.com/MAYANK-MAHAUR/Byter/pull/23): merged harness UI and release-hardening work.
- [Detailed Qodo review](https://github.com/MAYANK-MAHAUR/Byter/pull/23#issuecomment-5462238474) and [follow-up confirmation](https://github.com/MAYANK-MAHAUR/Byter/pull/23#issuecomment-5468354710).

Qodo found real correctness and security issues: repeat-trigger labels, secret and filesystem-path leakage, unsafe host-derived links, duplicate persistence, unstable run IDs, and oversized polling records. The fixes added public-data normalization, trusted base URLs, stable event identity, redaction, deduplicated writes, and regression tests. The follow-up review confirmed that no active findings remained.

## Run Locally

Prerequisites: Node.js 22+ and pnpm 10+.

```powershell
pnpm install
pnpm verify
pnpm build
```

Start the API in one terminal:

```powershell
$env:PORT="8787"
$env:DATA_DIR=".data-local"
pnpm --filter @byter/server start
```

Start the dashboard in another terminal:

```powershell
$env:BYTER_API_TARGET="http://127.0.0.1:8787"
$env:VITE_BYTER_DATA_MODE="demo"
pnpm dev
```

Open `http://127.0.0.1:5173`. Demo mode is explicit and local; production runs use the integrations listed in [`.env.example`](.env.example).

## Project Map

```text
apps/server          webhooks, persistence, approvals, and public API
apps/web             live harness and evidence dashboard
apps/github-mcp      scoped repository tools and approved writes
packages/agent       TrueForge runtime and structured proof contract
packages/repro-engine reproduction and patch validation
```

Built for the [TrueForge Agent Harness Hackathon](https://www.wemakedevs.org/hackathons/trueforge).
