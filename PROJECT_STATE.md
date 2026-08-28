# Project State

## Working

- [x] pnpm workspace with Node.js/TypeScript packages.
- [x] Deterministic `demo/buggy-parser` fixture.
- [x] Shared run state machine and security scanner.
- [x] GitHub webhook, app auth, client, and MCP-style tool boundary tests.
- [x] TrueForge runtime adapter contract and startup failure handling.
- [x] Reproduction runner, fingerprinting, verifier, minimizer, and patch validator.
- [x] Vite dashboard console with run timeline, evidence, approval, and security views.
- [x] Pull-request CI workflow added.
- [x] Cross-platform stack file URL normalization verified for reproduction fingerprints.

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

Commands run against `docs/status-and-ci` in clean worktree `D:\keen-hertz-origin-main`:

- `pnpm install --frozen-lockfile`
- `pnpm lint`
- `pnpm typecheck`
- `pnpm test`
- `pnpm build`
- `pnpm --filter @reprosmith/repro-engine test`
- Tracked secret pattern scan for private keys, GitHub tokens, and model API keys.

Result:

- Install, lint, typecheck, test, package-level reproduction-engine tests, and build passed locally.
- Secret pattern scan found no tracked matches.
- GitHub Actions initially exposed a Linux-only stack path normalization failure on PR #7; the branch now includes a fix and regression test.

Commit:

- `f581851` (`origin/main`) before this status update.
