# Project State

## Working

- [x] pnpm workspace with Node.js/TypeScript packages.
- [x] Deterministic `demo/buggy-parser` fixture.
- [x] Shared run state machine and security scanner.
- [x] GitHub webhook, app auth, client, and MCP-style tool boundary tests.
- [x] TrueForge runtime adapter contract and startup failure handling.
- [x] Reproduction runner, fingerprinting, verifier, minimizer, and patch validator.
- [x] Vite dashboard console with run timeline, evidence, approval, and security views.

## In Progress

- [ ] Real TrueForge server/session execution proof.
- [ ] Real GitHub MCP invocation from an agent session.
- [ ] Real Daytona-backed sandbox execution.
- [ ] End-to-end issue-to-draft-PR demo.
- [ ] Live dashboard API and persisted run/event storage.

## Blocked

- [ ] GitHub App credentials are not configured locally.
- [ ] TrueForge URL/API key are placeholders.
- [ ] Daytona API key is not configured locally.
- [ ] Qodo is active on PRs but posted a trial-expiring notice.

## Last Verified

2026-08-28

Commands run against `origin/main` in clean worktree `D:\keen-hertz-origin-main`:

- `pnpm install --frozen-lockfile`
- `pnpm lint`
- `pnpm typecheck`
- `pnpm test`
- `pnpm build`
- `git grep -n "BEGIN.*PRIVATE KEY\|github_pat_\|ghp_\|sk-" HEAD -- . ':!pnpm-lock.yaml' ':!package-lock.json'`

Result:

- Install, lint, typecheck, test, and build passed.
- Secret pattern scan found no tracked matches.

Commit:

- `f581851` (`origin/main`) before this status update.
