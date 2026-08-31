# Byter

**CI for bug reports.** Byter turns a GitHub issue into executable proof, a tested candidate fix, and a human-controlled draft pull request.

[Live app](https://byter-production-1024.up.railway.app/) · [Verified run](https://byter-production-1024.up.railway.app/runs/github-MAYANK-MAHAUR-Byter-32-8fd16ca98fd2) · [Source issue](https://github.com/MAYANK-MAHAUR/Byter/issues/32) · [Local setup guide](Local.md)

![Byter showing a live TrueForge investigation](docs/images/byter-live-overview.png)

## Run Locally

Prerequisites: Node.js `20.19.0+` or `22.12.0+`, and pnpm `10.0.0+`. See [Local.md](Local.md) for credentials, TrueForge, GitHub App, webhook, and production setup.

```bash
# Install and verify the complete workspace
pnpm install
pnpm verify

# Terminal 1: API, webhooks, persistence, and approvals
PORT=8787 DATA_DIR=.data-local pnpm --filter @byter/server start

# Terminal 2: dashboard
BYTER_API_TARGET=http://127.0.0.1:8787 pnpm dev
```

Open `http://127.0.0.1:5173`.

## Why Byter

Large repositories receive more bug reports than maintainers can manually reproduce. Byter gives each report the same evidence-first path:

1. Scan the issue as untrusted input.
2. Read scoped repository context through GitHub MCP.
3. Reproduce the failure repeatedly in a disposable Daytona sandbox.
4. Generate a minimal patch and run before, after, and regression checks.
5. Pause before any branch, commit, or pull request is created.
6. Continue only when a maintainer approves on the dashboard or replies `approve` on GitHub.

## TrueForge In The Loop

TrueForge is the durable harness behind every live run. It starts the model turn, connects the GitHub MCP tools, provisions sandbox execution, records observable events, returns the structured proof contract that drives Byter's UI, and pauses `create_fix_pull_request` through its native tool-approval event before any repository mutation. Byter has no alternate local runner or fixture-data API.

The public [issue #32 run](https://byter-production-1024.up.railway.app/runs/github-MAYANK-MAHAUR-Byter-32-8fd16ca98fd2) is real: 57 persisted events, 11 repository-tool events, 22 sandbox events, a 3/3 reproduction, a passing candidate patch, and regression proof. It is intentionally paused at `awaiting-approval`.

| Observable harness trace | Review before repository writes |
| :--- | :--- |
| ![GitHub MCP and Daytona activity](docs/images/byter-harness-trace.png) | ![Candidate patch and approval gate](docs/images/byter-review-gate.png) |

Byter shows what the agent did, what evidence it produced, and what it is waiting for. It does not expose private chain-of-thought, credentials, internal provider IDs, or raw infrastructure paths.

## Safety Boundary

- Signed webhook intake and prompt-injection scanning.
- Scoped GitHub tools and bounded sandbox output.
- Secret, path, and provider-detail redaction before public persistence.
- Repeated failure proof plus after-patch and regression validation.
- TrueForge-native maintainer approval before branch, commit, or pull-request creation; approval resumes the exact pending MCP tool call and opens a draft PR.

## Qodo Code Review Evidence

Qodo reviewed the substantive pull requests during the build. The compact trail below keeps the required public evidence readable.

| Pull request | What Qodo found | Decision and outcome |
| :--- | :--- | :--- |
| [#23: Live TrueForge harness visibility](https://github.com/MAYANK-MAHAUR/Byter/pull/23) | Trigger loops, secret and path leakage, host-header poisoning, duplicate persistence, and trace identity issues. [Detailed review](https://github.com/MAYANK-MAHAUR/Byter/pull/23#issuecomment-5462238474) | Fixed the valid findings with redaction, trusted URLs, bounded persistence, event identity, and regression tests. The [follow-up review](https://github.com/MAYANK-MAHAUR/Byter/pull/23#issuecomment-5468354710) confirmed: **No active findings remain.** |
| [#36: TrueForge-only approval flow](https://github.com/MAYANK-MAHAUR/Byter/pull/36) | The production write tool was hidden, approval retries could replay a write, and recovery used the wrong turn ID. [Detailed review](https://github.com/MAYANK-MAHAUR/Byter/pull/36#issuecomment-5473965220) | Fixed all three, added approval and recovery regression coverage, and recorded the [engineering resolution](https://github.com/MAYANK-MAHAUR/Byter/pull/36#issuecomment-5476630528). Full verification passed with 80 tests. |

<details>
<summary><strong>Qodo commands used during the build</strong></summary>

The current Qodo v2 review trigger is [`/agentic_review`](https://docs.qodo.ai/qodo-documentation/code-review/get-started/configuration-overview/configuration-file). Earlier PRs also used conversational and Qodo v1 forms, which remain visible in the public history.

| Command or comment | How it was used |
| :--- | :--- |
| `qodo review` | Requested initial or follow-up review on PRs #8, #12, #13, #14, #16-#19, #23, #30, and #31. PR #23 returned the final no-active-findings confirmation. |
| `qodo, please re-check the current head <sha>` | Asked Qodo to verify fixes against an exact commit on [PR #8](https://github.com/MAYANK-MAHAUR/Byter/pull/8#issuecomment-5448798310). |
| `qodo dismiss finding 1 and finding 2` | Closed findings on [PR #8](https://github.com/MAYANK-MAHAUR/Byter/pull/8#issuecomment-5448810138) only after Qodo rechecked and confirmed both code fixes. |
| `@qodo-ai review` | Mention-style review trigger used on PRs #34 and #36. |
| `@qodo-ai all findings are fixed dismiss all` | Requested bulk dismissal on PR #13 after fixes were applied. |
| `qodo, fix both` | Attempted a batch fix on PR #36; Qodo reported that batch fixing was unavailable in that deployment. |
| `/fix` | Asked Qodo to prepare fixes for PR #36. It created [fix PR #37](https://github.com/MAYANK-MAHAUR/Byter/pull/37), which was reviewed rather than merged blindly. |
| `/review` | Qodo v1 slash-command review trigger attempted during the final review cycle. |
| `/agentic_review` | Current Qodo v2 and hackathon review command used for the final review attempt on PR #36. |

</details>

## Project Map

```text
apps/server          webhooks, persistence, approvals, and public API
apps/web             live harness and evidence dashboard
apps/github-mcp      scoped repository tools and approved writes
packages/agent       TrueForge runtime and structured proof contract
packages/core        run state machine and issue security scanning
packages/github      signed webhooks, GitHub App auth, and REST client
```

Built for the [TrueForge Agent Harness Hackathon](https://www.wemakedevs.org/hackathons/trueforge).

## AI Usage Disclosure

OpenAI Codex and other AI coding assistants supported implementation, testing, and documentation. The maintainer reviewed the resulting changes, and substantive pull requests were reviewed with Qodo before merge.
